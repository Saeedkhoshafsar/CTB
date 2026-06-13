/**
 * P3-T6 — execution policies (replace | queue | ignore) + per-flow
 * error-handler flow (ARCHITECTURE §4, PLAN P3-T6).
 *
 * "One waiting execution per chat per flow (configurable policy)." When a NEW
 * trigger fires for a (flow, chat) that already has a WAITING execution:
 *   - replace (default): cancel the waiting run, start the new one;
 *   - ignore: drop the new trigger, keep waiting;
 *   - queue: park the new trigger; run it when the waiting run finishes.
 *
 * Plus: when a flow's run ends in `error`, fire its configured error-handler
 * flow (same-bot, not self) with the failure details as the item.
 */
import {
  Executor,
  MemoryExecutionStore,
  NodeRegistry,
  type ExecutorServices,
} from '@ctb/core';
import { destroyDefaultSandboxPool } from '@ctb/sandbox';
import {
  defaultFlowSettings,
  end,
  out,
  wait,
  type ExecutionPolicy,
  type FlowGraph,
  type FlowItem,
  type FlowSettings,
  type NodeDef,
} from '@ctb/shared';
import type { Update } from 'grammy/types';
import { afterAll, describe, expect, it } from 'vitest';
import {
  UpdateRouter,
  type FlowSource,
  type PendingTriggerStore,
  type RouterFlow,
} from '../src/engine/router';
import { normalizeUpdate, type TgEvent } from '../src/telegram/normalize';

afterAll(async () => {
  await destroyDefaultSandboxPool();
});

const z = (await import('zod')).z;

// ── fake nodes ────────────────────────────────────────────────────────────────

/** tg.trigger — entry node: passes the trigger item through. */
const triggerNode: NodeDef<Record<string, unknown>> = {
  type: 'tg.trigger',
  category: 'trigger',
  meta: { labelKey: 'tg.trigger' },
  ports: { inputs: [], outputs: ['main'] },
  paramsSchema: z.looseObject({}),
  async execute(_ctx, _params, items) {
    return out({ main: items });
  },
};

/** test.wait — parks forever on a reply wait (so the run stays WAITING). */
const waitNode: NodeDef<Record<string, unknown>> = {
  type: 'test.wait',
  category: 'telegram',
  meta: { labelKey: 'test.wait' },
  ports: { inputs: ['main'], outputs: ['reply', 'timeout', 'invalid'] },
  paramsSchema: z.looseObject({}),
  async execute() {
    return wait({
      kind: 'reply',
      nodeId: 'UNSET',
      expect: 'text',
      retriesLeft: 0,
      timeoutAt: null,
    });
  },
};

/** test.boom — throws so the execution ends in `error`. */
const boomNode: NodeDef<Record<string, unknown>> = {
  type: 'test.boom',
  category: 'data',
  meta: { labelKey: 'test.boom' },
  ports: { inputs: ['main'], outputs: ['main'] },
  paramsSchema: z.looseObject({}),
  async execute() {
    throw new Error('kaboom');
  },
};

/** test.record — records the items it received into a shared sink, then ends. */
function makeRecordNode(sink: FlowItem[][]): NodeDef<Record<string, unknown>> {
  return {
    type: 'test.record',
    category: 'data',
    meta: { labelKey: 'test.record' },
    ports: { inputs: ['main'], outputs: [] },
    paramsSchema: z.looseObject({}),
    async execute(_ctx, _params, items) {
      sink.push(items);
      return end();
    },
  };
}

const endNode: NodeDef<Record<string, never>> = {
  type: 'test.end',
  category: 'flow',
  meta: { labelKey: 'test.end' },
  ports: { inputs: ['main'], outputs: [] },
  paramsSchema: z.object({}),
  async execute() {
    return end();
  },
};

// ── graphs ───────────────────────────────────────────────────────────────────

