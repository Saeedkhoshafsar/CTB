/**
 * Executor WAIT/resume + safety tests — P1-T4 acceptance:
 *  WAIT suspends → resume(executionId, items) continues from the EXACT node;
 *  I4 serialization round-trip across a simulated process restart;
 *  maxSteps abort; error paths emit log entries.
 */
import { destroyDefaultSandboxPool } from '@ctb/sandbox';
import { afterAll, describe, expect, it } from 'vitest';
import { Executor } from '../src/engine/executor';
import { FLOW, graph, item, makeHarness, makeRegistry } from './executor-fakes';

afterAll(async () => {
  await destroyDefaultSandboxPool();
});

/** ask name → save → ask age → save → end (the canonical CTB conversation) */
const conversationGraph = () =>
  graph(
    [
      { id: 'askName', type: 'test.ask', params: { question: 'اسمت چیه؟' } },
      { id: 'saveName', type: 'test.saveVar', params: { name: 'name', from: 'text' } },
      { id: 'askAge', type: 'test.ask', params: { question: 'چند سالته؟' } },
      { id: 'saveAge', type: 'test.saveVar', params: { name: 'age', from: 'text' } },
      { id: 'fin', type: 'test.end' },
    ],
    [
      ['askName', 'saveName', 'reply'],
      ['saveName', 'askAge'],
      ['askAge', 'saveAge', 'reply'],
      ['saveAge', 'fin'],
    ],
  );

describe('executor — WAIT / resume (the heart of CTB, invariant I4)', () => {
  it('WAIT suspends; resume() continues from the exact node; vars survive', async () => {
    const { executor, store } = makeHarness();
    const g = conversationGraph();

    // 1) start → suspends at askName
    const r1 = await executor.start({
      executionId: 'e1', flow: FLOW, graph: g, botId: 'bot1', chatId: 7,
      entry: { nodeId: 'askName', items: { main: [item({})] } },
    });
    expect(r1.status).toBe('waiting');
    expect(r1.wait).toMatchObject({ kind: 'reply', nodeId: 'askName' }); // executor stamped nodeId
    expect((await store.findWaiting({ botId: 'bot1', chatId: 7 })).map((e) => e.id)).toEqual(['e1']);

    // 2) user answers "علی" → resumes, saves, suspends again at askAge
    const r2 = await executor.resume({
      executionId: 'e1', flow: FLOW, graph: g, port: 'reply', items: [item({ text: 'علی' })],
    });
    expect(r2.status).toBe('waiting');
    expect(r2.wait!.nodeId).toBe('askAge');

    // 3) user answers "30" → flow completes
    const r3 = await executor.resume({
      executionId: 'e1', flow: FLOW, graph: g, port: 'reply', items: [item({ text: '30' })],
    });
    expect(r3.status).toBe('done');

    const exec = await store.load('e1');
    expect(exec!.status).toBe('done');
    expect(exec!.state.vars).toMatchObject({ name: 'علی', age: '30' });
    expect(exec!.wait).toBeNull();
  });

  it('I4 round-trip: waiting state survives JSON serialization + a FRESH executor resumes from the store alone', async () => {
    const { executor, store, logs } = makeHarness();
    const g = conversationGraph();
    await executor.start({
      executionId: 'e1', flow: FLOW, graph: g, botId: 'bot1', chatId: 7,
      entry: { nodeId: 'askName', items: { main: [item({ fa: 'متن فارسی', nested: { deep: [1, 2, 3] } })] } },
    });

    // simulate restart: the row must survive a full JSON round-trip intact
    const before = await store.load('e1');
    expect(JSON.parse(JSON.stringify(before))).toEqual(before);

    // brand-new Executor instance (new process) — shares only the store (the DB)
    const fresh = new Executor(makeRegistry(), store, {
      kv: () => ({ get: async () => undefined, set: async () => undefined, delete: async () => undefined }),
      http: { request: async () => ({ status: 200, headers: {}, body: null }) },
      tg: () => null,
      log: (e) => logs.push(e),
    });
    const r = await fresh.resume({
      executionId: 'e1', flow: FLOW, graph: g, port: 'reply', items: [item({ text: 'علی' })],
    });
    expect(r.status).toBe('waiting');
    expect(r.wait!.nodeId).toBe('askAge');
    expect((await store.load('e1'))!.state.vars.name).toBe('علی');
  });

  it('resume routes through a DIFFERENT port (timeout) than reply', async () => {
    const { executor, store } = makeHarness();
    const g = graph(
      [
        { id: 'ask', type: 'test.ask', params: { question: 'q' } },
        { id: 'onReply', type: 'test.saveVar', params: { name: 'got', from: 'text' } },
        { id: 'onTimeout', type: 'test.emit', params: { tag: 'TIMED_OUT' } },
        { id: 'saveT', type: 'test.saveVar', params: { name: 'trail', from: 'trail' } },
      ],
      [
        ['ask', 'onReply', 'reply'],
        ['ask', 'onTimeout', 'timeout'],
        ['onTimeout', 'saveT'],
      ],
    );
    await executor.start({
      executionId: 'e1', flow: FLOW, graph: g, botId: 'b', chatId: 1,
      entry: { nodeId: 'ask', items: { main: [item({})] } },
    });
    const r = await executor.resume({
      executionId: 'e1', flow: FLOW, graph: g, port: 'timeout', items: [item({})],
    });
    expect(r.status).toBe('done');
    expect((await store.load('e1'))!.state.vars.trail).toEqual(['TIMED_OUT']);
  });

  it('resume via an unconnected port ends the conversation gracefully', async () => {
    const { executor, store } = makeHarness();
    const g = graph([{ id: 'ask', type: 'test.ask', params: { question: 'q' } }], []);
    await executor.start({
      executionId: 'e1', flow: FLOW, graph: g, botId: 'b', chatId: 1,
      entry: { nodeId: 'ask', items: { main: [item({})] } },
    });
    const r = await executor.resume({
      executionId: 'e1', flow: FLOW, graph: g, port: 'reply', items: [item({ text: 'hi' })],
    });
    expect(r.status).toBe('done');
    expect((await store.load('e1'))!.status).toBe('done');
  });

  it('resume on a non-waiting execution throws', async () => {
    const { executor } = makeHarness();
    const g = graph([{ id: 'a', type: 'test.emit', params: { tag: 'A' } }], []);
    await executor.start({
      executionId: 'e1', flow: FLOW, graph: g, botId: 'b',
      entry: { nodeId: 'a', items: { main: [item({})] } },
    });
    await expect(
      executor.resume({ executionId: 'e1', flow: FLOW, graph: g, port: 'reply', items: [] }),
    ).rejects.toThrow(/not waiting/);
  });
});

