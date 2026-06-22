/**
 * Engine wiring (P1-T8) — assembles the full conversational stack:
 *
 *   TelegramGateway → UpdateRouter → Executor(NodeRegistry, SqliteExecutionStore)
 *                                      └─ services: tg (per-bot TgSender),
 *                                         kv (kv_store table), http (fetch),
 *                                         log → exec_logs table
 *
 * `core` stays free of Telegram/Fastify/DB (invariant I3) — every side effect
 * is injected from here, the composition root at the server edge.
 */
import { Executor, NodeRegistry, type CodeRunner, type ExecutorServices, type StepLogEntry } from '@ctb/core';
import { registerBuiltinNodes, SUBFLOW_RETURN_VAR } from '@ctb/nodes';
import { getDefaultSandboxPool, type SandboxPool } from '@ctb/sandbox';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import {
  credentialAuthHeaders,
  readBotAiBudget,
  type AiChatMessage,
  type AiChatRequest,
  type AiChatResult,
  type AiSpeechRequest,
  type AiSpeechResult,
  type AiToolCall,
  type AiTranscribeRequest,
  type AiTranscribeResult,
  type CollectionFilter,
  type CredentialData,
  type FlowItem,
  type McpCallToolRequest,
  type McpListToolsRequest,
  type McpTool,
  type McpToolCallResult,
  type NodeCtx,
  type RecordFilter,
} from '@ctb/shared';
import { and, eq } from 'drizzle-orm';
import type { Db } from '../db/index';
import { bots as botsTable, credentials as credentialsTable, execLogs, kvStore } from '../db/schema';
import { SqliteAiUsageStore } from './ai-usage-store';
import { SqliteApiAuditStore } from './audit-store';
import { RateLimiter } from '../lib/rate-limiter';
import { decrypt, deriveKey } from '../lib/crypto';
import type BetterSqlite3 from 'better-sqlite3';
import { TelegramGateway } from '../telegram/gateway';
import { SqliteCollectionStore } from '../collections/store';
import { SqliteFileStore } from '../collections/file-store';
import { SqliteFlowSource } from './flow-source';
import { SqlitePendingTriggerStore } from './pending-store';
import { RecordEventBus } from './record-events';
import { UpdateRouter } from './router';
import { SqliteExecutionStore } from './sqlite-store';
import { SqliteUserStore } from './user-store';
import { Scheduler } from '../triggers/schedule';
import {
  CallSessionService,
  makeVoiceCredentialResolver,
  type CallCaps,
} from '../triggers/call-session';
import { CallEventBus } from '../triggers/call-events';
import { LoopbackVoiceConnector } from './loopback-connector';
import type { VoiceConnector } from './voice-connector';
import { WebhookDispatcher } from './webhook-dispatcher';

export interface WireOptions {
  db: Db;
  /**
   * Raw better-sqlite3 handle (P3.5-T5) — the Collections store needs it for the
   * json_extract filter queries + computed-index DDL Drizzle can't express. When
   * provided, the engine owns the collection store, exposes it on `Engine` (so
   * the records API shares the SAME instance), wires the `data.collection`
   * capability and the record-write event bus. Omitted ⇒ ctx.collections is null.
   */
  sqlite?: BetterSqlite3.Database;
  ctbSecret: string;
  log?: (level: 'debug' | 'info' | 'warn' | 'error', message: string, data?: unknown) => void;
  clock?: () => Date;
  /** Outbound HTTP cap for nodes — injectable for tests. */
  fetchImpl?: typeof fetch;
  /** Sandbox pool override (tests share/destroy their own). */
  sandboxPool?: SandboxPool;
  /**
   * $http allow-list for the Code node (ARCH §11): when non-empty, only URLs
   * whose host matches an entry (exact or `.suffix` subdomain) are allowed.
   * Empty/undefined ⇒ unrestricted (single-admin v1 default).
   */
  codeHttpAllowList?: string[];
  /**
   * Recursion-depth cap for flow.executeSubFlow (P3-T1). A top-level run is
   * depth 0; each nested sub-flow is one deeper. A child started at this depth
   * is refused — a guard against runaway mutual recursion (A calls B calls A…).
   */
  maxSubFlowDepth?: number;
  /**
   * Data directory for the file store (PA-T1) — backs `ctx.files.read` so
   * `tg.sendMedia` (`source:'file'`) can upload the bytes of a Collection/file
   * id. Defaults to `'data'` (matching `CTB_DATA_DIR`). The records/files REST
   * APIs construct their own store over the same `dataDir`, so the on-disk
   * bytes are shared.
   */
  dataDir?: string;
  /**
   * Postgres pool factory for the `db.postgres` capability (PB-T2) — injectable
   * so tests provide a fake (no socket). Omitted ⇒ the real `pg`-backed factory.
   */
  dbPoolFactory?: DbPoolFactory;
  /**
   * MySQL pool factory for the `db.mysql` capability (PB-T3) — injectable so
   * tests provide a fake (no socket). Omitted ⇒ the real `mysql2`-backed factory.
   */
  mysqlPoolFactory?: MysqlPoolFactory;
  /**
   * Live-voice media adapter for the Call Session Service (PE-T2). Injectable so
   * tests use a deterministic loopback and a host swaps in the userbot MTProto
   * engine with zero node/flow change (PLAN2 §E.1, invariant I3). Omitted ⇒ the
   * dependency-free {@link LoopbackVoiceConnector} default.
   */
  voiceConnector?: VoiceConnector;
  /**
   * Hard caps for live calls (PE-T2, PLAN2 §E.1) — max concurrent calls (host
   * + per-bot) and max call duration. Safe defaults applied per-field when omitted.
   */
  callCaps?: Partial<CallCaps>;
  /**
   * Per-expression evaluation budget in ms, forwarded to
   * `ExecutorServices.evalOptions.budgetMs` (the existing host tuning seam).
   * Each `{{ }}` is evaluated in a sandbox worker with a hard time budget
   * (default 50ms — strict by design). On a heavily-loaded host the worker's
   * COLD START alone can exceed 50ms and error an otherwise-correct flow
   * (`expression exceeded 50ms budget`), so deployments on slow/contended
   * machines (and the CI sandbox) can raise it here. Omitted ⇒ the strict
   * 50ms default.
   */
  expressionBudgetMs?: number;
}

/** Default sub-flow recursion-depth cap (PLAN.md P3-T1 "recursion depth cap"). */
const DEFAULT_MAX_SUBFLOW_DEPTH = 8;

export interface Engine {
  gateway: TelegramGateway;
  router: UpdateRouter;
  executor: Executor;
  store: SqliteExecutionStore;
  registry: NodeRegistry;
  flowSource: SqliteFlowSource;
  /** Per-bot end-user store (P3-T5) — also backs the Users REST API. */
  userStore: SqliteUserStore;
  /**
   * Collections data layer (P3.5-T5) — present only when `sqlite` was passed.
   * The records/collections REST APIs reuse THIS instance so panel writes and
   * `data.collection` writes share one store + one event bus.
   */
  collectionStore?: SqliteCollectionStore;
  /** Record-write event bus (P3.5-T5) — present only when `sqlite` was passed. */
  recordEventBus?: RecordEventBus;
  /**
   * Cron scheduler (P4-T2) — runs `schedule.trigger` nodes of active flows.
   * Always present; `start()`/`stop()` are driven by the server lifecycle and
   * `reconcile()` is re-run whenever a flow is activated/deactivated/edited.
   */
  scheduler: Scheduler;
  /**
   * Live-voice Call Session Service (PE-T2) — the long-lived host runtime that
   * owns every realtime Telegram call (a sibling to the scheduler). Always
   * present; backs the `ctx.call` capability. The server lifecycle calls
   * `stop()` at shutdown to leave any open calls; PE-T3's `trigger.callEvent`
   * subscribes via `onUtterance`.
   */
  callSessionService: CallSessionService;
  /**
   * Live-voice call-event bus (PE-T3) — subscribes to the Call Session Service's
   * utterance + lifecycle streams and fires `trigger.callEvent` flows. Always
   * present; the server lifecycle calls `start()` after boot and `stop()` at
   * shutdown.
   */
  callEventBus: CallEventBus;
  /**
   * Outbound instance-webhook dispatcher (P4-T4). Always present; fires
   * `execution.finished`/`execution.failed` (from the execution store) and
   * `user.first_seen` (from the user store) to subscribed `instance_webhooks`.
   */
  webhookDispatcher: WebhookDispatcher;
  /**
   * File store (PA-T1) — backs `ctx.files.read` for `tg.sendMedia`. Always
   * present; reads local-disk bytes for a CTB file id.
   */
  fileStore: SqliteFileStore;
  /**
   * AI spend ledger (PD-T2) — backs per-bot daily budget enforcement (read by
   * the per-run `ctx.ai.chat` wrapper) and the panel's AI-usage view. The bots
   * AI-usage / AI-budget REST endpoints reuse THIS instance.
   */
  aiUsageStore: SqliteAiUsageStore;
  /**
   * Per-token rate limiter (PD-T3) — a process-local sliding window the v1
   * bearer-auth preHandler checks against each token's `rateLimitPerMin`. One
   * instance for the process lifetime (the right scope for CTB's single-process
   * architecture); a restart resets the windows (acceptable for an abuse guard).
   */
  rateLimiter: RateLimiter;
  /**
   * Append-only API audit log (PD-T3) — the host's record of every authoring /
   * trigger / send call on `/api/v1/*` (who, what, target, status). The v1
   * `onResponse` hook writes rows; the panel reads them. Host owns the table (I6).
   */
  auditStore: SqliteApiAuditStore;
  /**
   * Drain the `db.postgres` connection pools (PB-T2). Always present; the server
   * lifecycle calls it at shutdown so open Postgres sockets are closed cleanly.
   */
  closeDbPools: () => Promise<void>;
}

