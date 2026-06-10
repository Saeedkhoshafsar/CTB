/**
 * P1-T6 — update router integration tests (in-memory store + fake sender):
 * trigger starts execution; reply resumes the waiting one and NOT a new one;
 * validation failure re-prompts and stays waiting; timeout fires `timeout`
 * port; two chats run independently. Per PLAN acceptance criteria.
 */
import {
  Executor,
  MemoryExecutionStore,
  NodeRegistry,
  type ExecutorServices,
} from '@ctb/core';
import { destroyDefaultSandboxPool } from '@ctb/sandbox';
import { end, out, wait, type FlowGraph, type NodeDef } from '@ctb/shared';
import type { Update } from 'grammy/types';
import { afterAll, describe, expect, it } from 'vitest';
import { UpdateRouter, type FlowSource } from '../src/engine/router';
import { normalizeUpdate, type TgEvent } from '../src/telegram/normalize';

afterAll(async () => {
  await destroyDefaultSandboxPool();
});

// ── fake nodes ────────────────────────────────────────────────────────────────

/** tg.trigger — entry node: passes the trigger item through. */
const triggerNode: NodeDef<Record<string, unknown>> = {
  type: 'tg.trigger',
  category: 'trigger',
  meta: { labelKey: 'tg.trigger' },
  ports: { inputs: [], outputs: ['main'] },
  paramsSchema: (await import('zod')).z.looseObject({}),
  async execute(_ctx, _params, items) {
    return out({ main: items });
  },
};

/** test.ask — waits for a number reply, validated 1..120, 2 retries. */
const askAgeNode: NodeDef<Record<string, unknown>> = {
  type: 'test.askAge',
  category: 'telegram',
  meta: { labelKey: 'test.askAge' },
  ports: { inputs: ['main'], outputs: ['reply', 'timeout', 'invalid'] },
  paramsSchema: (await import('zod')).z.looseObject({}),
  async execute() {
    return wait({
      kind: 'reply',
      nodeId: 'UNSET',
      expect: 'number',
      validation: { min: 1, max: 120 },
      invalidMessage: 'عدد بین ۱ تا ۱۲۰ بفرست',
      retriesLeft: 2,
      timeoutAt: '2026-06-10T12:00:00.000Z',
    });
  },
};

/** test.save — stores reply.value into $vars[name]. */
const saveNode: NodeDef<{ name: string }> = {
  type: 'test.save',
  category: 'data',
  meta: { labelKey: 'test.save' },
  ports: { inputs: ['main'], outputs: ['main'] },
  paramsSchema: (await import('zod')).z.object({ name: (await import('zod')).z.string() }),
  async execute(ctx, params, items) {
    const json = items[0]?.json ?? {};
    const reply = json['reply'] as { value?: unknown } | undefined;
    ctx.vars.set(params.name, reply !== undefined ? reply.value : json['timedOut']);
    return out({ main: items });
  },
};

const endNode: NodeDef<Record<string, never>> = {
  type: 'test.end',
  category: 'flow',
  meta: { labelKey: 'test.end' },
  ports: { inputs: ['main'], outputs: [] },
  paramsSchema: (await import('zod')).z.object({}),
  async execute() {
    return end();
  },
};

// ── graph: /start → askAge(wait) → save → end; invalid/timeout → save too ────

