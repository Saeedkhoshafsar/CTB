/**
 * Executor loop tests — P1-T4 acceptance criteria:
 *  linear flow · branching (2 ports) · GOTO · WAIT suspends → resume()
 *  continues from the exact node · maxSteps abort · error path logs.
 * Plus the I4-mandated pause/resume serialization round-trip.
 */
import { destroyDefaultSandboxPool } from '@ctb/sandbox';
import { afterAll, describe, expect, it } from 'vitest';
import { FLOW, graph, item, makeHarness } from './executor-fakes';

afterAll(async () => {
  await destroyDefaultSandboxPool();
});

describe('executor — linear flow', () => {
  it('runs A→B→C, threads items through, finishes done', async () => {
    const { executor, store } = makeHarness();
    const g = graph(
      [
        { id: 'a', type: 'test.emit', params: { tag: 'A' } },
        { id: 'b', type: 'test.emit', params: { tag: 'B' } },
        { id: 'c', type: 'test.emit', params: { tag: 'C' } },
      ],
      [['a', 'b'], ['b', 'c']],
    );
    const res = await executor.start({
      executionId: 'e1', flow: FLOW, graph: g, botId: 'bot1', chatId: 5,
      entry: { nodeId: 'a', items: { main: [item({})] } },
    });
    expect(res.status).toBe('done');
    expect(res.steps).toBe(3);
    const exec = await store.load('e1');
    expect(exec!.status).toBe('done');
    expect(exec!.state.cursor).toBeNull();
  });

  it('disabled node passes items through untouched', async () => {
    const { executor, store } = makeHarness();
    const g = graph(
      [
        { id: 'a', type: 'test.emit', params: { tag: 'A' } },
        { id: 'skip', type: 'test.boom', disabled: true }, // would throw if executed
        { id: 'save', type: 'test.saveVar', params: { name: 'trail', from: 'trail' } },
      ],
      [['a', 'skip'], ['skip', 'save']],
    );
    const res = await executor.start({
      executionId: 'e1', flow: FLOW, graph: g, botId: 'b',
      entry: { nodeId: 'a', items: { main: [item({})] } },
    });
    expect(res.status).toBe('done');
    const exec = await store.load('e1');
    expect(exec!.state.vars.trail).toEqual(['A']);
  });

  it('params with {{ }} expressions are resolved against $json before Zod', async () => {
    const { executor, store } = makeHarness();
    const g = graph(
      [
        { id: 'a', type: 'test.emit', params: { tag: 'سلام-{{$json.name}}' } },
        { id: 'save', type: 'test.saveVar', params: { name: 'trail', from: 'trail' } },
      ],
      [['a', 'save']],
    );
    const res = await executor.start({
      executionId: 'e1', flow: FLOW, graph: g, botId: 'b',
      entry: { nodeId: 'a', items: { main: [item({ name: 'علی' })] } },
    });
    expect(res.status).toBe('done');
    const exec = await store.load('e1');
    expect(exec!.state.vars.trail).toEqual(['سلام-علی']);
  });
});

describe('executor — branching', () => {
  const branchGraph = () =>
    graph(
      [
        { id: 'br', type: 'test.branch', params: { field: 'vip' } },
        { id: 'yes', type: 'test.emit', params: { tag: 'VIP' } },
        { id: 'no', type: 'test.emit', params: { tag: 'NORMAL' } },
        { id: 'saveY', type: 'test.saveVar', params: { name: 'got', from: 'trail' } },
        { id: 'saveN', type: 'test.saveVar', params: { name: 'got', from: 'trail' } },
      ],
      [
        ['br', 'yes', 'true'],
        ['br', 'no', 'false'],
        ['yes', 'saveY'],
        ['no', 'saveN'],
      ],
    );

  it('routes items out the matching port only (true side)', async () => {
    const { executor, store } = makeHarness();
    const res = await executor.start({
      executionId: 'e1', flow: FLOW, graph: branchGraph(), botId: 'b',
      entry: { nodeId: 'br', items: { main: [item({ vip: true })] } },
    });
    expect(res.status).toBe('done');
    const exec = await store.load('e1');
    expect(exec!.state.vars.got).toEqual(['VIP']);
    expect(res.steps).toBe(3); // br + yes + saveY — the false subtree never ran
  });

  it('fan-out: items on BOTH ports run both branches to completion', async () => {
    const { executor, logs } = makeHarness();
    const res = await executor.start({
      executionId: 'e1', flow: FLOW, graph: branchGraph(), botId: 'b',
      entry: { nodeId: 'br', items: { main: [item({ vip: true }), item({ vip: false })] } },
    });
    expect(res.status).toBe('done');
    expect(res.steps).toBe(5); // br + yes + no + saveY + saveN
    const executed = logs.filter((l) => l.message.startsWith('executed')).length;
    expect(executed).toBe(5);
  });
});

describe('executor — GOTO', () => {
  it('jumps to the target node with items on main', async () => {
    const { executor, store } = makeHarness();
    const g = graph(
      [
        { id: 'a', type: 'test.emit', params: { tag: 'A' } },
        { id: 'jump', type: 'test.goto', params: { target: 'landing' } },
        { id: 'landing', type: 'test.emit', params: { tag: 'LANDED' } },
        { id: 'save', type: 'test.saveVar', params: { name: 'trail', from: 'trail' } },
      ],
      [['a', 'jump'], ['landing', 'save']], // NOTE: no edge jump→landing; goto does it
    );
    const res = await executor.start({
      executionId: 'e1', flow: FLOW, graph: g, botId: 'b',
      entry: { nodeId: 'a', items: { main: [item({})] } },
    });
    expect(res.status).toBe('done');
    const exec = await store.load('e1');
    expect(exec!.state.vars.trail).toEqual(['A', 'LANDED']);
  });

  it('goto to an unknown node → execution errors cleanly', async () => {
    const { executor, store } = makeHarness();
    const g = graph([{ id: 'jump', type: 'test.goto', params: { target: 'ghost' } }], []);
    const res = await executor.start({
      executionId: 'e1', flow: FLOW, graph: g, botId: 'b',
      entry: { nodeId: 'jump', items: { main: [item({})] } },
    });
    expect(res.status).toBe('error');
    expect(res.error).toMatch(/unknown node "ghost"/);
    expect((await store.load('e1'))!.status).toBe('error');
  });
});