/**
 * File-store capability (PA-T1 read + PA-T2 write). The node passes a CTB file
 * id to `read` (the host returns the disk bytes so `tg.sendMedia` can upload a
 * Collection/file-store file), or raw bytes to `write` (the host stores them on
 * disk and returns a CTB file id so `tg.getFile` can hand a stored file to
 * downstream nodes). Invariant I6 — the node never touches disk. A per-bot
 * factory (DL #15): `read` ignores the bot (file ids are globally unique) but
 * `write` stamps the run's `botId` so stored files are owned by the right bot.
 */
function makeFiles(
  fileStore: SqliteFileStore,
  botId: string,
): NonNullable<NodeCtx['files']> {
  return {
    async read(fileId) {
      const { bytes, mime } = fileStore.readLocal(fileId);
      return { bytes, mime };
    },
    async write(bytes, mime) {
      const pub = fileStore.putLocal(botId, Buffer.from(bytes), mime);
      return { id: pub.id, mime: pub.mime, size: pub.size, url: pub.url };
    },
  };
}

/** DB-backed kv capability. Scope ids: user→tg user (set per-ctx later), flow→flowId, bot→''. */
function makeKv(db: Db, botId: string, clock: () => Date): NodeCtx['kv'] {
  // v1: scope_id is '' for all scopes except where the node provides one —
  // per-user scoping is finalized with data.kv (P2-T6). Bot-level works now.
  const where = (scope: 'user' | 'bot' | 'flow', key: string) =>
    and(
      eq(kvStore.botId, botId),
      eq(kvStore.scope, scope),
      eq(kvStore.scopeId, ''),
      eq(kvStore.key, key),
    );
  return {
    async get(scope, key) {
      const row = db.select().from(kvStore).where(where(scope, key)).get();
      return row?.value ?? undefined;
    },
    async set(scope, key, value) {
      const now = clock().toISOString();
      db.insert(kvStore)
        .values({ botId, scope, scopeId: '', key, value, updatedAt: now })
        .onConflictDoUpdate({
          target: [kvStore.botId, kvStore.scope, kvStore.scopeId, kvStore.key],
          set: { value, updatedAt: now },
        })
        .run();
    },
    async delete(scope, key) {
      db.delete(kvStore).where(where(scope, key)).run();
    },
  };
}

/**
 * Stored-credential resolver (P3-T4). Reads the encrypted row, decrypts it
 * HERE (the host owns the key), and returns ONLY the auth headers it injects —
 * the secret never crosses into node code (invariant I7). Returns null when the
 * credential is missing or undecryptable, so the node fails with a clear error.
 */
function makeCredentials(db: Db, key: Buffer): NonNullable<NodeCtx['credentials']> {
  return {
    async authHeaders(credentialId) {
      const row = db
        .select()
        .from(credentialsTable)
        .where(eq(credentialsTable.id, credentialId))
        .get();
      if (!row) return null;
      try {
        const data = JSON.parse(decrypt(row.dataEnc, key)) as CredentialData;
        return credentialAuthHeaders(data);
      } catch {
        return null;
      }
    },
  };
}

/**
 * LLM chat capability for ai.llmChat (P5-T1). The node passes a credentialId;
 * the host decrypts the openAiApi credential (base_url + key), POSTs the
 * OpenAI-compatible `/chat/completions` request and returns the reply + usage.
 * The decrypted key never crosses into node code (invariants I6/I7). Throws on
 * a missing/wrong-type credential or a transport/API error so the node fails
 * loudly. The `fetchImpl` is injectable so tests run with no network.
 */
/**
 * Per-run AI capability factory (PD-T2 — agent cost governance). The host binds
 * the LLM capability to a single run (botId + flowId + executionId) so it can:
 *
 *   • ENFORCE that bot's daily AI budget BEFORE each `chat` — fail-closed: if
 *     the bot has already hit `maxCallsPerDay` or `maxTokensPerDay` (read from
 *     `bots.settings.aiBudget`), the call is refused with a clear error and no
 *     provider request is made. `0` = unlimited.
 *   • METER the reported usage AFTER each successful `chat` — one `ai_usage` row
 *     per call, attributed to the run's bot/flow/execution + credential + model.
 *
 * `transcribe`/`speech` are not budgeted (no token usage is reported) — they're
 * passed through unchanged. The decrypted key stays host-side (invariants I6/I7);
 * nodes still see the same flat `ctx.ai` object, with the run context captured in
 * this closure and never exposed to node code.
 */