/** /go → wait (stays WAITING). Used for the three policy tests. */
const WAIT_GRAPH: FlowGraph = {
  nodes: [
    { id: 'trig', type: 'tg.trigger', params: { event: 'command', command: 'go' }, position: { x: 0, y: 0 }, disabled: false },
    { id: 'w', type: 'test.wait', params: {}, position: { x: 0, y: 0 }, disabled: false },
  ],
  edges: [{ id: 'e0', from: { node: 'trig', port: 'main' }, to: { node: 'w', port: 'main' } }],
};

/** /fail → boom (ends in error). */
const FAIL_GRAPH: FlowGraph = {
  nodes: [
    { id: 'trig', type: 'tg.trigger', params: { event: 'command', command: 'fail' }, position: { x: 0, y: 0 }, disabled: false },
    { id: 'boom', type: 'test.boom', params: {}, position: { x: 0, y: 0 }, disabled: false },
  ],
  edges: [{ id: 'e0', from: { node: 'trig', port: 'main' }, to: { node: 'boom', port: 'main' } }],
};

/** any_message → record. The error-handler target (an internal invocation). */
const HANDLER_GRAPH: FlowGraph = {
  nodes: [
    { id: 'trig', type: 'tg.trigger', params: { event: 'any_message' }, position: { x: 0, y: 0 }, disabled: false },
    { id: 'rec', type: 'test.record', params: {}, position: { x: 0, y: 0 }, disabled: false },
  ],
  edges: [{ id: 'e0', from: { node: 'trig', port: 'main' }, to: { node: 'rec', port: 'main' } }],
};

// ── in-memory pending-trigger store (mirrors SqlitePendingTriggerStore) ──────

class MemoryPendingStore implements PendingTriggerStore {
  private rows: Array<{
    id: number;
    botId: string;
    flowId: string;
    chatId: number;
    entryNodeId: string;
    userId: string | null;
    item: FlowItem;
  }> = [];
  private seq = 0;

  async enqueue(t: {
    botId: string;
    flowId: string;
    chatId: number;
    entryNodeId: string;
    userId: string | null;
    item: FlowItem;
  }): Promise<void> {
    this.rows.push({ id: ++this.seq, ...t });
  }

  async dequeue(
    botId: string,
    flowId: string,
    chatId: number,
  ): Promise<{ entryNodeId: string; userId: string | null; item: FlowItem } | null> {
    const idx = this.rows.findIndex(
      (r) => r.botId === botId && r.flowId === flowId && r.chatId === chatId,
    );
    if (idx === -1) return null;
    const [row] = this.rows.splice(idx, 1);
    return { entryNodeId: row!.entryNodeId, userId: row!.userId, item: row!.item };
  }

  get size(): number {
    return this.rows.length;
  }
}

// ── harness ──────────────────────────────────────────────────────────────────

function settings(overrides: Partial<FlowSettings> = {}): FlowSettings {
  return { ...defaultFlowSettings(), ...overrides };
}

/**
 * Build a router over a fixed set of flows. `withPending=false` omits the queue
 * store, so the `queue` policy degrades to `ignore` (documented behaviour).
 */
function makeHarness(flowList: RouterFlow[], opts: { withPending?: boolean } = {}) {
  const store = new MemoryExecutionStore();
  const recorded: FlowItem[][] = [];
  const registry = new NodeRegistry()
    .register(triggerNode)
    .register(waitNode)
    .register(boomNode)
    .register(makeRecordNode(recorded))
    .register(endNode);
  const services: ExecutorServices = {
    kv: () => ({ get: async () => undefined, set: async () => undefined, delete: async () => undefined }),
    http: { request: async () => ({ status: 200, headers: {}, body: null }) },
    tg: () => null,
  };
  const executor = new Executor(registry, store, services);
  const flows: FlowSource = {
    activeFlows: async (botId) => (botId === 'b1' ? flowList : []),
    getFlow: async (id) => flowList.find((f) => f.id === id) ?? null,
  };
  const pending = new MemoryPendingStore();
  let n = 0;
  const router = new UpdateRouter({
    store,
    executor,
    flows,
    sendText: async () => undefined,
    ...(opts.withPending === false ? {} : { pending }),
    newId: () => `exec-${++n}`,
  });
  return { store, router, pending, recorded };
}

