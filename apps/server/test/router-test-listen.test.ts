/**
 * J-T1 (Report B) — live-trigger "listen for one update" router integration.
 *
 * Proves the router's test-listen path (UpdateRouter.tryResumeListen):
 *   1. an armed `tg.trigger` listen (a durable WaitSpec{kind:'trigger'}) is
 *      resumed by the NEXT matching live update, and the REAL trigger item
 *      (sender id/name/text) flows to the downstream node;
 *   2. exactly-once: that same update does NOT also start a production run, and
 *      a SECOND update no longer matches the (now consumed) arming;
 *   3. a non-matching update does NOT consume the arming;
 *   4. the arming survives a simulated process restart (a fresh Executor over
 *      the SAME store still gets resumed by the router);
 *   5. a normal production trigger run is unchanged by the new path.
 *
 * Mirrors the in-memory harness of router.test.ts (no real DB / Telegram).
 */
import {
  Executor,
  MemoryExecutionStore,
  NodeRegistry,
  type ExecutorServices,
} from '@ctb/core';
import { destroyDefaultSandboxPool } from '@ctb/sandbox';
import { defaultFlowSettings, out, type FlowGraph, type NodeDef } from '@ctb/shared';
import type { Update } from 'grammy/types';
import { afterAll, describe, expect, it } from 'vitest';
import { UpdateRouter, type FlowSource } from '../src/engine/router';
import { normalizeUpdate, type TgEvent } from '../src/telegram/normalize';

afterAll(async () => {
  await destroyDefaultSandboxPool();
});

/** tg.trigger — entry node: passes its trigger item through on `main`. */
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

/** test.capture — records each item's json into a shared sink + $vars. */
const captureSink: Array<Record<string, unknown>> = [];
const captureNode: NodeDef<Record<string, never>> = {
  type: 'test.capture',
  category: 'data',
  meta: { labelKey: 'test.capture' },
  ports: { inputs: ['main'], outputs: ['main'] },
  paramsSchema: (await import('zod')).z.object({}),
  async execute(ctx, _params, items) {
    for (const i of items) {
      captureSink.push(i.json);
      ctx.vars.set('captured', i.json);
    }
    return out({ main: items });
  },
};

// graph: tg.trigger(any_message) → capture
const GRAPH: FlowGraph = {
  nodes: [
    { id: 'trig', type: 'tg.trigger', params: { event: 'any_message' }, position: { x: 0, y: 0 }, disabled: false },
    { id: 'cap', type: 'test.capture', params: {}, position: { x: 0, y: 0 }, disabled: false },
  ],
  edges: [{ id: 'e0', from: { node: 'trig', port: 'main' }, to: { node: 'cap', port: 'main' } }],
};

function makeRegistry(): NodeRegistry {
  return new NodeRegistry().register(triggerNode).register(captureNode);
}

function makeServices(): ExecutorServices {
  return {
    kv: () => ({ get: async () => undefined, set: async () => undefined, delete: async () => undefined }),
    http: { request: async () => ({ status: 200, headers: {}, body: null }) },
    tg: () => null,
  };
}

function makeHarness() {
  captureSink.length = 0;
  const store = new MemoryExecutionStore();
  const executor = new Executor(makeRegistry(), store, makeServices());
  const flow = { id: 'f1', name: 'گوش‌دادن', graph: GRAPH, settings: defaultFlowSettings() };
  const flows: FlowSource = {
    activeFlows: async (botId) => (botId === 'b1' ? [flow] : []),
    getFlow: async (id) => (id === 'f1' ? flow : null),
  };
  let n = 0;
  const router = new UpdateRouter({
    store,
    executor,
    flows,
    sendText: async () => undefined,
    newId: () => `prod-${++n}`,
  });
  return { store, executor, router, flow };
}

/** Arm a listen exactly as the test-listen endpoint does. */
async function arm(
  executor: Executor,
  flow: { id: string; name: string; graph: FlowGraph },
  triggerParams: Record<string, unknown>,
  timeoutAt: string | null = null,
): Promise<string> {
  const executionId = 'listen-1';
  await executor.start({
    executionId,
    flow: { id: flow.id, name: flow.name },
    graph: flow.graph,
    botId: 'b1',
    chatId: null,
    userId: null,
    entry: { nodeId: 'trig', items: { main: [] } },
    listenMode: { triggerParams, timeoutAt },
  });
  return executionId;
}

function ev(text: string, chatId = 7, updateId = 1): TgEvent {
  const update = {
    update_id: updateId,
    message: {
      message_id: 10,
      date: 0,
      from: { id: 100 + chatId, is_bot: false, first_name: 'سارا' },
      chat: { id: chatId, type: 'private', first_name: 'سارا' },
      text,
    },
  } as unknown as Update;
  const event = normalizeUpdate('b1', update);
  if (!event) throw new Error('fixture produced unsupported update');
  return event;
}