describe('executor — safety & errors', () => {
  it('maxSteps aborts an infinite goto loop with a budget error', async () => {
    const { executor, store } = makeHarness({ maxSteps: 50 });
    const g = graph(
      [
        { id: 'a', type: 'test.goto', params: { target: 'b' } },
        { id: 'b', type: 'test.goto', params: { target: 'a' } },
      ],
      [],
    );
    const res = await executor.start({
      executionId: 'e1', flow: FLOW, graph: g, botId: 'b',
      entry: { nodeId: 'a', items: { main: [item({})] } },
    });
    expect(res.status).toBe('error');
    expect(res.error).toMatch(/maxSteps=50/);
    expect(res.steps).toBe(50);
    expect((await store.load('e1'))!.status).toBe('error');
  });

  it('node throw → status=error, message recorded, error log entry emitted', async () => {
    const { executor, store, logs } = makeHarness();
    const g = graph([{ id: 'x', type: 'test.boom' }], []);
    const res = await executor.start({
      executionId: 'e1', flow: FLOW, graph: g, botId: 'b',
      entry: { nodeId: 'x', items: { main: [item({})] } },
    });
    expect(res.status).toBe('error');
    expect(res.error).toMatch(/node failed at "x": kaboom/);
    const exec = await store.load('e1');
    expect(exec!.status).toBe('error');
    expect(exec!.error).toMatch(/kaboom/);
    expect(logs.some((l) => l.level === 'error' && /kaboom/.test(l.message))).toBe(true);
  });

  it('explicit fail() result → error with node message', async () => {
    const { executor } = makeHarness();
    const g = graph([{ id: 'f', type: 'test.fail', params: { message: 'پرداخت ناموفق' } }], []);
    const res = await executor.start({
      executionId: 'e1', flow: FLOW, graph: g, botId: 'b',
      entry: { nodeId: 'f', items: { main: [item({})] } },
    });
    expect(res.status).toBe('error');
    expect(res.error).toMatch(/پرداخت ناموفق/);
  });

  it('invalid params (Zod) → typed error, run fails before execute()', async () => {
    const { executor } = makeHarness();
    const g = graph([{ id: 'a', type: 'test.emit', params: { tag: 123 } }], []); // tag must be string
    const res = await executor.start({
      executionId: 'e1', flow: FLOW, graph: g, botId: 'b',
      entry: { nodeId: 'a', items: { main: [item({})] } },
    });
    expect(res.status).toBe('error');
    expect(res.error).toMatch(/invalid params for test.emit/);
  });

  it('unknown node type → clean error (registry, not a crash)', async () => {
    const { executor } = makeHarness();
    const g = graph([{ id: 'a', type: 'ghost.node' }], []);
    const res = await executor.start({
      executionId: 'e1', flow: FLOW, graph: g, botId: 'b',
      entry: { nodeId: 'a', items: { main: [item({})] } },
    });
    expect(res.status).toBe('error');
    expect(res.error).toMatch(/unknown node type/);
  });

  it('long chain completes with periodic checkpoints enabled', async () => {
    const { executor, store } = makeHarness({ checkpointEvery: 3, maxSteps: 200 });
    const nodes = Array.from({ length: 10 }, (_, i) => ({
      id: `n${i}`, type: 'test.emit', params: { tag: `t${i}` },
    }));
    const edges = Array.from({ length: 9 }, (_, i) => [`n${i}`, `n${i + 1}`] as [string, string]);
    const res = await executor.start({
      executionId: 'e1', flow: FLOW, graph: graph(nodes, edges), botId: 'b',
      entry: { nodeId: 'n0', items: { main: [item({})] } },
    });
    expect(res.status).toBe('done');
    expect(res.steps).toBe(10);
    expect((await store.load('e1'))!.status).toBe('done');
  });
});
