/**
 * Contract-test harness for node implementations: a fake NodeCtx with a
 * recording Telegram sender + in-memory vars, and a params helper that
 * routes raw params through the node's own Zod schema (exactly what the
 * registry does at runtime — so tests validate the schema too).
 */
import type { FlowItem, NodeCtx, NodeDef } from '@ctb/shared';

export interface SentMessage {
  opts: Record<string, unknown>;
  messageId: number;
}

export interface FakeCtx extends NodeCtx {
  sent: SentMessage[];
  varsBag: Record<string, unknown>;
  logs: { level: string; message: string }[];
}

export function makeCtx(overrides: { chatId?: number | null; tg?: null; now?: Date } = {}): FakeCtx {
  const sent: SentMessage[] = [];
  const varsBag: Record<string, unknown> = {};
  const logs: { level: string; message: string }[] = [];
  let nextMessageId = 100;
  const now = overrides.now ?? new Date('2026-06-11T10:00:00.000Z');

  const ctx: FakeCtx = {
    executionId: 'exec1',
    flowId: 'flow1',
    botId: 'bot1',
    chatId: overrides.chatId === undefined ? 777 : overrides.chatId,
    sent,
    varsBag,
    logs,
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
      get: async () => undefined,
      set: async () => undefined,
      delete: async () => undefined,
    },
    http: { request: async () => ({ status: 200, headers: {}, body: null }) },
    tg:
      overrides.tg === null
        ? null
        : {
            async sendMessage(opts) {
              const messageId = nextMessageId++;
              sent.push({ opts, messageId });
              return { messageId };
            },
          },
    log: (level, message) => logs.push({ level, message }),
    now: () => now,
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