describe('UpdateRouter — listen for one live update (J-T1)', () => {
  it('the next matching update resumes the armed trigger; sender data flows downstream', async () => {
    const { store, executor, router } = makeHarness();
    const id = await arm(executor, { id: 'f1', name: 'گوش‌دادن', graph: GRAPH }, { event: 'any_message' });
    // armed: a durable trigger-wait, chatless, waiting for the first message
    const armed = await store.findListening('b1');
    expect(armed).toHaveLength(1);
    expect(armed[0]!.id).toBe(id);

    await router.handle(ev('سلام ربات'));

    // the capture node received the REAL trigger item (sender + text)
    expect(captureSink).toHaveLength(1);
    expect(captureSink[0]!.text).toBe('سلام ربات');
    expect((captureSink[0]!.user as { id: number }).id).toBe(107);
    // the armed listen is consumed (resumed → no longer listening)
    expect(await store.findListening('b1')).toHaveLength(0);
    const exec = await store.load(id);
    expect(exec!.status).toBe('done');
  });

  it('exactly-once: the captured update does NOT also start a production run, and a 2nd update does not match', async () => {
    const { store, executor, router } = makeHarness();
    await arm(executor, { id: 'f1', name: 'گوش‌دادن', graph: GRAPH }, { event: 'any_message' });

    await router.handle(ev('اولین', 7, 1));
    // only the listen execution exists — no second (production) execution started
    expect(captureSink).toHaveLength(1);
    const after1 = await store.findListening('b1');
    expect(after1).toHaveLength(0);

    // a SECOND update: the arming is gone, so the test listen can't re-capture.
    // It now flows to the normal trigger path → a production run starts (which
    // also runs `capture`), proving the listen consumed exactly one update.
    await router.handle(ev('دومین', 7, 2));
    expect(captureSink).toHaveLength(2);
    expect(captureSink[1]!.text).toBe('دومین');
    // the production run is a separate, non-listening execution
    const prod = await store.load('prod-1');
    expect(prod).toBeTruthy();
    expect(prod!.state.listening).toBeUndefined();
  });

  it('a non-matching update does NOT consume the arming', async () => {
    const { store, executor, router } = makeHarness();
    // arm for a SPECIFIC command only
    await arm(executor, { id: 'f1', name: 'گوش‌دادن', graph: GRAPH }, { event: 'command', command: 'start' });

    // a plain text message does not match `command:start` → arming untouched
    await router.handle(ev('یک پیام معمولی'));
    expect(await store.findListening('b1')).toHaveLength(1);

    // the matching /start command now captures it
    await router.handle(commandEv('/start'));
    expect(await store.findListening('b1')).toHaveLength(0);
    expect(captureSink.at(-1)!.command).toBe('start');
  });

  it('the arming survives a simulated process restart (I4): a fresh Executor + router resumes it', async () => {
    const { store, executor } = makeHarness();
    await arm(executor, { id: 'f1', name: 'گوش‌دادن', graph: GRAPH }, { event: 'any_message' });

    // simulate a restart: brand-new Executor + UpdateRouter over the SAME store
    const flow = { id: 'f1', name: 'گوش‌دادن', graph: GRAPH, settings: defaultFlowSettings() };
    const flows: FlowSource = {
      activeFlows: async () => [flow],
      getFlow: async (fid) => (fid === 'f1' ? flow : null),
    };
    const revivedExecutor = new Executor(makeRegistry(), store, makeServices());
    const revivedRouter = new UpdateRouter({
      store, executor: revivedExecutor, flows, sendText: async () => undefined, newId: () => 'prod-x',
    });
    // still armed after the "restart"
    expect(await store.findListening('b1')).toHaveLength(1);

    await revivedRouter.handle(ev('بعد از ری‌استارت'));
    expect(captureSink.at(-1)!.text).toBe('بعد از ری‌استارت');
    expect(await store.findListening('b1')).toHaveLength(0);
  });

  it('a normal production trigger run is unaffected (no arming → fires immediately)', async () => {
    const { store, router } = makeHarness();
    // no arm() — a fresh message just runs the flow in production
    await router.handle(ev('بدون گوش‌دادن'));
    expect(captureSink).toHaveLength(1);
    expect(captureSink[0]!.text).toBe('بدون گوش‌دادن');
    const prod = await store.load('prod-1');
    expect(prod!.state.listening).toBeUndefined();
    expect(prod!.status).toBe('done');
  });
});

function commandEv(text: string, chatId = 7, updateId = 1): TgEvent {
  const update = {
    update_id: updateId,
    message: {
      message_id: 11,
      date: 0,
      from: { id: 100 + chatId, is_bot: false, first_name: 'سارا' },
      chat: { id: chatId, type: 'private', first_name: 'سارا' },
      text,
      entities: [{ type: 'bot_command', offset: 0, length: text.length }],
    },
  } as unknown as Update;
  const event = normalizeUpdate('b1', update);
  if (!event) throw new Error('fixture produced unsupported command update');
  return event;
}
