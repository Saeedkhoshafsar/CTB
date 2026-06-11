/**
 * P1-T7 end-to-end: the REAL wave-1 nodes drive the shared sample-flow
 * fixture (ask name → ask age (validated, 2 retries) → IF → greet) through
 * the real UpdateRouter + Executor + MemoryExecutionStore with a fake
 * Telegram sender. Covers PLAN acceptance: prompt sent, expect=number
 * validation, retries → invalid port, save_to writes $vars — plus the
 * durability headline: a fresh executor/router over the same store resumes
 * the conversation (simulated restart).
 */
import { Executor, MemoryExecutionStore, NodeRegistry, type ExecutorServices } from '@ctb/core';
import { registerBuiltinNodes } from '@ctb/nodes';
import { destroyDefaultSandboxPool } from '@ctb/sandbox';
import { FlowGraphSchema, type FlowGraph } from '@ctb/shared';
import type { Update } from 'grammy/types';
import { readFileSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import { UpdateRouter, type FlowSource } from '../src/engine/router';
import { normalizeUpdate, type TgEvent } from '../src/telegram/normalize';

afterAll(async () => {
  await destroyDefaultSandboxPool();
});

const GRAPH: FlowGraph = FlowGraphSchema.parse(
  JSON.parse(
    readFileSync(new URL('../../../packages/shared/test/fixtures/sample-flow.json', import.meta.url), 'utf8'),
  ),
);

interface Sent {
  chatId: number;
  text: string;
}

function makeWorld(store = new MemoryExecutionStore()) {
  const sent: Sent[] = [];
  const registry = registerBuiltinNodes(new NodeRegistry());
  const services: ExecutorServices = {
    kv: { get: async () => undefined, set: async () => undefined, delete: async () => undefined },
    http: { request: async () => ({ status: 200, headers: {}, body: null }) },
    tg: () => ({
      async sendMessage(opts) {
        sent.push({ chatId: opts.chat_id as number, text: (opts.text as string) ?? '' });
        return { messageId: sent.length };
      },
    }),
  };
  const executor = new Executor(registry, store, services);
  const flow = { id: 'f1', name: 'خوش‌آمد', graph: GRAPH };
  const flows: FlowSource = {
    activeFlows: async () => [flow],
    getFlow: async (id) => (id === 'f1' ? flow : null),
  };
  let n = 0;
  const router = new UpdateRouter({
    store,
    executor,
    flows,
    sendText: async (_b, chatId, text) => {
      sent.push({ chatId, text });
    },
    newId: () => `exec-${++n}`,
  });
  return { store, router, sent };
}

function ev(text: string, updateId: number, chatId = 7): TgEvent {
  const update = {
    update_id: updateId,
    message: {
      message_id: updateId * 10,
      date: 0,
      from: { id: 900, is_bot: false, first_name: 'علی' },
      chat: { id: chatId, type: 'private', first_name: 'علی' },
      text,
    },
  } as unknown as Update;
  const event = normalizeUpdate('b1', update);
  if (!event) throw new Error('unsupported fixture update');
  return event;
}

describe('P1-T7 e2e — sample flow on real nodes', () => {
  it('happy path: /start → name → age → IF(true) → greet with both $vars', async () => {
    const { router, store, sent } = makeWorld();

    await router.handle(ev('/start', 1));
    expect(sent.at(-1)).toEqual({ chatId: 7, text: 'سلام! اسمت چیه؟' });

    await router.handle(ev('علی', 2));
    // prompt expression resolved against $vars.name saved by the router (saveTo)
    expect(sent.at(-1)).toEqual({ chatId: 7, text: 'چند سالته علی؟' });

    await router.handle(ev('۳۵', 3)); // Persian digits
    expect(sent.at(-1)).toEqual({ chatId: 7, text: 'سلام علی، 35 ساله! خوش اومدی 🎉' });

    const all = await store.findWaiting({ botId: 'b1', chatId: 7 });
    expect(all).toHaveLength(0);
    const done = (await store.load('exec-1'))!;
    expect(done.status).toBe('done');
    expect(done.state.vars).toMatchObject({ name: 'علی', age: 35 });
  });

  it('minor branch: age < 18 routes through IF false port', async () => {
    const { router, sent } = makeWorld();
    await router.handle(ev('/start', 1));
    await router.handle(ev('سارا', 2));
    await router.handle(ev('12', 3));
    expect(sent.at(-1)).toEqual({ chatId: 7, text: 'سلام سارا! 👋' });
  });

  it('validation: re-prompts twice then retries exhausted → invalid port → flow.stopError', async () => {
    const { router, store, sent } = makeWorld();
    await router.handle(ev('/start', 1));
    await router.handle(ev('علی', 2));

    await router.handle(ev('abc', 3)); // not a number → retry 1
    expect(sent.at(-1)).toEqual({ chatId: 7, text: 'یه عدد بین ۱ تا ۱۲۰ بفرست' });
    await router.handle(ev('999', 4)); // out of range → retry 2
    expect(sent.at(-1)).toEqual({ chatId: 7, text: 'یه عدد بین ۱ تا ۱۲۰ بفرست' });

    await router.handle(ev('هنوز اشتباه', 5)); // retries exhausted → invalid port
    const exec = (await store.load('exec-1'))!;
    expect(exec.status).toBe('error');
    expect(exec.error).toContain('سن نامعتبر بعد از چند تلاش');
    // notify_user=false in the fixture → no extra message after the re-prompts
    expect(sent.at(-1)).toEqual({ chatId: 7, text: 'یه عدد بین ۱ تا ۱۲۰ بفرست' });
  });

  it('durability (I4): restart mid-conversation — fresh world over the same store resumes', async () => {
    const store = new MemoryExecutionStore();
    const w1 = makeWorld(store);
    await w1.router.handle(ev('/start', 1));
    await w1.router.handle(ev('علی', 2)); // now waiting at ask_age

    // "kill the server": brand-new registry/executor/router, same store
    const w2 = makeWorld(store);
    await w2.router.handle(ev('40', 3));
    expect(w2.sent.at(-1)).toEqual({ chatId: 7, text: 'سلام علی، 40 ساله! خوش اومدی 🎉' });
    const done = (await store.load('exec-1'))!;
    expect(done.status).toBe('done');
    expect(done.state.vars).toMatchObject({ name: 'علی', age: 40 });
  });

  it('waitForReply stamps a future timeoutAt from its duration param', async () => {
    const { router, store } = makeWorld();
    await router.handle(ev('/start', 1));
    const [waiting] = await store.findWaiting({ botId: 'b1', chatId: 7 });
    const wait = waiting!.wait!;
    if (wait.kind !== 'reply') throw new Error('expected reply wait');
    expect(wait.timeoutAt).not.toBeNull(); // ask_name has timeout: "1d"
    expect(Date.parse(wait.timeoutAt!)).toBeGreaterThan(Date.now() + 23 * 3_600_000);
  });
});