function makeAiFactory(
  db: Db,
  key: Buffer,
  fetchImpl: typeof fetch,
  usage: SqliteAiUsageStore,
): (botId: string, flowId: string, executionId: string) => NonNullable<NodeCtx['ai']> {
  /**
   * Resolve a stored openAiApi credential to its base URL + key (shared by chat,
   * transcribe and speech). Throws on a missing / undecryptable / wrong-type
   * credential so the calling node fails loudly. The decrypted key stays here
   * (host-side) and never crosses into node code (invariants I6/I7).
   */
  function resolveOpenAi(credentialId: string): { baseUrl: string; apiKey: string } {
    const row = db
      .select()
      .from(credentialsTable)
      .where(eq(credentialsTable.id, credentialId))
      .get();
    if (!row) throw new Error(`credential "${credentialId}" not found`);
    let data: CredentialData;
    try {
      data = JSON.parse(decrypt(row.dataEnc, key)) as CredentialData;
    } catch {
      throw new Error(`credential "${credentialId}" could not be decrypted`);
    }
    if (data.type !== 'openAiApi') {
      throw new Error(`credential "${credentialId}" is not an OpenAI-compatible API credential`);
    }
    return { baseUrl: data.baseUrl.replace(/\/+$/, ''), apiKey: data.apiKey };
  }

  /** The raw provider chat call (no budget enforcement / metering). */
  async function rawChat(req: AiChatRequest): Promise<AiChatResult> {
      const data = resolveOpenAi(req.credentialId);
      const url = `${data.baseUrl}/chat/completions`;
      const payload: Record<string, unknown> = {
        model: req.model,
        // Translate CTB messages into the OpenAI wire shape (tool calls/results
        // use OpenAI's `tool_calls` / `tool_call_id` field names).
        messages: req.messages.map(toWireMessage),
      };
      if (req.temperature !== undefined) payload.temperature = req.temperature;
      if (req.maxTokens !== undefined) payload.max_tokens = req.maxTokens;
      // Tools (ai.agent, P5-T4): expose each spec as an OpenAI function tool.
      if (req.tools && req.tools.length > 0) {
        payload.tools = req.tools.map((t) => ({
          type: 'function',
          function: {
            name: t.name,
            ...(t.description !== undefined ? { description: t.description } : {}),
            parameters: t.parameters ?? { type: 'object', additionalProperties: true },
          },
        }));
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 60_000);
      let res: Response;
      try {
        res = await fetchImpl(url, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${data.apiKey}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify(payload),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }

      const text = await res.text();
      if (res.status < 200 || res.status >= 300) {
        throw new Error(`LLM provider returned HTTP ${res.status}: ${text.slice(0, 500)}`);
      }
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        throw new Error('LLM provider returned a non-JSON response');
      }
      return parseChatCompletion(body);
  }

  // ── Speech-to-Text (ai.speechToText, PB-T7) ──────────────────────────────
  async function transcribe(req: AiTranscribeRequest): Promise<AiTranscribeResult> {
      const data = resolveOpenAi(req.credentialId);
      const url = `${data.baseUrl}/audio/transcriptions`;

      // OpenAI-compatible transcription is a multipart/form-data upload: the
      // audio part plus the model (+ optional language / prompt). We build a
      // standard FormData/Blob — undici/Node fetch sets the boundary header.
      const form = new FormData();
      const ab = req.audio.buffer.slice(
        req.audio.byteOffset,
        req.audio.byteOffset + req.audio.byteLength,
      ) as ArrayBuffer;
      const blob = new Blob([ab], req.mime ? { type: req.mime } : {});
      form.append('file', blob, req.filename);
      form.append('model', req.model);
      // Ask for a verbose JSON body so we can surface language + duration.
      form.append('response_format', 'verbose_json');
      if (req.language !== undefined && req.language !== '') form.append('language', req.language);
      if (req.prompt !== undefined && req.prompt !== '') form.append('prompt', req.prompt);

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 120_000);
      let res: Response;
      try {
        res = await fetchImpl(url, {
          method: 'POST',
          headers: { authorization: `Bearer ${data.apiKey}` },
          body: form,
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }

      const text = await res.text();
      if (res.status < 200 || res.status >= 300) {
        throw new Error(`speech provider returned HTTP ${res.status}: ${text.slice(0, 500)}`);
      }
      return parseTranscription(text);
  }

  // ── Text-to-Speech (ai.textToSpeech, PB-T7) ──────────────────────────────
  async function speech(req: AiSpeechRequest): Promise<AiSpeechResult> {
      const data = resolveOpenAi(req.credentialId);
      const url = `${data.baseUrl}/audio/speech`;
      const format = req.format ?? 'mp3';
      const payload: Record<string, unknown> = {
        model: req.model,
        input: req.input,
        voice: req.voice,
        response_format: format,
      };
      if (req.speed !== undefined) payload.speed = req.speed;

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 120_000);
      let res: Response;
      try {
        res = await fetchImpl(url, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${data.apiKey}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify(payload),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }

      if (res.status < 200 || res.status >= 300) {
        const errText = await res.text();
        throw new Error(`speech provider returned HTTP ${res.status}: ${errText.slice(0, 500)}`);
      }
      const buf = new Uint8Array(await res.arrayBuffer());
      return { audio: buf, mime: speechMime(format) };
  }

  /** Read a bot's AI budget from its `bots.settings.aiBudget` (defaults if unset). */
  function budgetFor(botId: string) {
    const row = db
      .select({ settings: botsTable.settings })
      .from(botsTable)
      .where(eq(botsTable.id, botId))
      .get();
    return readBotAiBudget((row?.settings ?? {}) as Record<string, unknown>);
  }

  // The per-run factory: bind chat to one run so it can cap + meter; transcribe
  // and speech pass through unchanged (no token usage to budget).
  return (botId: string, flowId: string, executionId: string): NonNullable<NodeCtx['ai']> => ({
    async chat(req: AiChatRequest): Promise<AiChatResult> {
      // ENFORCE (fail-closed, BEFORE the provider call): a 0 cap = unlimited.
      const budget = budgetFor(botId);
      if (budget.maxCallsPerDay > 0 || budget.maxTokensPerDay > 0) {
        const today = usage.todayTotals(botId);
        if (budget.maxCallsPerDay > 0 && today.calls >= budget.maxCallsPerDay) {
          throw new Error(
            `AI daily call budget exceeded for this bot (${today.calls}/${budget.maxCallsPerDay} calls today)`,
          );
        }
        if (budget.maxTokensPerDay > 0 && today.totalTokens >= budget.maxTokensPerDay) {
          throw new Error(
            `AI daily token budget exceeded for this bot (${today.totalTokens}/${budget.maxTokensPerDay} tokens today)`,
          );
        }
      }

      const result = await rawChat(req);

      // METER (AFTER a successful call): one row in the ai_usage ledger.
      try {
        usage.record({
          botId,
          flowId,
          executionId,
          credentialId: req.credentialId,
          model: result.model ?? req.model,
          promptTokens: result.usage?.promptTokens,
          completionTokens: result.usage?.completionTokens,
          totalTokens:
            result.usage?.totalTokens ??
            (result.usage?.promptTokens ?? 0) + (result.usage?.completionTokens ?? 0),
        });
      } catch {
        // Metering must never break a successful LLM call — swallow ledger errors.
      }
      return result;
    },
    transcribe,
    speech,
  });
}

/** Parse an OpenAI-compatible transcription response (verbose or plain JSON). */
function parseTranscription(text: string): AiTranscribeResult {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    // Some providers return raw text when `response_format` isn't JSON — treat
    // the whole body as the transcript.
    return { text: text.trim() };
  }
  const b = (body ?? {}) as { text?: unknown; language?: unknown; duration?: unknown };
  const result: AiTranscribeResult = { text: typeof b.text === 'string' ? b.text : '' };
  if (typeof b.language === 'string') result.language = b.language;
  if (typeof b.duration === 'number') result.duration = b.duration;
  return result;
}

/** Map an OpenAI speech `response_format` to a MIME type for the stored file. */
function speechMime(format: string): string {
  switch (format) {
    case 'opus':
      return 'audio/ogg';
    case 'aac':
      return 'audio/aac';
    case 'flac':
      return 'audio/flac';
    case 'wav':
      return 'audio/wav';
    case 'pcm':
      return 'audio/pcm';
    case 'mp3':
    default:
      return 'audio/mpeg';
  }
}

/**
 * Translate a CTB AiChatMessage into the OpenAI chat-completions wire shape.
 * Assistant tool-call turns become `{ role:'assistant', tool_calls:[…] }`;
 * tool results become `{ role:'tool', tool_call_id, content }`.
 */
function toWireMessage(m: AiChatMessage): Record<string, unknown> {
  const wire: Record<string, unknown> = { role: m.role, content: m.content };
  if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) {
    wire.tool_calls = m.toolCalls.map((c) => ({
      id: c.id,
      type: 'function',
      function: { name: c.name, arguments: c.argumentsJson },
    }));
  }
  if (m.role === 'tool' && m.toolCallId !== undefined) {
    wire.tool_call_id = m.toolCallId;
  }
  return wire;
}

/** Extract reply + usage + tool calls from an OpenAI-compatible response. */
function parseChatCompletion(body: unknown): AiChatResult {
  const b = (body ?? {}) as {
    choices?: {
      message?: {
        content?: unknown;
        tool_calls?: { id?: unknown; function?: { name?: unknown; arguments?: unknown } }[];
      };
    }[];
    usage?: { prompt_tokens?: unknown; completion_tokens?: unknown; total_tokens?: unknown };
    model?: unknown;
  };
  const message = b.choices?.[0]?.message;
  const content = message?.content;
  const reply = typeof content === 'string' ? content : '';
  const usage: AiChatResult['usage'] = {};
  if (typeof b.usage?.prompt_tokens === 'number') usage.promptTokens = b.usage.prompt_tokens;
  if (typeof b.usage?.completion_tokens === 'number') usage.completionTokens = b.usage.completion_tokens;
  if (typeof b.usage?.total_tokens === 'number') usage.totalTokens = b.usage.total_tokens;

  const toolCalls: AiToolCall[] = [];
  for (const tc of message?.tool_calls ?? []) {
    const name = tc?.function?.name;
    if (typeof name !== 'string' || name === '') continue;
    const args = tc?.function?.arguments;
    toolCalls.push({
      id: typeof tc.id === 'string' && tc.id !== '' ? tc.id : `call_${toolCalls.length}`,
      name,
      argumentsJson: typeof args === 'string' ? args : args === undefined ? '{}' : JSON.stringify(args),
    });
  }

  const result: AiChatResult = { reply, usage };
  if (typeof b.model === 'string') result.model = b.model;
  if (toolCalls.length > 0) result.toolCalls = toolCalls;
  return result;
}

