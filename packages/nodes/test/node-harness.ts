/**
 * Contract-test harness for node implementations: a fake NodeCtx with a
 * recording Telegram sender + in-memory vars, and a params helper that
 * routes raw params through the node's own Zod schema (exactly what the
 * registry does at runtime — so tests validate the schema too).
 */
import { runInSandbox } from '@ctb/sandbox';
import type { FlowItem, NodeCtx, NodeDef } from '@ctb/shared';

export interface SentMessage {
  opts: Record<string, unknown>;
  messageId: number;
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
}

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
  } = {},
): FakeCtx {
  const sent: SentMessage[] = [];
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
  let nextMessageId = 100;
  let httpIdx = 0;
  const now = overrides.now ?? new Date('2026-06-11T10:00:00.000Z');

  const ctx: FakeCtx = {
    executionId: 'exec1',
    flowId: 'flow1',
    botId: 'bot1',
    chatId: overrides.chatId === undefined ? 777 : overrides.chatId,
    nodeId: overrides.nodeId ?? 'node1',
    inputsByPort: overrides.inputsByPort ?? {},
    sent,
    edited,
    varsBag,
    kvBag,
    httpCalls,
    logs,
    subflowCalls,
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
  };
  return ctx;
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
