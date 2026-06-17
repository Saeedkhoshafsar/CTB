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

  it('provider node parked on the cursor is skipped, never run as a data step (PB-T1)', async () => {
    const { executor, store, logs } = makeHarness();
    // A malformed graph routes data INTO a provider (the dashed slot edge is the
    // only legitimate wire). The executor must NOT call its execute() — which
    // would throw — and instead end the branch quietly.
    const g = graph(
      [
        { id: 'a', type: 'test.emit', params: { tag: 'A' } },
        { id: 'model', type: 'test.provider' }, // execute() throws if reached
        { id: 'after', type: 'test.emit', params: { tag: 'AFTER' } },
      ],
      [['a', 'model'], ['model', 'after']],
    );
    const res = await executor.start({
      executionId: 'e1', flow: FLOW, graph: g, botId: 'b',
      entry: { nodeId: 'a', items: { main: [item({})] } },
    });
    // run completes cleanly (no throw); provider emitted nothing so the branch
    // stops there — "after" is never reached.
    expect(res.status).toBe('done');
    const exec = await store.load('e1');
    expect(exec!.status).toBe('done');
    expect(logs.some((l) => /provider node "model" is not a data step/.test(l.message))).toBe(true);
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

describe('executor — step-log I/O snapshots (P2-T3.5, editor NDV data)', () => {
  it('"executed" rows carry the node input items and per-port output items', async () => {
    const { executor, logs } = makeHarness();
    const g = graph(
      [
        { id: 'a', type: 'test.emit', params: { tag: 'A' } },
        { id: 'br', type: 'test.branch', params: { field: 'vip' } },
      ],
      [['a', 'br']],
    );
    await executor.start({
      executionId: 'e1', flow: FLOW, graph: g, botId: 'b',
      entry: { nodeId: 'a', items: { main: [item({ vip: true })] } },
    });
    const rows = logs.filter((l) => l.message.startsWith('executed'));
    expect(rows).toHaveLength(2);

    const aRow = rows[0]!;
    expect(aRow.nodeId).toBe('a');
    expect(aRow.input).toEqual([{ json: { vip: true } }]);
    expect(aRow.output).toEqual({ main: [{ json: { vip: true, trail: ['A'] } }] });
    expect(typeof aRow.durationMs).toBe('number');

    // branch emits ONLY the matched port (empty "false" side omitted)
    const brRow = rows[1]!;
    expect(brRow.nodeId).toBe('br');
    expect(Object.keys(brRow.output!)).toEqual(['true']);
  });

  it('logged items are capped at LOG_ITEMS_CAP per port', async () => {
    const { executor, logs } = makeHarness();
    const g = graph([{ id: 'a', type: 'test.emit', params: { tag: 'A' } }], []);
    const many = Array.from({ length: 50 }, (_, i) => item({ i }));
    await executor.start({
      executionId: 'e1', flow: FLOW, graph: g, botId: 'b',
      entry: { nodeId: 'a', items: { main: many } },
    });
    const row = logs.find((l) => l.message.startsWith('executed'))!;
    expect(row.input!.length).toBe(20);
    expect(row.output!.main!.length).toBe(20);
  });
});