/**
 * MCP client capability for ai.mcpClient (P5-T3). The node passes a credentialId;
 * the host decrypts the `mcpServer` credential (endpoint URL + optional key) and
 * performs the Model-Context-Protocol JSON-RPC calls (`tools/list`,
 * `tools/call`) over streamable-HTTP. The decrypted key never crosses into node
 * code (invariants I6/I7). Throws on a missing/wrong-type credential or a
 * transport/protocol/tool error so the node fails loudly. `fetchImpl` is
 * injectable so tests run with no network.
 */
function makeMcp(db: Db, key: Buffer, fetchImpl: typeof fetch): NonNullable<NodeCtx['mcp']> {
  function resolveServer(credentialId: string): { url: string; apiKey?: string } {
    const row = db
      .select()
      .from(credentialsTable)
      .where(eq(credentialsTable.id, credentialId))
      .get();
    if (!row) throw new Error(`credential "${credentialId}" not found`);
    let data: CredentialData;
    try {
      data = JSON.parse(decrypt(row.dataEnc, key)) as CredentialData;
    } catch {
      throw new Error(`credential "${credentialId}" could not be decrypted`);
    }
    if (data.type !== 'mcpServer') {
      throw new Error(`credential "${credentialId}" is not an MCP server credential`);
    }
    return data.apiKey !== undefined ? { url: data.url, apiKey: data.apiKey } : { url: data.url };
  }

  /** One JSON-RPC POST to the MCP endpoint; returns the `result` field. */
  async function rpc(server: { url: string; apiKey?: string }, method: string, params: unknown): Promise<unknown> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      // MCP streamable-HTTP servers may stream the response as SSE; accept both.
      accept: 'application/json, text/event-stream',
    };
    if (server.apiKey) headers.authorization = `Bearer ${server.apiKey}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60_000);
    let res: Response;
    try {
      res = await fetchImpl(server.url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method, params }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    const text = await res.text();
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`MCP server returned HTTP ${res.status}: ${text.slice(0, 500)}`);
    }
    const envelope = parseMcpEnvelope(text);
    if (envelope.error) {
      const e = envelope.error as { code?: unknown; message?: unknown };
      throw new Error(`MCP error ${String(e.code ?? '')}: ${String(e.message ?? 'unknown')}`.trim());
    }
    return envelope.result;
  }

  return {
    async listTools(req: McpListToolsRequest): Promise<McpTool[]> {
      const server = resolveServer(req.credentialId);
      const result = (await rpc(server, 'tools/list', {})) as { tools?: unknown };
      const tools = Array.isArray(result?.tools) ? result.tools : [];
      return tools
        .filter((t): t is Record<string, unknown> => typeof t === 'object' && t !== null)
        .map((t) => {
          const tool: McpTool = { name: String(t.name ?? '') };
          if (typeof t.description === 'string') tool.description = t.description;
          if (t.inputSchema && typeof t.inputSchema === 'object') {
            tool.inputSchema = t.inputSchema as Record<string, unknown>;
          }
          return tool;
        });
    },
    async callTool(req: McpCallToolRequest): Promise<McpToolCallResult> {
      const server = resolveServer(req.credentialId);
      const result = (await rpc(server, 'tools/call', {
        name: req.name,
        arguments: req.arguments,
      })) as { content?: unknown; isError?: unknown };
      const content = Array.isArray(result?.content) ? result.content : [];
      const text = content
        .filter(
          (c): c is { type?: string; text?: string } => typeof c === 'object' && c !== null,
        )
        .filter((c) => c.type === 'text' && typeof c.text === 'string')
        .map((c) => c.text)
        .join('\n');
      return { content, text, isError: result?.isError === true };
    },
  };
}

/**
 * Parse an MCP JSON-RPC response. Streamable-HTTP servers may answer with a
 * raw JSON body OR an SSE stream (`data: {…}` lines) — accept both. Returns the
 * `{ result?, error? }` envelope of the first/only JSON-RPC message.
 */
function parseMcpEnvelope(text: string): { result?: unknown; error?: unknown } {
  const trimmed = text.trim();
  if (trimmed === '') throw new Error('MCP server returned an empty response');
  // SSE framing: pick the last `data:` payload (the final JSON-RPC message).
  if (trimmed.startsWith('event:') || trimmed.startsWith('data:') || trimmed.includes('\ndata:')) {
    const dataLines = trimmed
      .split('\n')
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice('data:'.length).trim())
      .filter((l) => l !== '' && l !== '[DONE]');
    const last = dataLines[dataLines.length - 1];
    if (last === undefined) throw new Error('MCP SSE response carried no data');
    try {
      return JSON.parse(last) as { result?: unknown; error?: unknown };
    } catch {
      throw new Error('MCP SSE response carried non-JSON data');
    }
  }
  try {
    return JSON.parse(trimmed) as { result?: unknown; error?: unknown };
  } catch {
    throw new Error('MCP server returned a non-JSON response');
  }
}

/**
 * Minimal contract the `db.postgres` capability needs from a connection pool —
 * just `query(text, params)` returning `{ rows, rowCount }`. The real `pg.Pool`
 * satisfies this; tests inject a fake so they never open a socket (invariant
 * I3 keeps the driver here at the edge, never in core/nodes).
 */
export interface DbPool {
  query(
    sql: string,
    params: unknown[],
  ): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>;
  end(): Promise<void>;
  /** Effective read-only flag the pool was opened with (PD-T1) — host enforces writes. */
  readOnly?: boolean;
}

/** A resolved DB connection config (postgres OR mysql — same discrete fields). */
export interface DbPoolConfig {
  connectionString?: string;
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  password?: string;
  ssl: boolean;
  /** Max pooled connections (PD-T1 hardening). */
  poolMax: number;
  /** Per-statement timeout in ms (PD-T1); 0 = no timeout. */
  statementTimeoutMs: number;
  /** Open the connection read-only so the server refuses writes (PD-T1). */
  readOnly: boolean;
}

/** Factory that turns a resolved `postgres` credential into a pool. */
export type DbPoolFactory = (cfg: DbPoolConfig) => DbPool;

/** Factory that turns a resolved `mysql` credential into a pool (PB-T3). */
export type MysqlPoolFactory = (cfg: DbPoolConfig) => DbPool;

/**
 * SQL capability for `db.postgres` (PB-T2) and `db.mysql` (PB-T3). The HOST owns
 * the `pg` / `mysql2` connection pool (invariant I3 — the driver lives only
 * here); the node passes a `credentialId` + a dialect + a fully parameterized
 * statement and never sees the decrypted DSN (invariants I6/I7). One pool per
 * credentialId, lazily created and cached so repeated runs reuse connections;
 * `closeAll()` drains them at shutdown. The statement text + bound params come
 * straight from the node — we only execute, so SQL-injection safety lives in
 * the node (values are always bound, identifiers validated+quoted before they
 * reach the SQL text).
 *
 * The node's requested `dialect` (default `postgres`) MUST match the resolved
 * credential's type — so a flow can't aim a Postgres node at a MySQL credential
 * or vice versa. Both pool factories are injectable: production passes
 * `pg.Pool` / `mysql2` backed factories, tests pass fakes so `npm run verify`
 * opens no sockets.
 */
function makeDb(
  db: Db,
  key: Buffer,
  pgFactory: DbPoolFactory,
  mysqlFactory: MysqlPoolFactory,
): { capability: NonNullable<NodeCtx['db']>; closeAll: () => Promise<void> } {
  const pools = new Map<string, DbPool>();

  function resolvePool(credentialId: string, dialect: 'postgres' | 'mysql'): DbPool {
    const existing = pools.get(credentialId);
    if (existing) return existing;
    const row = db
      .select()
      .from(credentialsTable)
      .where(eq(credentialsTable.id, credentialId))
      .get();
    if (!row) throw new Error(`credential "${credentialId}" not found`);
    let data: CredentialData;
    try {
      data = JSON.parse(decrypt(row.dataEnc, key)) as CredentialData;
    } catch {
      throw new Error(`credential "${credentialId}" could not be decrypted`);
    }
    if (data.type !== dialect) {
      throw new Error(
        `credential "${credentialId}" is not a ${dialect === 'mysql' ? 'MySQL' : 'Postgres'} credential`,
      );
    }
    // PD-T1 hardening: pool size, statement timeout, and read-only all come from
    // the credential (defaults applied by the Zod schema). They are passed to the
    // factory so the real driver enforces them at the connection level.
    const cfg: DbPoolConfig = {
      ssl: data.ssl,
      poolMax: data.poolMax,
      statementTimeoutMs: data.statementTimeoutMs,
      readOnly: data.readOnly,
    };
    if (data.connectionString !== undefined) cfg.connectionString = data.connectionString;
    if (data.host !== undefined) cfg.host = data.host;
    if (data.port !== undefined) cfg.port = data.port;
    if (data.database !== undefined) cfg.database = data.database;
    if (data.user !== undefined) cfg.user = data.user;
    if (data.password !== undefined) cfg.password = data.password;
    const pool = dialect === 'mysql' ? mysqlFactory(cfg) : pgFactory(cfg);
    // Remember the read-only intent so the host can fail a write closed even when
    // the factory (e.g. a test fake) doesn't surface it (fail-closed default).
    if (pool.readOnly === undefined) pool.readOnly = cfg.readOnly;
    pools.set(credentialId, pool);
    return pool;
  }

  return {
    capability: {
      async query(req) {
        const dialect = req.dialect ?? 'postgres';
        const pool = resolvePool(req.credentialId, dialect);
        // Read-only enforcement (PD-T1): a missing `write` flag is treated as a
        // write (fail-closed), so a read-only credential refuses it before it
        // ever reaches the driver — defence in depth alongside the server-side
        // read-only session a read-only Postgres pool also opens.
        if (pool.readOnly && req.write !== false) {
          throw new Error('credential is read-only — write statements are not allowed');
        }
        const res = await pool.query(req.sql, req.params);
        return { rows: res.rows, rowCount: res.rowCount ?? res.rows.length };
      },
    },
    async closeAll() {
      const all = [...pools.values()];
      pools.clear();
      await Promise.allSettled(all.map((p) => p.end()));
    },
  };
}

/**
 * Default pool factory backed by the real `pg` driver. Imported lazily so the
 * driver is only loaded when a Postgres credential is actually used and so test
 * runs (which inject a fake factory) never touch it. `pg.Pool` already exposes
 * `query(text, params)` and `end()`, so it satisfies `DbPool` directly.
 */
function pgPoolFactory(cfg: DbPoolConfig): DbPool {
  // This is an ESM module (`type: module`), so bare `require` is absent at
  // runtime — build one off this module's URL. The `pg` driver is CJS; a
  // synchronous require keeps the factory non-async and is only reached when a
  // real Postgres credential is used (tests inject a fake factory instead).
  const require = createRequire(import.meta.url);
  const { Pool } = require('pg') as typeof import('pg');
  const opts: Record<string, unknown> = { ssl: cfg.ssl ? { rejectUnauthorized: false } : false };
  if (cfg.connectionString !== undefined) opts.connectionString = cfg.connectionString;
  if (cfg.host !== undefined) opts.host = cfg.host;
  if (cfg.port !== undefined) opts.port = cfg.port;
  if (cfg.database !== undefined) opts.database = cfg.database;
  if (cfg.user !== undefined) opts.user = cfg.user;
  if (cfg.password !== undefined) opts.password = cfg.password;
  // PD-T1 hardening, all enforced by the SERVER at the connection level:
  //  • max — cap concurrent connections,
  //  • statement_timeout — the server kills a runaway query,
  //  • default_transaction_read_only — the server refuses any write.
  opts.max = cfg.poolMax;
  const sessionOpts: string[] = [];
  if (cfg.statementTimeoutMs > 0) sessionOpts.push(`-c statement_timeout=${cfg.statementTimeoutMs}`);
  if (cfg.readOnly) sessionOpts.push('-c default_transaction_read_only=on');
  if (sessionOpts.length > 0) opts.options = sessionOpts.join(' ');
  const pool = new Pool(opts) as unknown as DbPool;
  pool.readOnly = cfg.readOnly;
  return pool;
}

/**
 * Default pool factory backed by the real `mysql2` driver (PB-T3). Lazily
 * required like `pgPoolFactory` so the driver only loads when a MySQL
 * credential is actually used. `mysql2`'s callback pool is wrapped in a thin
 * `DbPool` adapter: `pool.promise().query(sql, params)` returns
 * `[rows, fields]` where `rows` is either result rows (SELECT) or an OK packet
 * (write). We normalize: SELECT → the row array; a write → one synthetic row
 * `{ insertId?, affectedRows }` so the node's `rows`/`single` modes behave like
 * Postgres' `RETURNING` (which MySQL lacks).
 */
function mysqlPoolFactory(cfg: DbPoolConfig): DbPool {
  const require = createRequire(import.meta.url);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mysql = require('mysql2') as any;
  const opts: Record<string, unknown> = {};
  if (cfg.ssl) opts.ssl = { rejectUnauthorized: false };
  if (cfg.connectionString !== undefined) opts.uri = cfg.connectionString;
  if (cfg.host !== undefined) opts.host = cfg.host;
  if (cfg.port !== undefined) opts.port = cfg.port;
  if (cfg.database !== undefined) opts.database = cfg.database;
  if (cfg.user !== undefined) opts.user = cfg.user;
  if (cfg.password !== undefined) opts.password = cfg.password;
  // PD-T1: cap concurrent connections (mysql2's `connectionLimit`). MySQL has no
  // per-pool read-only DSN flag, so read-only is enforced host-side (makeDb
  // refuses write statements); the per-statement timeout is applied per query.
  opts.connectionLimit = cfg.poolMax;
  const timeoutMs = cfg.statementTimeoutMs;
  // `createPool` accepts a uri or discrete fields. The promise wrapper gives us
  // an async query() we can adapt to the DbPool contract.
  const rawPool =
    cfg.connectionString !== undefined
      ? mysql.createPool({ uri: cfg.connectionString, connectionLimit: cfg.poolMax })
      : mysql.createPool(opts);
  const pool = rawPool.promise();
  return {
    readOnly: cfg.readOnly,
    async query(sql: string, params: unknown[]) {
      // mysql2 supports a per-query timeout; the server aborts a slow statement.
      const [result] = await (timeoutMs > 0
        ? pool.query({ sql, timeout: timeoutMs }, params)
        : pool.query(sql, params));
      if (Array.isArray(result)) {
        // SELECT (or a query node returning rows): RowDataPacket[].
        return { rows: result as Record<string, unknown>[], rowCount: result.length };
      }
      // Write OK packet: { affectedRows, insertId, ... }. Surface a single row
      // so the node's `rows` mode emits something useful and `single` reports a
      // sensible rowCount.
      const ok = result as { affectedRows?: number; insertId?: number };
      const affected = ok.affectedRows ?? 0;
      const row: Record<string, unknown> = { affectedRows: affected };
      if (ok.insertId !== undefined && ok.insertId !== 0) row.insertId = ok.insertId;
      return { rows: [row], rowCount: affected };
    },
    async end() {
      await pool.end();
    },
  };
}

/** Host matches an allow-list entry (exact, or dot-prefixed suffix). */
export function hostAllowed(url: string, allowList: string[]): boolean {
  if (allowList.length === 0) return true;
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  return allowList.some((entry) => {
    const e = entry.toLowerCase();
    return e.startsWith('.') ? host === e.slice(1) || host.endsWith(e) : host === e;
  });
}

/**
 * Sandbox-backed runner for data.code (P2-T7, ARCH §8). Capabilities are
 * host-side proxies over the worker MessagePort — every limit (HTTP
 * allow-list, timeout/size caps, kv scoping) is enforced HERE, the realm
 * only sees method stubs (invariant I6).
 */
function makeCodeRunner(opts: {
  pool: SandboxPool;
  http: NodeCtx['http'];
  kv: (botId: string) => NodeCtx['kv'];
  allowList: string[];
}): CodeRunner {
  return async (source, scope, runOpts) => {
    const kv = opts.kv(runOpts.botId);
    const capabilities = {
      $http: {
        request: async (...args: unknown[]) => {
          const req = (args[0] ?? {}) as {
            method?: string; url?: string; headers?: Record<string, string>;
            body?: string | Record<string, unknown>; timeoutMs?: number;
          };
          if (typeof req.url !== 'string' || req.url === '') throw new Error('$http.request: url is required');
          if (!hostAllowed(req.url, opts.allowList)) {
            throw new Error(`$http: host of "${req.url}" is not in the allow-list`);
          }
          return opts.http.request({ method: req.method ?? 'GET', ...req, url: req.url });
        },
        get: async (...args: unknown[]) => {
          const url = args[0];
          if (typeof url !== 'string' || url === '') throw new Error('$http.get: url is required');
          if (!hostAllowed(url, opts.allowList)) {
            throw new Error(`$http: host of "${url}" is not in the allow-list`);
          }
          const extra = (args[1] ?? {}) as Record<string, unknown>;
          return opts.http.request({ method: 'GET', url, ...extra });
        },
      },
      $kv: {
        get: async (...args: unknown[]) => kv.get('user', String(args[0])),
        set: async (...args: unknown[]) => kv.set('user', String(args[0]), args[1]),
        delete: async (...args: unknown[]) => kv.delete('user', String(args[0])),
      },
    };
    return opts.pool.run(source, scope, {
      mode: 'script',
      capabilities,
      ...(runOpts.timeoutMs !== undefined ? { timeoutMs: runOpts.timeoutMs } : {}),
    });
  };
}

/** Host-limited HTTP capability (10s default timeout, 1MB response cap). */
function makeHttp(fetchImpl: typeof fetch): NodeCtx['http'] {
  return {
    async request(opts) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), Math.min(opts.timeoutMs ?? 10_000, 30_000));
      try {
        const init: RequestInit = { method: opts.method, signal: controller.signal };
        if (opts.headers) init.headers = opts.headers;
        if (opts.body !== undefined) {
          init.body = typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body);
        }
        const res = await fetchImpl(opts.url, init);
        const headers: Record<string, string> = {};
        res.headers.forEach((v, k) => {
          headers[k] = v;
        });
        const text = await res.text();
        const capped = text.length > 1_048_576 ? text.slice(0, 1_048_576) : text;
        let body: unknown = capped;
        try {
          body = JSON.parse(capped);
        } catch {
          /* keep text */
        }
        return { status: res.status, headers, body };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

export function wireEngine(opts: WireOptions): Engine {
  const clock = opts.clock ?? (() => new Date());
  const log = opts.log ?? (() => undefined);

  const registry = registerBuiltinNodes(new NodeRegistry());
  const store = new SqliteExecutionStore(opts.db, clock);
  const userStore = new SqliteUserStore(opts.db, clock);
  const gateway = new TelegramGateway({ ctbSecret: opts.ctbSecret });
  // Same key the credentials API uses — derived once, reused for every resolve.
  const credentialKey = deriveKey(opts.ctbSecret);

  // exec_logs sink — structured per-step logging (ARCH §4).
  const stepLogger = (entry: StepLogEntry): void => {
    try {
      opts.db
        .insert(execLogs)
        .values({
          executionId: entry.executionId,
          nodeId: entry.nodeId,
          level: entry.level,
          message: entry.message,
          // I/O snapshots from the executor (P2-T3.5) feed the editor's
          // node detail view; generic `data` rides output for plain rows.
          input: entry.input ?? null,
          output: entry.output ?? (entry.data !== undefined ? entry.data : null),
          error: entry.level === 'error' ? entry.message : null,
          durationMs: entry.durationMs ?? null,
          ts: entry.ts,
        })
        .run();
    } catch (err) {
      log('warn', `exec_logs write failed: ${err instanceof Error ? err.message : err}`);
    }
  };

  // Collections data layer (P3.5-T5) — only when the raw sqlite handle is given.
  const collectionStore = opts.sqlite
    ? new SqliteCollectionStore(opts.db, opts.sqlite, clock)
    : null;

  // File store (PA-T1) — backs ctx.files.read for tg.sendMedia (`source:'file'`).
  // Shares the on-disk bytes with the records/files REST APIs (same dataDir).
  const fileStore = new SqliteFileStore(opts.db, opts.dataDir ?? 'data', clock);

  // AI spend ledger (PD-T2) — backs per-bot budget enforcement (read by the
  // per-run `ctx.ai.chat` wrapper) and the panel's AI-usage view.
  const aiUsageStore = new SqliteAiUsageStore(opts.db, clock);

  // PD-T3 — public-API hardening. The rate limiter is a process-local sliding
  // window (single-process scope); the audit store appends one row per audited
  // `/api/v1/*` call. Both are wired into the v1 router by app.ts.
  const rateLimiter = new RateLimiter(() => clock().getTime());
  const auditStore = new SqliteApiAuditStore(opts.db, clock);

  // Live-voice Call Session Service (PE-T2) — the long-lived host runtime behind
  // `ctx.call`. It owns the realtime media connection (a node never holds a
  // socket — I4) and the per-call turn state. The media engine is a pluggable
  // VoiceConnector chosen by the `voiceConnection` credential (default: the
  // dependency-free loopback, so a host runs without MTProto — I3). Credential
  // decryption stays HERE (the host owns the key — I6/I7): the resolver reads +
  // decrypts the row and hands the service a fail-closed ResolvedVoiceConnection.
  const decryptVoiceCredential = (credentialId: string): CredentialData | null => {
    const row = opts.db
      .select()
      .from(credentialsTable)
      .where(eq(credentialsTable.id, credentialId))
      .get();
    if (!row) return null;
    try {
      return JSON.parse(decrypt(row.dataEnc, credentialKey)) as CredentialData;
    } catch {
      return null;
    }
  };
  const callSessionService = new CallSessionService({
    connector: opts.voiceConnector ?? new LoopbackVoiceConnector(),
    resolveCredential: makeVoiceCredentialResolver(decryptVoiceCredential),
    readFile: (fileId) => {
      const { bytes, mime } = fileStore.readLocal(fileId);
      return Promise.resolve({ bytes, mime });
    },
    ...(opts.callCaps ? { caps: opts.callCaps } : {}),
    log,
  });

  // One executor serves many bots — kv and tg resolve per-bot lazily (DL #15).
  const kvCache = new Map<string, NodeCtx['kv']>();
  // Forward refs: the subflow capability needs executor + flowSource, but those
  // are built FROM `services` — so the closure reads them lazily after wiring.
  let executorRef: Executor | null = null;
  let flowSourceRef: SqliteFlowSource | null = null;
  // The record-write event bus is built AFTER the router (it needs it), but the
  // `collections` capability closes over it lazily — same forward-ref pattern.
  let recordEventBusRef: RecordEventBus | null = null;
  const maxSubFlowDepth = opts.maxSubFlowDepth ?? DEFAULT_MAX_SUBFLOW_DEPTH;
  // SQL capability (db.postgres PB-T2 + db.mysql PB-T3). The host owns the
  // pool(s) keyed by credentialId; `closeAll` drains them at shutdown (exposed
  // as closeDbPools). One capability serves both dialects — the credential
  // type + the node's requested dialect pick the driver.
  const dbCapability = makeDb(
    opts.db,
    credentialKey,
    opts.dbPoolFactory ?? pgPoolFactory,
    opts.mysqlPoolFactory ?? mysqlPoolFactory,
  );
  const services: ExecutorServices = {
    // Forward the optional host expression-budget override (default stays the
    // strict 50ms when omitted — see WireOptions.expressionBudgetMs).
    ...(opts.expressionBudgetMs !== undefined
      ? { evalOptions: { budgetMs: opts.expressionBudgetMs } }
      : {}),
    kv: (botId) => {
      let kv = kvCache.get(botId);
      if (!kv) {
        kv = makeKv(opts.db, botId, clock);
        kvCache.set(botId, kv);
      }
      return kv;
    },
    http: makeHttp(opts.fetchImpl ?? fetch),
    credentials: makeCredentials(opts.db, credentialKey),
    code: makeCodeRunner({
      pool: opts.sandboxPool ?? getDefaultSandboxPool(),
      http: makeHttp(opts.fetchImpl ?? fetch),
      kv: (botId) => {
        let kv = kvCache.get(botId);
        if (!kv) {
          kv = makeKv(opts.db, botId, clock);
          kvCache.set(botId, kv);
        }
        return kv;
      },
      allowList: opts.codeHttpAllowList ?? [],
    }),
    tg: (botId, _chatId) => {
      const handle = gateway.get(botId);
      if (!handle) return null;
      return {
        sendMessage: (o) =>
          handle.sender.sendMessage(o as Parameters<typeof handle.sender.sendMessage>[0]),
        // tg.menu edit_in_place (P2-T6) + tg.editMessage (P3-T3) — all ride the
        // same rate-limited sender so node I/O never touches a raw token (I6).
        editMessageText: async (o) => {
          await handle.sender.call('editMessageText', o);
        },
        editMessageCaption: async (o) => {
          await handle.sender.call('editMessageCaption', o);
        },
        editMessageReplyMarkup: async (o) => {
          await handle.sender.call('editMessageReplyMarkup', o);
        },
        deleteMessage: async (o) => {
          await handle.sender.call('deleteMessage', o);
        },
        answerCallbackQuery: async (o) => {
          await handle.sender.call('answerCallbackQuery', o);
        },
        sendChatAction: async (o) => {
          await handle.sender.call('sendChatAction', o);
        },
        // tg.sendMedia (PA-T1) — single media or an album. The sender maps each
        // TgInputMedia to the right Bot-API call and uploads bytes as InputFile.
        sendMedia: (o) =>
          handle.sender.sendMedia(o as Parameters<typeof handle.sender.sendMedia>[0]),
        // tg.getFile (PA-T2) — resolve a file_id then DOWNLOAD its bytes. The
        // Bot-API `getFile` (rate-limited via the sender) returns the temporary
        // `file_path`; the bytes live at /file/bot<token>/<file_path>. Only the
        // host holds the token, so the node never sees it (invariants I3/I6).
        getFile: async (fileId) => {
          const file = await handle.sender.call<{
            file_path?: string;
            file_size?: number;
          }>('getFile', { file_id: fileId });
          if (!file.file_path) {
            throw new Error(`Telegram getFile returned no file_path for "${fileId}"`);
          }
          const url = `https://api.telegram.org/file/bot${handle.token}/${file.file_path}`;
          const res = await (opts.fetchImpl ?? fetch)(url);
          if (!res.ok) {
            throw new Error(
              `Telegram file download failed (${res.status} ${res.statusText}) for "${fileId}"`,
            );
          }
          const bytes = new Uint8Array(await res.arrayBuffer());
          const mime = res.headers.get('content-type');
          return {
            bytes,
            filePath: file.file_path,
            size: file.file_size ?? bytes.byteLength,
            mime: mime && mime.length > 0 ? mime : null,
          };
        },
      };
    },
    // File-store capability (PA-T1 read + PA-T2 write) — per-bot factory so
    // `write` (tg.getFile `store:true`) stamps the run's bot on stored files.
    files: (botId) => makeFiles(fileStore, botId),
    // Sub-flow runner (flow.executeSubFlow, P3-T1). Loads the child flow, runs a
    // nested executor synchronously to completion, and returns the items its
    // flow.return node parked in $vars. Enforces same-bot ownership and the
    // recursion-depth cap here (invariant I6 — the node never recurses itself).
    subflow: (parentBotId, depth) => ({
      run: async (flowId: string, items: FlowItem[]): Promise<{ items: FlowItem[] }> => {
        if (depth + 1 > maxSubFlowDepth) {
          throw new Error(`sub-flow recursion depth cap reached (${maxSubFlowDepth})`);
        }
        const src = flowSourceRef;
        const exec = executorRef;
        if (!src || !exec) throw new Error('sub-flow execution not wired');

        const child = await src.loadSubFlow(flowId);
        if (!child) throw new Error(`sub-flow "${flowId}" not found or has an invalid graph`);
        if (child.botId !== parentBotId) {
          throw new Error('sub-flow belongs to a different bot — cross-bot calls are not allowed');
        }

        // Entry = the child's trigger node (manual or tg.trigger); a trigger
        // passes the parent's items straight through on `main`.
        const entry = child.graph.nodes.find(
          (n) => !n.disabled && registry.get(n.type).category === 'trigger',
        );
        if (!entry) {
          throw new Error(`sub-flow "${child.name}" has no enabled trigger node to enter at`);
        }

        const childExecId = randomUUID();
        const result = await exec.start({
          executionId: childExecId,
          flow: { id: child.id, name: child.name },
          graph: child.graph,
          botId: child.botId,
          chatId: null,
          userId: null,
          entry: { nodeId: entry.id, items: { main: items } },
          depth: depth + 1,
        });

        if (result.status === 'error') {
          throw new Error(`sub-flow "${child.name}" failed: ${result.error ?? 'unknown error'}`);
        }
        if (result.status === 'waiting') {
          // wait-mode sub-flows must run straight through; a child that parks on
          // a wait (e.g. waitForReply) can't synchronously return items in v1.
          throw new Error(`sub-flow "${child.name}" paused on a wait — wait-mode sub-flows must run to completion without waiting`);
        }

        // Collect what flow.return parked; absent ⇒ child returned nothing.
        const finished = await store.load(childExecId);
        const returned = finished?.state.vars[SUBFLOW_RETURN_VAR];
        const out = Array.isArray(returned) ? (returned as FlowItem[]) : [];
        return { items: out };
      },
    }),
    // data.userProfile (P3-T5). Per-bot factory (DL #15); the executor passes
    // the run's own tg user id so the node can default to "the current user".
    // The host owns the table (invariant I6) — the node only sees this facade.
    users: (botId, defaultTgUserId) => {
      const resolve = (tgUserId?: number): number => {
        const id = tgUserId ?? defaultTgUserId;
        if (id === null || id === undefined) {
          throw new Error('no target user (this run has no chat user — pass an explicit `user`)');
        }
        return id;
      };
      return {
        async get(tgUserId) {
          return userStore.get(botId, resolve(tgUserId));
        },
        async setProfile(fields, o) {
          return userStore.setProfile(botId, resolve(o?.tgUserId), fields, o?.mode ?? 'merge');
        },
        async addTags(tags, tgUserId) {
          return userStore.addTags(botId, resolve(tgUserId), tags);
        },
        async removeTags(tags, tgUserId) {
          return userStore.removeTags(botId, resolve(tgUserId), tags);
        },
      };
    },
    // data.collection (P3.5-T5). Per-bot + per-flow factory: the flowId lets the
    // event bus stamp writes with their origin so the depth-1 loop guard works
    // (a flow's own writes don't re-trigger it). The node sees only this facade
    // — the host owns the schema, validation and the event bus (invariant I6).
    // Absent when no sqlite handle was wired → ctx.collections is null. Spread
    // conditionally so exactOptionalPropertyTypes never sees an explicit
    // `collections: undefined`.
    ...(collectionStore
      ? {
          collections: (botId: string, flowId: string): NonNullable<NodeCtx['collections']> => {
          const cs = collectionStore;
          /** Resolve a slug → collection id within THIS bot (throws if unknown). */
          const requireId = (slug: string): string => {
            const col = cs.getBySlug(botId, slug);
            if (!col) throw new Error(`collection not found: ${slug}`);
            return col.id;
          };
          /** Fire the bus after a write (flow source → origin loop guard). */
          const fire = async (
            collectionId: string,
            kind: 'created' | 'updated' | 'deleted',
            record: Record<string, unknown>,
            recordId: string,
            previous?: Record<string, unknown>,
          ): Promise<void> => {
            await recordEventBusRef?.emit({
              collectionId,
              kind,
              record,
              recordId,
              source: 'flow',
              originFlowId: flowId,
              ...(previous !== undefined ? { previous } : {}),
            });
          };
          // The capability's CollectionFilter types `op` loosely (string) since
          // it crosses the node boundary; the node only emits valid FilterOps,
          // and the store re-checks field paths. Narrow it for the store call.
          const toStoreFilter = (f: CollectionFilter): Partial<RecordFilter> =>
            f as unknown as Partial<RecordFilter>;
          return {
            async find(slug, filter) {
              const res = cs.find(requireId(slug), toStoreFilter(filter));
              return {
                records: res.records.map((r) => ({
                  id: r.id,
                  data: r.data,
                  createdAt: r.createdAt,
                  updatedAt: r.updatedAt,
                })),
                total: res.total,
              };
            },
            async get(slug, recordId) {
              const rec = cs.getRecord(recordId);
              const col = cs.getBySlug(botId, slug);
              if (!rec || !col || rec.collectionId !== col.id) return null;
              return { id: rec.id, data: rec.data, createdAt: rec.createdAt, updatedAt: rec.updatedAt };
            },
            async count(slug, filter) {
              return cs.count(requireId(slug), toStoreFilter(filter));
            },
            async insert(slug, data, options) {
              const id = requireId(slug);
              const rec = cs.insert(id, data, 'flow');
              if (!options?.suppressEvents) await fire(id, 'created', rec.data, rec.id);
              return { id: rec.id, data: rec.data, createdAt: rec.createdAt, updatedAt: rec.updatedAt };
            },
            async update(slug, recordId, patch, options) {
              const id = requireId(slug);
              const before = cs.getRecord(recordId);
              const rec = cs.update(recordId, patch, {
                ...(options?.mode !== undefined ? { mode: options.mode } : {}),
                updatedBy: 'flow',
              });
              if (!options?.suppressEvents) {
                await fire(id, 'updated', rec.data, rec.id, before?.data);
              }
              return { id: rec.id, data: rec.data, createdAt: rec.createdAt, updatedAt: rec.updatedAt };
            },
            async delete(slug, target, options) {
              const id = requireId(slug);
              let deletedRecords: { id: string; data: Record<string, unknown> }[] = [];
              if (target.recordId !== undefined) {
                const rec = cs.getRecord(target.recordId);
                if (rec && rec.collectionId === id) {
                  cs.deleteRecord(target.recordId);
                  deletedRecords = [{ id: rec.id, data: rec.data }];
                }
              } else {
                const matches = cs.find(id, toStoreFilter(target.filter ?? {}));
                if (matches.records.length > 1 && !options?.confirmMany) {
                  throw new Error(`refusing to delete ${matches.records.length} records without confirmMany`);
                }
                for (const rec of matches.records) {
                  if (cs.deleteRecord(rec.id)) deletedRecords.push({ id: rec.id, data: rec.data });
                }
              }
              if (!options?.suppressEvents) {
                for (const rec of deletedRecords) await fire(id, 'deleted', rec.data, rec.id);
              }
              return deletedRecords.length;
            },
          };
          },
        }
      : {}),
    // LLM chat (ai.llmChat P5-T1 / ai.agent P5-T2). Per-run factory (PD-T2): the
    // host binds the capability to the run so it enforces the bot's daily AI
    // budget before each call and meters reported usage after. The decrypted key
    // never reaches node code (invariants I6/I7).
    ai: makeAiFactory(opts.db, credentialKey, opts.fetchImpl ?? fetch, aiUsageStore),
    // MCP client (ai.mcpClient, P5-T3). Like ai, the credential selects the MCP
    // server, so this is a plain object. The decrypted key stays host-side (I6/I7).
    mcp: makeMcp(opts.db, credentialKey, opts.fetchImpl ?? fetch),
    // Postgres (db.postgres, PB-T2). The credential selects the database, so a
    // plain object; the host owns the pg pool (I3) and the DSN never reaches
    // node code (I6/I7).
    db: dbCapability.capability,
    // Live-voice (ctx.call, PE-T2). The credential selects the connector, so a
    // per-bot+flow factory bound to the long-lived Call Session Service; the host
    // owns the media socket + turn state (I4) and the session secret never reaches
    // node code (I6/I7).
    call: (botId, flowId) => callSessionService.capabilityFor(botId, flowId),
    log: stepLogger,
    clock,
  };

  const executor = new Executor(registry, store, services);
  const flowSource = new SqliteFlowSource(opts.db, (lvl, msg) => log(lvl, msg));
  // Durable queue backing the `queue` execution policy (P3-T6).
  const pending = new SqlitePendingTriggerStore(opts.db, clock);
  // Resolve the forward refs the subflow capability closes over.
  executorRef = executor;
  flowSourceRef = flowSource;

  const router = new UpdateRouter({
    store,
    executor,
    flows: flowSource,
    pending,
    sendText: async (botId, chatId, text) => {
      const handle = gateway.get(botId);
      if (!handle) throw new Error(`sendText: bot ${botId} not registered`);
      await handle.sender.sendMessage({ chat_id: chatId, text });
    },
    // tg.menu answer_callback_text (P2-T6) — stops Telegram's button spinner.
    answerCallback: async (botId, callbackQueryId, text) => {
      const handle = gateway.get(botId);
      if (!handle) throw new Error(`answerCallback: bot ${botId} not registered`);
      await handle.sender.call('answerCallbackQuery', {
        callback_query_id: callbackQueryId,
        ...(text !== undefined ? { text } : {}),
      });
    },
    // Upsert the sender into the users table on every update (P3-T5).
    onUser: async (event) => {
      userStore.touch(event.botId, event.user.id, {
        ...(event.user.firstName !== undefined ? { firstName: event.user.firstName } : {}),
        ...(event.user.lastName !== undefined ? { lastName: event.user.lastName } : {}),
        ...(event.user.username !== undefined ? { username: event.user.username } : {}),
        ...(event.user.lang !== undefined ? { lang: event.user.lang } : {}),
      });
    },
    log,
    clock,
  });

  gateway.setHandler((event) => router.handle(event));

  // Record-write event bus (P3.5-T5) — only when the collection store exists.
  // Built after the router (it needs it); resolve the forward ref the
  // `collections` capability closes over.
  const recordEventBus = collectionStore
    ? new RecordEventBus({ store: collectionStore, flowSource, router, log })
    : undefined;
  recordEventBusRef = recordEventBus ?? null;

  // Cron scheduler (P4-T2) — runs `schedule.trigger` nodes of active flows.
  // Not started here; the server lifecycle calls scheduler.start() after boot
  // and the flows API re-runs reconcile() on activate/deactivate/edit.
  const scheduler = new Scheduler({ db: opts.db, flowSource, router, userStore, log, clock });

  // Call-event bus (PE-T3) — subscribes to the Call Session Service's utterance
  // + lifecycle streams and fires `trigger.callEvent` flows. Built here (it needs
  // the router); the server lifecycle calls start()/stop() (main.ts).
  const callEventBus = new CallEventBus({
    service: callSessionService,
    flowSource,
    router,
    fileStore,
    log,
  });

  // Outbound instance webhooks (P4-T4). The dispatcher owns delivery; the two
  // event sources (execution store + user store) hand it built envelopes via
  // listeners attached here so neither store imports the dispatcher.
  const webhookDispatcher = new WebhookDispatcher({
    db: opts.db,
    log,
    clock,
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
  });
  store.setFinishedListener((execution) => {
    webhookDispatcher.dispatch({
      event: execution.status === 'error' ? 'execution.failed' : 'execution.finished',
      bot_id: execution.botId,
      flow_id: execution.flowId,
      execution_id: execution.id,
      chat_id: execution.chatId,
      at: clock().toISOString(),
      data: {
        status: execution.status,
        error: execution.error,
        user_id: execution.userId,
        steps: execution.state.steps,
      },
    });
  });
  userStore.setFirstSeenListener((botId, user) => {
    webhookDispatcher.dispatch({
      event: 'user.first_seen',
      bot_id: botId,
      flow_id: null,
      execution_id: null,
      chat_id: user.tgUserId,
      at: clock().toISOString(),
      data: {
        tg_user_id: user.tgUserId,
        profile: user.profile,
        first_seen: user.firstSeen,
      },
    });
  });

  return {
    gateway,
    router,
    executor,
    store,
    registry,
    flowSource,
    userStore,
    scheduler,
    callSessionService,
    callEventBus,
    webhookDispatcher,
    fileStore,
    aiUsageStore,
    rateLimiter,
    auditStore,
    closeDbPools: () => dbCapability.closeAll(),
    ...(collectionStore ? { collectionStore } : {}),
    ...(recordEventBus ? { recordEventBus } : {}),
  };
}