function cmdEv(text: string, chatId = 7, updateId = 1): TgEvent {
  const update = {
    update_id: updateId,
    message: {
      message_id: 10 + updateId,
      date: 0,
      from: { id: 100 + chatId, is_bot: false, first_name: 'کاربر' },
      chat: { id: chatId, type: 'private', first_name: 'کاربر' },
      text,
    },
  } as unknown as Update;
  const event = normalizeUpdate('b1', update);
  if (!event) throw new Error('fixture produced unsupported update');
  return event;
}

function waitFlow(policy: ExecutionPolicy): RouterFlow {
  return { id: 'fw', name: 'انتظار', graph: WAIT_GRAPH, settings: settings({ executionPolicy: policy }) };
}

// ── tests: execution policies ────────────────────────────────────────────────

describe('UpdateRouter — execution policy (P3-T6)', () => {
  it('replace (default): a new trigger cancels the waiting run and starts a fresh one', async () => {
    const { router, store } = makeHarness([waitFlow('replace')]);

    await router.handle(cmdEv('/go', 7, 1));
    const first = await store.findWaiting({ botId: 'b1', chatId: 7 });
    expect(first).toHaveLength(1);
    const firstId = first[0]!.id;

    await router.handle(cmdEv('/go', 7, 2));
    // exactly one waiting again — but it's a NEW execution; the old one canceled
    const after = await store.findWaiting({ botId: 'b1', chatId: 7 });
    expect(after).toHaveLength(1);
    expect(after[0]!.id).not.toBe(firstId);
    expect((await store.load(firstId))!.status).toBe('canceled');
  });

  it('ignore: a new trigger is dropped; the original waiting run is untouched', async () => {
    const { router, store } = makeHarness([waitFlow('ignore')]);

    await router.handle(cmdEv('/go', 7, 1));
    const [orig] = await store.findWaiting({ botId: 'b1', chatId: 7 });

    await router.handle(cmdEv('/go', 7, 2));
    const after = await store.findWaiting({ botId: 'b1', chatId: 7 });
    expect(after).toHaveLength(1);
    expect(after[0]!.id).toBe(orig!.id); // same execution — new trigger ignored
    expect((await store.load('exec-2'))).toBeNull(); // no second execution ever started
  });

  it('queue: a new trigger is parked, then drained when the waiting run finishes', async () => {
    const { router, store, pending } = makeHarness([waitFlow('queue')]);

    await router.handle(cmdEv('/go', 7, 1));
    const [orig] = await store.findWaiting({ botId: 'b1', chatId: 7 });
    expect(pending.size).toBe(0);

    // second /go while waiting → parked (not started, original untouched)
    await router.handle(cmdEv('/go', 7, 2));
    expect(pending.size).toBe(1);
    let waiting = await store.findWaiting({ botId: 'b1', chatId: 7 });
    expect(waiting).toHaveLength(1);
    expect(waiting[0]!.id).toBe(orig!.id);

    // a reply finishes the original run → the parked trigger drains and starts
    await router.handle(cmdEv('hello', 7, 3));
    expect(pending.size).toBe(0);
    waiting = await store.findWaiting({ botId: 'b1', chatId: 7 });
    expect(waiting).toHaveLength(1); // the drained trigger is now the waiting run
    expect(waiting[0]!.id).not.toBe(orig!.id);
    expect((await store.load(orig!.id))!.status).toBe('done');
  });

  it('queue degrades to ignore when no pending store is wired', async () => {
    const { router, store } = makeHarness([waitFlow('queue')], { withPending: false });

    await router.handle(cmdEv('/go', 7, 1));
    const [orig] = await store.findWaiting({ botId: 'b1', chatId: 7 });

    await router.handle(cmdEv('/go', 7, 2)); // dropped (no queue store)
    const after = await store.findWaiting({ botId: 'b1', chatId: 7 });
    expect(after).toHaveLength(1);
    expect(after[0]!.id).toBe(orig!.id);
    expect(await store.load('exec-2')).toBeNull();
  });

  it('policy only applies to the SAME flow — a different flow in the same chat starts normally', async () => {
    const other: RouterFlow = {
      id: 'fo',
      name: 'دیگر',
      graph: {
        nodes: [
          { id: 'trig', type: 'tg.trigger', params: { event: 'command', command: 'other' }, position: { x: 0, y: 0 }, disabled: false },
          { id: 'w', type: 'test.wait', params: {}, position: { x: 0, y: 0 }, disabled: false },
        ],
        edges: [{ id: 'e0', from: { node: 'trig', port: 'main' }, to: { node: 'w', port: 'main' } }],
      },
      settings: settings({ executionPolicy: 'ignore' }),
    };
    const { router, store } = makeHarness([waitFlow('ignore'), other]);

    await router.handle(cmdEv('/go', 7, 1)); // flow fw waiting
    await router.handle(cmdEv('/other', 7, 2)); // different flow → starts despite fw waiting
    expect(await store.findWaiting({ botId: 'b1', chatId: 7 })).toHaveLength(2);
  });
});