const GRAPH: FlowGraph = {
  nodes: [
    { id: 'trig', type: 'tg.trigger', params: { event: 'command', command: 'start' }, position: { x: 0, y: 0 }, disabled: false },
    { id: 'ask', type: 'test.askAge', params: {}, position: { x: 0, y: 0 }, disabled: false },
    { id: 'save', type: 'test.save', params: { name: 'age' }, position: { x: 0, y: 0 }, disabled: false },
    { id: 'saveInvalid', type: 'test.save', params: { name: 'gaveUp' }, position: { x: 0, y: 0 }, disabled: false },
    { id: 'saveTimeout', type: 'test.save', params: { name: 'timedOut' }, position: { x: 0, y: 0 }, disabled: false },
    { id: 'fin', type: 'test.end', params: {}, position: { x: 0, y: 0 }, disabled: false },
  ],
  edges: [
    { id: 'e0', from: { node: 'trig', port: 'main' }, to: { node: 'ask', port: 'main' } },
    { id: 'e1', from: { node: 'ask', port: 'reply' }, to: { node: 'save', port: 'main' } },
    { id: 'e2', from: { node: 'ask', port: 'invalid' }, to: { node: 'saveInvalid', port: 'main' } },
    { id: 'e3', from: { node: 'ask', port: 'timeout' }, to: { node: 'saveTimeout', port: 'main' } },
    { id: 'e4', from: { node: 'save', port: 'main' }, to: { node: 'fin', port: 'main' } },
    { id: 'e5', from: { node: 'saveInvalid', port: 'main' }, to: { node: 'fin', port: 'main' } },
    { id: 'e6', from: { node: 'saveTimeout', port: 'main' }, to: { node: 'fin', port: 'main' } },
  ],
};

// ── harness ──────────────────────────────────────────────────────────────────

function makeHarness() {
  const store = new MemoryExecutionStore();
  const registry = new NodeRegistry()
    .register(triggerNode)
    .register(askAgeNode)
    .register(saveNode)
    .register(endNode);
  const services: ExecutorServices = {
    kv: { get: async () => undefined, set: async () => undefined, delete: async () => undefined },
    http: { request: async () => ({ status: 200, headers: {}, body: null }) },
    tg: () => null,
  };
  const executor = new Executor(registry, store, services);
  const flow = { id: 'f1', name: 'سن‌پرس', graph: GRAPH };
  const flows: FlowSource = {
    activeFlows: async (botId) => (botId === 'b1' ? [flow] : []),
    getFlow: async (id) => (id === 'f1' ? flow : null),
  };
  const sent: Array<{ chatId: number; text: string }> = [];
  let n = 0;
  const router = new UpdateRouter({
    store,
    executor,
    flows,
    sendText: async (_botId, chatId, text) => {
      sent.push({ chatId, text });
    },
    newId: () => `exec-${++n}`,
  });
  return { store, router, sent };
}

