/**
 * Contract-test harness for node implementations: a fake NodeCtx with a
 * recording Telegram sender + in-memory vars, and a params helper that
 * routes raw params through the node's own Zod schema (exactly what the
 * registry does at runtime — so tests validate the schema too).
 */
import { runInSandbox } from '@ctb/sandbox';
import type {
  AiChatRequest,
  AiSpeechRequest,
  AiTranscribeRequest,
  AttachedProviders,
  CallSpeakRequest,
  CallStatus,
  CallTargetRef,
  CollectionRecord,
  CtbUser,
  DbQueryRequest,
  DbQueryResult,
  FlowItem,
  McpCallToolRequest,
  McpListToolsRequest,
  McpTool,
  McpToolCallResult,
  NodeCtx,
  NodeDef,
} from '@ctb/shared';

export interface SentMessage {
  opts: Record<string, unknown>;
  messageId: number;
}

export interface SentMedia {
  opts: Record<string, unknown>;
  messageIds: number[];
}

export interface HttpCall {
  method: string;
  url: string;
  headers?: Record<string, string> | undefined;
  body?: string | Record<string, unknown> | undefined;
  timeoutMs?: number | undefined;
}

export interface FakeCtx extends NodeCtx {
  sent: SentMessage[];
  /** tg.sendMedia (PA-T1): recorded media/album sends. */
  sentMedia: SentMedia[];
  /** tg.getFile (PA-T2): recorded file_ids passed to ctx.tg.getFile. */
  getFileCalls: string[];
  /** tg.getFile (PA-T2): bytes/mime written via ctx.files.write, in order. */
  storedFiles: { id: string; bytes: Uint8Array; mime: string | null }[];
  edited: Record<string, unknown>[];
  varsBag: Record<string, unknown>;
  /** In-memory kv backing: keys are `${scope}:${key}`. */
  kvBag: Map<string, unknown>;
  httpCalls: HttpCall[];
  logs: { level: string; message: string }[];
  /** flow.executeSubFlow (P3-T1): recorded sub-flow calls. */
  subflowCalls: { flowId: string; items: FlowItem[] }[];
  /** P3-T3 tg capabilities: recorded payloads by Bot-API method. */
  editedCaption: Record<string, unknown>[];
  editedReplyMarkup: Record<string, unknown>[];
  deleted: Record<string, unknown>[];
  answeredCallbacks: Record<string, unknown>[];
  chatActions: Record<string, unknown>[];
  /** data.userProfile (P3-T5): in-memory user store keyed by tgUserId. */
  usersBag: Map<number, CtbUser>;
  /** data.collection (P3.5-T5): in-memory records keyed by `${slug}` → id → record. */
  collectionsBag: Map<string, Map<string, CollectionRecord>>;
  /** data.collection: recorded write events (for suppress_events assertions). */
  recordEvents: { event: 'created' | 'updated' | 'deleted'; slug: string; recordId: string }[];
  /** ai.llmChat (P5-T1): recorded LLM chat requests. */
  aiCalls: AiChatRequest[];
  /** ai.speechToText (PB-T7): recorded transcription requests. */
  transcribeCalls: AiTranscribeRequest[];
  /** ai.textToSpeech (PB-T7): recorded speech-synthesis requests. */
  speechCalls: AiSpeechRequest[];
  /** ai.mcpClient (P5-T3): recorded MCP requests by kind. */
  mcpListCalls: McpListToolsRequest[];
  mcpCallCalls: McpCallToolRequest[];
  /** db.postgres (PB-T2): recorded SQL query requests. */
  dbCalls: DbQueryRequest[];
  /** call.* (PE-T2): recorded ctx.call invocations by method. */
  callCalls: CallInvocation[];
}

/** PE-T2: a single recorded ctx.call invocation (method + its request). */
export type CallInvocation =
  | { method: 'connect'; req: { credentialId: string; target: CallTargetRef; mode: string; order?: string; maxTurnSeconds?: number } }
  | { method: 'speak'; req: CallSpeakRequest }
  | { method: 'grantTurn'; req: { target: CallTargetRef; userId?: number | string } }
  | { method: 'endTurn'; req: { target: CallTargetRef } }
  | { method: 'mute'; req: { target: CallTargetRef; userId: number | string; muted: boolean } }
  | { method: 'leave'; req: { target: CallTargetRef } }
  | { method: 'status'; req: { target: CallTargetRef } };