// ── tests: per-flow error-handler flow ───────────────────────────────────────

describe('UpdateRouter — per-flow error-handler (P3-T6)', () => {
  function failFlow(handlerId: string | null): RouterFlow {
    return {
      id: 'ff',
      name: 'خطاساز',
      graph: FAIL_GRAPH,
      settings: settings({ errorHandlerFlowId: handlerId }),
    };
  }
  const handlerFlow: RouterFlow = {
    id: 'fh',
    name: 'مدیر-خطا',
    graph: HANDLER_GRAPH,
    settings: defaultFlowSettings(),
  };

  it('fires the configured error-handler flow with failure details on error', async () => {
    const { router, store, recorded } = makeHarness([failFlow('fh'), handlerFlow]);

    await router.handle(cmdEv('/fail', 7, 1));

    // the failing run ended in error
    expect((await store.load('exec-1'))!.status).toBe('error');

    // the handler ran (exec-2) and received the failure item
    expect(recorded).toHaveLength(1);
    const item = recorded[0]![0]!;
    expect(item.json).toMatchObject({
      failedFlowId: 'ff',
      failedFlowName: 'خطاساز',
      failedExecutionId: 'exec-1',
    });
    expect(String(item.json['error'])).toContain('kaboom');
  });

  it('does nothing when no error-handler is configured', async () => {
    const { router, store, recorded } = makeHarness([failFlow(null), handlerFlow]);

    await router.handle(cmdEv('/fail', 7, 1));
    expect((await store.load('exec-1'))!.status).toBe('error');
    expect(recorded).toHaveLength(0); // handler never invoked
    expect(await store.load('exec-2')).toBeNull();
  });

  it('does not re-handle a handler that itself errors (no recursion)', async () => {
    // ff points at a handler whose graph throws; the handler errors but is NOT
    // re-handled (it has no errorHandlerFlowId, and handler errors never recurse).
    const boomHandler: RouterFlow = {
      id: 'fh',
      name: 'مدیر-خطای-معیوب',
      graph: {
        nodes: [
          { id: 'trig', type: 'tg.trigger', params: { event: 'any_message' }, position: { x: 0, y: 0 }, disabled: false },
          { id: 'boom', type: 'test.boom', params: {}, position: { x: 0, y: 0 }, disabled: false },
        ],
        edges: [{ id: 'e0', from: { node: 'trig', port: 'main' }, to: { node: 'boom', port: 'main' } }],
      },
      settings: settings({ errorHandlerFlowId: 'fh' }), // even self-pointing won't recurse
    };
    const { router, store } = makeHarness([failFlow('fh'), boomHandler]);

    await router.handle(cmdEv('/fail', 7, 1));
    expect((await store.load('exec-1'))!.status).toBe('error'); // original failed
    expect((await store.load('exec-2'))!.status).toBe('error'); // handler also errored
    expect(await store.load('exec-3')).toBeNull(); // but it was NOT re-handled
  });
});
