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
import type { FlowItem, NodeCtx } from '@ctb/shared';
import { and, eq } from 'drizzle-orm';
import type { Db } from '../db/index';
import { execLogs, kvStore } from '../db/schema';
import { TelegramGateway } from '../telegram/gateway';
import { SqliteFlowSource } from './flow-source';
import { UpdateRouter } from './router';
import { SqliteExecutionStore } from './sqlite-store';

export interface WireOptions {
  db: Db;
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
  const gateway = new TelegramGateway({ ctbSecret: opts.ctbSecret });

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

  // One executor serves many bots — kv and tg resolve per-bot lazily (DL #15).
  const kvCache = new Map<string, NodeCtx['kv']>();
  // Forward refs: the subflow capability needs executor + flowSource, but those
  // are built FROM `services` — so the closure reads them lazily after wiring.
  let executorRef: Executor | null = null;
  let flowSourceRef: SqliteFlowSource | null = null;
  const maxSubFlowDepth = opts.maxSubFlowDepth ?? DEFAULT_MAX_SUBFLOW_DEPTH;
  const services: ExecutorServices = {
    kv: (botId) => {
      let kv = kvCache.get(botId);
      if (!kv) {
        kv = makeKv(opts.db, botId, clock);
        kvCache.set(botId, kv);
      }
      return kv;
    },
    http: makeHttp(opts.fetchImpl ?? fetch),
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
      };
    },
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
    log: stepLogger,
    clock,
  };

  const executor = new Executor(registry, store, services);
  const flowSource = new SqliteFlowSource(opts.db, (lvl, msg) => log(lvl, msg));
  // Resolve the forward refs the subflow capability closes over.
  executorRef = executor;
  flowSourceRef = flowSource;

  const router = new UpdateRouter({
    store,
    executor,
    flows: flowSource,
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
    log,
    clock,
  });

  gateway.setHandler((event) => router.handle(event));

  return { gateway, router, executor, store, registry, flowSource };
}