function ev(text: string, chatId = 7, updateId = 1): TgEvent {
  const update = {
    update_id: updateId,
    message: {
      message_id: 10,
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

// ── tests ────────────────────────────────────────────────────────────────────

describe('UpdateRouter (P1-T6)', () => {
  it('trigger starts an execution that pauses at the wait node', async () => {
    const { router, store } = makeHarness();
    await router.handle(ev('/start'));
    const waiting = await store.findWaiting({ botId: 'b1', chatId: 7 });
    expect(waiting).toHaveLength(1);
    expect(waiting[0]!.wait).toMatchObject({ kind: 'reply', nodeId: 'ask', expect: 'number' });
  });

  it('unmatched events are dropped (no execution)', async () => {
    const { router, store } = makeHarness();
    await router.handle(ev('سلام')); // no any_message trigger in graph
    expect(await store.findWaiting({ botId: 'b1', chatId: 7 })).toHaveLength(0);
  });

  it('valid reply resumes the WAITING execution — does NOT start a new one', async () => {
    const { router, store } = makeHarness();
    await router.handle(ev('/start'));
    const [waitingExec] = await store.findWaiting({ botId: 'b1', chatId: 7 });

    await router.handle(ev('۳۵', 7, 2)); // Persian digits accepted
    const done = await store.load(waitingExec!.id);
    expect(done!.status).toBe('done');
    expect(done!.state.vars['age']).toBe(35);
    // nothing new is waiting — the reply was consumed, not re-triggered
    expect(await store.findWaiting({ botId: 'b1', chatId: 7 })).toHaveLength(0);
  });

  it('validation failure re-prompts and stays waiting; retries decrement durably', async () => {
    const { router, store, sent } = makeHarness();
    await router.handle(ev('/start'));
    const [exec] = await store.findWaiting({ botId: 'b1', chatId: 7 });

    await router.handle(ev('متن نامربوط', 7, 2)); // not a number
    expect(sent).toEqual([{ chatId: 7, text: 'عدد بین ۱ تا ۱۲۰ بفرست' }]);
    let fresh = await store.load(exec!.id);
    expect(fresh!.status).toBe('waiting');
    expect(fresh!.wait).toMatchObject({ kind: 'reply', retriesLeft: 1 });

    await router.handle(ev('999', 7, 3)); // out of range
    fresh = await store.load(exec!.id);
    expect(fresh!.status).toBe('waiting');
    expect(fresh!.wait).toMatchObject({ retriesLeft: 0 });
    expect(sent).toHaveLength(2);

    // third failure → retries exhausted → "invalid" port
    await router.handle(ev('باز هم متن', 7, 4));
    fresh = await store.load(exec!.id);
    expect(fresh!.status).toBe('done');
    expect(fresh!.state.vars['gaveUp']).toBeNull(); // value=null on invalid path
    expect(sent).toHaveLength(2); // no extra re-prompt on the final failure
  });

  it('timeout scanner fires the `timeout` port on overdue waits', async () => {
    const { router, store } = makeHarness();
    await router.handle(ev('/start'));
    const [exec] = await store.findWaiting({ botId: 'b1', chatId: 7 });

    // before the deadline: nothing happens
    expect(await router.scanTimeouts(new Date('2026-06-10T11:00:00Z'))).toBe(0);
    expect((await store.load(exec!.id))!.status).toBe('waiting');

    // after the deadline: resumed via timeout port
    expect(await router.scanTimeouts(new Date('2026-06-10T12:00:01Z'))).toBe(1);
    const done = await store.load(exec!.id);
    expect(done!.status).toBe('done');
    expect(done!.state.vars['timedOut']).toBe(true);
  });

  it('two chats run independently — replies never cross', async () => {
    const { router, store } = makeHarness();
    await router.handle(ev('/start', 7));
    await router.handle(ev('/start', 8));
    expect(await store.findWaiting({ botId: 'b1', chatId: 7 })).toHaveLength(1);
    expect(await store.findWaiting({ botId: 'b1', chatId: 8 })).toHaveLength(1);

    await router.handle(ev('40', 8, 2)); // chat 8 answers first
    expect(await store.findWaiting({ botId: 'b1', chatId: 8 })).toHaveLength(0);
    expect(await store.findWaiting({ botId: 'b1', chatId: 7 })).toHaveLength(1); // chat 7 untouched

    await router.handle(ev('25', 7, 3));
    expect(await store.findWaiting({ botId: 'b1', chatId: 7 })).toHaveLength(0);
  });

  it('/cancel cancels the waiting conversation', async () => {
    const { router, store } = makeHarness();
    await router.handle(ev('/start'));
    const [exec] = await store.findWaiting({ botId: 'b1', chatId: 7 });

    await router.handle(ev('/cancel', 7, 2));
    const fresh = await store.load(exec!.id);
    expect(fresh!.status).toBe('canceled');
    expect(await store.findWaiting({ botId: 'b1', chatId: 7 })).toHaveLength(0);
  });

  it('concurrent updates for the same chat are serialized (per-chat mutex)', async () => {
    const { router, store } = makeHarness();
    await router.handle(ev('/start'));
    // two replies race; exactly one consumes the wait, the other is dropped
    await Promise.all([router.handle(ev('30', 7, 2)), router.handle(ev('31', 7, 3))]);
    const all = await store.findWaiting({ botId: 'b1', chatId: 7 });
    expect(all).toHaveLength(0);
    // only ONE execution ever existed (the dropped reply didn't trigger anything)
    const done = await store.load('exec-1');
    expect(done!.status).toBe('done');
    expect([30, 31]).toContain(done!.state.vars['age']);
  });
});