export function makeCtx(
  overrides: {
    chatId?: number | null;
    tg?: null;
    now?: Date;
    /** Scripted http responses, consumed in order (last one repeats). */
    httpResponses?: { status: number; headers?: Record<string, string>; body: unknown }[];
    /**
     * flow.executeSubFlow (P3-T1): the injected sub-flow runner. Pass `null`
     * to simulate an instance with no sub-flow support (ctx.subflow === null);
     * omit to get a default that echoes the input items back.
     */
    subflowRun?: ((flowId: string, items: FlowItem[]) => Promise<{ items: FlowItem[] }>) | null;
    /** P3-T2: the executing node's graph id (flow.loop scopes $vars by it). */
    nodeId?: string;
    /**
     * P3-T2: items grouped by the input port they arrived on (flow.merge reads
     * this to tell its two branches apart). Empty by default.
     */
    inputsByPort?: Record<string, FlowItem[]>;
    /**
     * P3-T4: scripted credential resolver. A map of credentialId → auth headers
     * (or null = "not found"). Pass `null` to simulate ctx.credentials === null
     * (no credential store, e.g. a bare unit context). Omit → resolver present
     * but every lookup returns null.
     */
    credentialHeaders?: Record<string, Record<string, string> | null> | null;
    /**
     * P3-T5: the execution's own tg user id (data.userProfile defaults to it).
     * Defaults to the chatId when it's a positive id; pass `null` to simulate a
     * run with no user (e.g. a sub-flow). Pass `users: null` to drop ctx.users.
     */
    selfUserId?: number | null;
    /** Pass `null` to simulate an instance with no user store (ctx.users === null). */
    users?: null;
    /** Seed the in-memory user store before the run. */
    seedUsers?: CtbUser[];
    /** Pass `null` to simulate an instance with no collection store (ctx.collections === null). */
    collections?: null;
    /**
     * P5-T1: scripted LLM responses for ctx.ai.chat, consumed in order (last
     * repeats). Pass `null` to simulate an instance with no AI service
     * (ctx.ai === null). Omit → a default echo reply.
     */
    aiResponses?:
      | {
          reply: string;
          usage?: Record<string, number>;
          model?: string;
          /** ai.agent (P5-T4): tool calls the model requests this turn. */
          toolCalls?: { id: string; name: string; argumentsJson: string }[];
        }[]
      | null;
    /**
     * PB-T7: scripted ai.speechToText behaviour for ctx.ai.transcribe.
     *  - omit → a default `{ text: 'transcribed: <filename>' }`.
     *  - object → returned verbatim.
     *  - function → called with the request.
     *  - `error` → ctx.ai.transcribe throws this message.
     * Pass `dropTranscribe: true` to drop the method so the node sees an
     * instance whose `ctx.ai.transcribe` is undefined (capability absent).
     */
    transcribeResult?:
      | { text: string; language?: string; duration?: number }
      | ((req: AiTranscribeRequest) => { text: string; language?: string; duration?: number })
      | { error: string };
    /** Drop ctx.ai.transcribe so the node sees a host without the capability. */
    dropTranscribe?: boolean;
    /**
     * PB-T7: scripted ai.textToSpeech behaviour for ctx.ai.speech.
     *  - omit → a default that returns a tiny byte buffer + a mime from format.
     *  - object → returned verbatim.
     *  - function → called with the request.
     *  - `error` → ctx.ai.speech throws this message.
     * Pass `dropSpeech: true` to drop the method so the node sees an instance
     * whose `ctx.ai.speech` is undefined (capability absent).
     */
    speechResult?:
      | { audio: Uint8Array; mime: string }
      | ((req: AiSpeechRequest) => { audio: Uint8Array; mime: string })
      | { error: string };
    /** Drop ctx.ai.speech so the node sees a host without the capability. */
    dropSpeech?: boolean;
    /**
     * P5-T3: scripted MCP behaviour for ctx.mcp. Pass `null` to simulate an
     * instance with no MCP service (ctx.mcp === null). Omit → a default that
     * returns one echo tool / echoes the call arguments back as text.
     *  - `tools`: what listTools() returns.
     *  - `callResult`: what callTool() returns (or a function of the request).
     *  - `callError` / `listError`: throw this message instead (transport/tool error).
     */
    mcp?:
      | null
      | {
          tools?: McpTool[];
          callResult?:
            | McpToolCallResult
            | ((req: McpCallToolRequest) => McpToolCallResult);
          listError?: string;
          callError?: string;
        };
    /**
     * PB-T2: scripted SQL behaviour for ctx.db. Pass `null` to simulate an
     * instance with no DB driver (ctx.db === null). Omit → a default that
     * returns an empty result. `result` may be a fixed DbQueryResult or a
     * function of the request; `error` throws instead (a DB/transport error).
     */
    db?:
      | null
      | {
          result?: DbQueryResult | ((req: DbQueryRequest) => DbQueryResult);
          error?: string;
        };
    /**
     * PA-T1: seed the in-memory file store for ctx.files.read (tg.sendMedia
     * `source:'file'`): fileId → { bytes, mime }. Pass `files: null` to simulate
     * an instance with no file store (ctx.files === null). Unknown ids throw.
     */
    seedFiles?: Record<string, { bytes: Uint8Array; mime?: string | null }>;
    /** Pass `null` to simulate an instance with no file store (ctx.files === null). */
    files?: null;
    /** tg.sendMedia: make ctx.tg.sendMedia throw this message (transport error). */
    sendMediaError?: string;
    /**
     * tg.getFile (PA-T2): the bytes/metadata ctx.tg.getFile returns for any
     * file_id. Defaults to a small synthetic file. `mime`/`size` default to
     * sensible values when omitted.
     */
    getFileResult?: { bytes?: Uint8Array; filePath?: string; size?: number | null; mime?: string | null };
    /** tg.getFile: make ctx.tg.getFile throw this message (download error). */
    getFileError?: string;
    /** tg.getFile: drop ctx.tg.getFile so the node sees an instance without it. */
    noGetFile?: boolean;
    /** Seed the in-memory collection store: slug → array of record docs (id auto-assigned if absent). */
    seedCollections?: Record<string, { id?: string; data: Record<string, unknown> }[]>;
    /** Slugs that exist (so unknown-slug throws like the real store). Defaults to seeded slugs. */
    knownCollections?: string[];
    /**
     * PB-T5: the providers attached to a CONSUMER node's typed input slots
     * (`ai:model`/`ai:memory`/`ai:tool`), exactly as the executor's
     * `resolveSlots` would hand them over. Each entry is `{ nodeId, type,
     * params }`. Defaults to `{}` (no slots — every plain data node).
     */
    slots?: AttachedProviders;
    /**
     * PE-T2: live-voice capability (ctx.call). Pass `null` to simulate an
     * instance with no Call Session Service (ctx.call === null). Omit → a
     * recording fake whose connect/speak/grantTurn/… are no-ops that push into
     * `callCalls` and return benign defaults.
     */
    call?:
      | null
      | {
          status?: CallStatus | ((req: { target: CallTargetRef }) => CallStatus);
          grantTurn?: number | string | null;
        };
  } = {},
): FakeCtx {
  const sent: SentMessage[] = [];
  const sentMedia: SentMedia[] = [];
  const getFileCalls: string[] = [];
  const storedFiles: { id: string; bytes: Uint8Array; mime: string | null }[] = [];
  let nextStoredFileId = 1;
  const filesBag = new Map<string, { bytes: Uint8Array; mime: string | null }>();
  for (const [id, f] of Object.entries(overrides.seedFiles ?? {})) {
    filesBag.set(id, { bytes: f.bytes, mime: f.mime ?? null });
  }
  const edited: Record<string, unknown>[] = [];
  const editedCaption: Record<string, unknown>[] = [];
  const editedReplyMarkup: Record<string, unknown>[] = [];
  const deleted: Record<string, unknown>[] = [];
  const answeredCallbacks: Record<string, unknown>[] = [];
  const chatActions: Record<string, unknown>[] = [];
  const varsBag: Record<string, unknown> = {};
  const kvBag = new Map<string, unknown>();
  const httpCalls: HttpCall[] = [];
  const logs: { level: string; message: string }[] = [];
  const subflowCalls: { flowId: string; items: FlowItem[] }[] = [];
  const usersBag = new Map<number, CtbUser>();
  const collectionsBag = new Map<string, Map<string, CollectionRecord>>();
  const recordEvents: { event: 'created' | 'updated' | 'deleted'; slug: string; recordId: string }[] = [];
  const aiCalls: AiChatRequest[] = [];
  let aiIdx = 0;
  const transcribeCalls: AiTranscribeRequest[] = [];
  const speechCalls: AiSpeechRequest[] = [];
  const mcpListCalls: McpListToolsRequest[] = [];
  const mcpCallCalls: McpCallToolRequest[] = [];
  const dbCalls: DbQueryRequest[] = [];
  const callCalls: CallInvocation[] = [];
  let nextRecordId = 1;
  const knownSlugs = new Set<string>(
    overrides.knownCollections ?? Object.keys(overrides.seedCollections ?? {}),
  );
  for (const [slug, recs] of Object.entries(overrides.seedCollections ?? {})) {
    knownSlugs.add(slug);
    const map = new Map<string, CollectionRecord>();
    for (const r of recs) {
      const id = r.id ?? `rec${nextRecordId++}`;
      map.set(id, { id, data: { ...r.data }, createdAt: '2026-06-11T10:00:00.000Z', updatedAt: '2026-06-11T10:00:00.000Z' });
    }
    collectionsBag.set(slug, map);
  }
  let nextMessageId = 100;
  let httpIdx = 0;
  const now = overrides.now ?? new Date('2026-06-11T10:00:00.000Z');
  const nowIso = now.toISOString();
  for (const u of overrides.seedUsers ?? []) usersBag.set(u.tgUserId, { ...u });
  const selfUserId =
    overrides.selfUserId !== undefined
      ? overrides.selfUserId
      : typeof (overrides.chatId === undefined ? 777 : overrides.chatId) === 'number' &&
          (overrides.chatId === undefined ? 777 : overrides.chatId)! > 0
        ? (overrides.chatId === undefined ? 777 : (overrides.chatId as number))
        : null;
  /** Resolve target id (explicit arg → fallback to the execution's own user). */
  const resolveUid = (uid?: number): number => {
    const id = uid ?? selfUserId;
    if (id === null || id === undefined) throw new Error('data.userProfile: no target user');
    return id;
  };
  const upsertUser = (uid: number): CtbUser => {
    let u = usersBag.get(uid);
    if (!u) {
      u = { tgUserId: uid, profile: {}, tags: [], firstSeen: nowIso, lastSeen: nowIso };
      usersBag.set(uid, u);
    }
    return u;
  };

  const ctx: FakeCtx = {
    executionId: 'exec1',
    flowId: 'flow1',
    botId: 'bot1',
    chatId: overrides.chatId === undefined ? 777 : overrides.chatId,
    nodeId: overrides.nodeId ?? 'node1',
    inputsByPort: overrides.inputsByPort ?? {},
    sent,
    sentMedia,
    getFileCalls,
    storedFiles,
    edited,
    varsBag,
    kvBag,
    httpCalls,
    logs,
    subflowCalls,
    usersBag,
    collectionsBag,
    recordEvents,
    aiCalls,
    transcribeCalls,
    speechCalls,
    mcpListCalls,
    mcpCallCalls,
    dbCalls,
    callCalls,
    async eval(template) {
      return template; // nodes receive pre-resolved params; ctx.eval rarely used in wave 1
    },
    vars: {
      get: (k) => varsBag[k],
      set: (k, v) => {
        varsBag[k] = v;
      },
      all: () => ({ ...varsBag }),
    },
    kv: {
      get: async (scope, key) => kvBag.get(`${scope}:${key}`),
      set: async (scope, key, value) => {
        kvBag.set(`${scope}:${key}`, value);
      },
      delete: async (scope, key) => {
        kvBag.delete(`${scope}:${key}`);
      },
    },
    http: {
      async request(opts) {
        httpCalls.push(opts);
        const scripted = overrides.httpResponses;
        if (!scripted || scripted.length === 0) return { status: 200, headers: {}, body: null };
        const r = scripted[Math.min(httpIdx++, scripted.length - 1)]!;
        return { status: r.status, headers: r.headers ?? {}, body: r.body };
      },
    },
    credentials:
      overrides.credentialHeaders === null
        ? null
        : {
            async authHeaders(credentialId) {
              return overrides.credentialHeaders?.[credentialId] ?? null;
            },
          },
    editedCaption,
    editedReplyMarkup,
    deleted,
    answeredCallbacks,
    chatActions,
    tg:
      overrides.tg === null
        ? null
        : {
            async sendMessage(opts) {
              const messageId = nextMessageId++;
              sent.push({ opts, messageId });
              return { messageId };
            },
            async editMessageText(opts) {
              edited.push(opts);
            },
            async editMessageCaption(opts) {
              editedCaption.push(opts);
            },
            async editMessageReplyMarkup(opts) {
              editedReplyMarkup.push(opts);
            },
            async deleteMessage(opts) {
              deleted.push(opts);
            },
            async answerCallbackQuery(opts) {
              answeredCallbacks.push(opts);
            },
            async sendChatAction(opts) {
              chatActions.push(opts);
            },
            async sendMedia(opts) {
              if (overrides.sendMediaError) throw new Error(overrides.sendMediaError);
              // One synthetic message id per media item (mirrors sendMediaGroup).
              const messageIds = (opts.media as unknown[]).map(() => nextMessageId++);
              sentMedia.push({ opts: opts as Record<string, unknown>, messageIds });
              return { messageIds };
            },
            // tg.getFile (PA-T2): host-side download. Records the file_id and
            // returns scripted bytes/metadata; `noGetFile` drops the method.
            ...(overrides.noGetFile
              ? {}
              : {
                  async getFile(fileId: string) {
                    getFileCalls.push(fileId);
                    if (overrides.getFileError) throw new Error(overrides.getFileError);
                    const r = overrides.getFileResult ?? {};
                    const bytes = r.bytes ?? new Uint8Array([1, 2, 3, 4]);
                    return {
                      bytes,
                      filePath: r.filePath ?? `photos/${fileId}.jpg`,
                      size: r.size === undefined ? bytes.byteLength : r.size,
                      mime: r.mime === undefined ? 'image/jpeg' : r.mime,
                    };
                  },
                }),
          },
    // PA-T1: file-store reader for tg.sendMedia (`source:'file'`).
    files:
      overrides.files === null
        ? null
        : {
            async read(fileId) {
              const f = filesBag.get(fileId);
              if (!f) throw new Error(`file not found: ${fileId}`);
              return { bytes: f.bytes, mime: f.mime };
            },
            // PA-T2: store bytes for tg.getFile (`store:true`). Mirrors the host
            // putLocal → FilePublic projection with a synthetic, stable id.
            async write(bytes, mime) {
              const id = `stored${nextStoredFileId++}`;
              filesBag.set(id, { bytes, mime });
              storedFiles.push({ id, bytes, mime });
              return { id, mime, size: bytes.byteLength, url: `/api/files/${id}` };
            },
          },
    log: (level, message) => logs.push({ level, message }),
    now: () => now,
    // data.code (P2-T7): REAL sandbox pool + harness-backed capability proxies,
    // so contract tests exercise true isolation, timeouts and console capture.
    code: {
      run: async (source, items, opts) => {
        const scope: Record<string, unknown> = {
          $items: items,
          $json: items[0]?.json ?? {},
          $vars: { ...varsBag },
        };
        return runInSandbox(source, scope, {
          mode: 'script',
          ...(opts?.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
          capabilities: {
            $http: {
              request: async (...args: unknown[]) => {
                const req = (args[0] ?? {}) as { method?: string; url?: string };
                return ctx.http.request({ method: req.method ?? 'GET', url: req.url ?? '', ...(args[0] as object) });
              },
              get: async (...args: unknown[]) =>
                ctx.http.request({ method: 'GET', url: String(args[0]) }),
            },
            $kv: {
              get: async (...args: unknown[]) => kvBag.get(`user:${String(args[0])}`),
              set: async (...args: unknown[]) => {
                kvBag.set(`user:${String(args[0])}`, args[1]);
              },
              delete: async (...args: unknown[]) => {
                kvBag.delete(`user:${String(args[0])}`);
              },
            },
          },
        });
      },
    },
    // flow.executeSubFlow (P3-T1): records calls; `subflowRun: null` simulates
    // an instance without sub-flow support; default echoes input items back.
    subflow:
      overrides.subflowRun === null
        ? null
        : {
            run: async (flowId, items) => {
              subflowCalls.push({ flowId, items });
              return overrides.subflowRun
                ? overrides.subflowRun(flowId, items)
                : { items };
            },
          },
    // data.userProfile (P3-T5): in-memory user store; `users: null` drops it.
    users:
      overrides.users === null
        ? null
        : {
            async get(tgUserId) {
              const u = usersBag.get(resolveUid(tgUserId));
              return u ? { ...u } : null;
            },
            async setProfile(fields, opts) {
              const u = upsertUser(resolveUid(opts?.tgUserId));
              u.profile = opts?.mode === 'replace' ? { ...fields } : { ...u.profile, ...fields };
              u.lastSeen = nowIso;
              return { ...u };
            },
            async addTags(tags, tgUserId) {
              const u = upsertUser(resolveUid(tgUserId));
              u.tags = [...new Set([...u.tags, ...tags])];
              u.lastSeen = nowIso;
              return { ...u };
            },
            async removeTags(tags, tgUserId) {
              const u = upsertUser(resolveUid(tgUserId));
              const drop = new Set(tags);
              u.tags = u.tags.filter((t) => !drop.has(t));
              u.lastSeen = nowIso;
              return { ...u };
            },
          },
    // data.collection (P3.5-T5): in-memory collection store; `collections: null`
    // drops it. Slugs must be "known" (seeded or in knownCollections) or ops
    // throw — mirroring the real store's CollectionNotFoundError.
    collections:
      overrides.collections === null
        ? null
        : {
            async find(slug, filter) {
              const map = requireCollection(slug);
              let recs = [...map.values()].filter((r) => matchesWhere(r.data, filter.where ?? []));
              recs = sortRecords(recs, filter.sort ?? []);
              const total = recs.length;
              const offset = filter.offset ?? 0;
              const end = filter.limit !== undefined ? offset + filter.limit : undefined;
              return { records: recs.slice(offset, end).map(cloneRec), total };
            },
            async get(slug, recordId) {
              const map = requireCollection(slug);
              const r = map.get(recordId);
              return r ? cloneRec(r) : null;
            },
            async count(slug, filter) {
              const map = requireCollection(slug);
              return [...map.values()].filter((r) => matchesWhere(r.data, filter.where ?? [])).length;
            },
            async insert(slug, data, opts) {
              const map = requireCollection(slug);
              const id = `rec${nextRecordId++}`;
              const rec: CollectionRecord = { id, data: { ...data }, createdAt: nowIso, updatedAt: nowIso };
              map.set(id, rec);
              if (!opts?.suppressEvents) recordEvents.push({ event: 'created', slug, recordId: id });
              return cloneRec(rec);
            },
            async update(slug, recordId, patch, opts) {
              const map = requireCollection(slug);
              const cur = map.get(recordId);
              if (!cur) throw new Error(`record not found: ${recordId}`);
              const data = opts?.mode === 'replace' ? { ...patch } : { ...cur.data, ...patch };
              const rec: CollectionRecord = { ...cur, data, updatedAt: nowIso };
              map.set(recordId, rec);
              if (!opts?.suppressEvents) recordEvents.push({ event: 'updated', slug, recordId });
              return cloneRec(rec);
            },
            async delete(slug, target, opts) {
              const map = requireCollection(slug);
              let ids: string[];
              if (target.recordId !== undefined) {
                ids = map.has(target.recordId) ? [target.recordId] : [];
              } else {
                ids = [...map.values()]
                  .filter((r) => matchesWhere(r.data, target.filter?.where ?? []))
                  .map((r) => r.id);
                if (ids.length > 1 && !opts?.confirmMany) {
                  throw new Error(`refusing to delete ${ids.length} records without confirmMany`);
                }
              }
              for (const id of ids) {
                map.delete(id);
                if (!opts?.suppressEvents) recordEvents.push({ event: 'deleted', slug, recordId: id });
              }
              return ids.length;
            },
          },
    // ai.llmChat (P5-T1): records requests; `aiResponses: null` simulates an
    // instance with no AI service (ctx.ai === null); omit → a default echo.
    ai:
      overrides.aiResponses === null
        ? null
        : {
            async chat(req) {
              aiCalls.push(req);
              const scripted = overrides.aiResponses;
              if (!scripted || scripted.length === 0) {
                const last = req.messages[req.messages.length - 1];
                return { reply: `echo: ${last?.content ?? ''}`, usage: {} };
              }
              const r = scripted[Math.min(aiIdx++, scripted.length - 1)]!;
              return {
                reply: r.reply,
                usage: r.usage ?? {},
                ...(r.model ? { model: r.model } : {}),
                ...(r.toolCalls ? { toolCalls: r.toolCalls } : {}),
              };
            },
            // ai.speechToText (PB-T7): records the request; default echoes the
            // filename. `dropTranscribe` omits the method (capability absent).
            ...(overrides.dropTranscribe
              ? {}
              : {
                  async transcribe(req: AiTranscribeRequest) {
                    transcribeCalls.push(req);
                    const r = overrides.transcribeResult;
                    if (r && 'error' in r) throw new Error(r.error);
                    if (typeof r === 'function') return r(req);
                    if (r) return r;
                    return { text: `transcribed: ${req.filename}` };
                  },
                }),
            // ai.textToSpeech (PB-T7): records the request; default returns a
            // 3-byte buffer + a mime from the format. `dropSpeech` omits it.
            ...(overrides.dropSpeech
              ? {}
              : {
                  async speech(req: AiSpeechRequest) {
                    speechCalls.push(req);
                    const r = overrides.speechResult;
                    if (r && 'error' in r) throw new Error(r.error);
                    if (typeof r === 'function') return r(req);
                    if (r) return r;
                    const mime = req.format === 'opus' ? 'audio/ogg' : 'audio/mpeg';
                    return { audio: new Uint8Array([1, 2, 3]), mime };
                  },
                }),
          },
    // ai.mcpClient (P5-T3): records requests; `mcp: null` simulates an instance
    // with no MCP service (ctx.mcp === null); omit → a default echo server.
    mcp:
      overrides.mcp === null
        ? null
        : {
            async listTools(req) {
              mcpListCalls.push(req);
              if (overrides.mcp?.listError) throw new Error(overrides.mcp.listError);
              return (
                overrides.mcp?.tools ?? [
                  { name: 'echo', description: 'echoes its input', inputSchema: { type: 'object' } },
                ]
              );
            },
            async callTool(req) {
              mcpCallCalls.push(req);
              if (overrides.mcp?.callError) throw new Error(overrides.mcp.callError);
              const cr = overrides.mcp?.callResult;
              if (cr) return typeof cr === 'function' ? cr(req) : cr;
              const text = JSON.stringify(req.arguments);
              return { content: [{ type: 'text', text }], text, isError: false };
            },
          },
    // db.postgres (PB-T2): records requests; `db: null` simulates an instance
    // with no DB driver (ctx.db === null); omit → a default empty result.
    db:
      overrides.db === null
        ? null
        : {
            async query(req) {
              dbCalls.push(req);
              if (overrides.db?.error) throw new Error(overrides.db.error);
              const res = overrides.db?.result;
              if (res) return typeof res === 'function' ? res(req) : res;
              return { rows: [], rowCount: 0 };
            },
          },
    // PE-T2: live-voice capability. `call: null` simulates an instance with no
    // Call Session Service; otherwise a recording fake that pushes every
    // invocation into `callCalls` and returns benign defaults.
    call:
      overrides.call === null
        ? null
        : {
            async connect(req) {
              callCalls.push({ method: 'connect', req });
            },
            async speak(req) {
              callCalls.push({ method: 'speak', req });
            },
            async grantTurn(req) {
              callCalls.push({ method: 'grantTurn', req });
              const g = overrides.call?.grantTurn;
              return g === undefined ? (req.userId ?? null) : g;
            },
            async endTurn(req) {
              callCalls.push({ method: 'endTurn', req });
            },
            async mute(req) {
              callCalls.push({ method: 'mute', req });
            },
            async leave(req) {
              callCalls.push({ method: 'leave', req });
            },
            async status(req) {
              callCalls.push({ method: 'status', req });
              const s = overrides.call?.status;
              if (s) return typeof s === 'function' ? s(req) : s;
              return {
                connected: true,
                mode: 'support',
                participants: [],
                currentTurn: null,
                queue: [],
              };
            },
          },
    // PB-T5: attached sub-connection providers (default: none).
    slots: overrides.slots ?? {},
  };

  function requireCollection(slug: string): Map<string, CollectionRecord> {
    if (!knownSlugs.has(slug)) throw new Error(`collection not found: ${slug}`);
    let map = collectionsBag.get(slug);
    if (!map) {
      map = new Map();
      collectionsBag.set(slug, map);
    }
    return map;
  }

  return ctx;
}

/** Deep-ish clone a record so callers can't mutate the store. */
function cloneRec(r: CollectionRecord): CollectionRecord {
  return { ...r, data: structuredClone(r.data) };
}

/** Evaluate AND-combined where rows against a record's data (mirrors store ops). */
function matchesWhere(
  data: Record<string, unknown>,
  where: { field: string; op: string; value?: unknown }[],
): boolean {
  return where.every((row) => {
    const actual = readPath(data, row.field);
    switch (row.op) {
      case 'eq':
        return actual === row.value;
      case 'ne':
        return actual !== row.value;
      case 'gt':
        return Number(actual) > Number(row.value);
      case 'gte':
        return Number(actual) >= Number(row.value);
      case 'lt':
        return Number(actual) < Number(row.value);
      case 'lte':
        return Number(actual) <= Number(row.value);
      case 'contains':
        return String(actual ?? '').includes(String(row.value ?? ''));
      case 'in':
        return Array.isArray(row.value) ? row.value.includes(actual) : false;
      case 'exists':
        return row.value === false ? actual === undefined || actual === null : actual !== undefined && actual !== null;
      default:
        return false;
    }
  });
}

function sortRecords(recs: CollectionRecord[], sort: { field: string; dir?: 'asc' | 'desc' }[]): CollectionRecord[] {
  if (sort.length === 0) return recs;
  return [...recs].sort((a, b) => {
    for (const s of sort) {
      const av = readPath(a.data, s.field);
      const bv = readPath(b.data, s.field);
      if (av === bv) continue;
      const cmp = (av as number) < (bv as number) ? -1 : 1;
      return s.dir === 'desc' ? -cmp : cmp;
    }
    return 0;
  });
}

/** Read a dotted path from a record's data. */
function readPath(data: Record<string, unknown>, path: string): unknown {
  let cur: unknown = data;
  for (const part of path.split('.')) {
    if (typeof cur !== 'object' || cur === null) return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

/** Parse raw params through the node's schema — like NodeRegistry.parseParams. */
export function params<P>(def: NodeDef<P>, raw: unknown): P {
  const parsed = def.paramsSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`invalid params for ${def.type}: ${parsed.error.message}`);
  }
  return parsed.data;
}

export const item = (json: Record<string, unknown>): FlowItem => ({ json });
