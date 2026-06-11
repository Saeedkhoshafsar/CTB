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
import { Executor, NodeRegistry, type ExecutorServices, type StepLogEntry } from '@ctb/core';
import { registerBuiltinNodes } from '@ctb/nodes';
import type { NodeCtx } from '@ctb/shared';
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
}

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
          input: null,
          output: entry.data !== undefined ? entry.data : null,
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
    tg: (botId, _chatId) => {
      const handle = gateway.get(botId);
      if (!handle) return null;
      return {
        sendMessage: (o) =>
          handle.sender.sendMessage(o as Parameters<typeof handle.sender.sendMessage>[0]),
      };
    },
    log: stepLogger,
    clock,
  };

  const executor = new Executor(registry, store, services);
  const flowSource = new SqliteFlowSource(opts.db, (lvl, msg) => log(lvl, msg));

  const router = new UpdateRouter({
    store,
    executor,
    flows: flowSource,
    sendText: async (botId, chatId, text) => {
      const handle = gateway.get(botId);
      if (!handle) throw new Error(`sendText: bot ${botId} not registered`);
      await handle.sender.sendMessage({ chat_id: chatId, text });
    },
    log,
    clock,
  });

  gateway.setHandler((event) => router.handle(event));

  return { gateway, router, executor, store, registry, flowSource };
}
