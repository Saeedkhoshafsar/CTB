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

describe('executor — pinned data (I-T1, gap G4)', () => {
  it('TEST run: a node with pinnedData emits the pin INSTEAD of executing', async () => {
    const { executor, store, logs } = makeHarness();
    // `boom` would throw if executed — pinned data must bypass execution entirely.
    const g = graph(
      [
        { id: 'boom', type: 'test.boom', pinnedData: [item({ name: 'علی', vip: true })] },
        { id: 'save', type: 'test.saveVar', params: { name: 'got', from: 'name' } },
      ],
      [['boom', 'save']],
    );
    const res = await executor.start({
      executionId: 'e1', flow: FLOW, graph: g, botId: 'b',
      entry: { nodeId: 'boom', items: { main: [item({})] } },
      testRun: true,
    });
    expect(res.status).toBe('done');
    const exec = await store.load('e1');
    // the pinned item flowed downstream → save read its `name`
    expect(exec!.state.vars.got).toBe('علی');
    expect(logs.some((l) => /node "boom" using pinned data \(1 item/.test(l.message))).toBe(true);
  });

  it('PRODUCTION run: pinnedData is IGNORED — the node executes normally', async () => {
    const { executor, store } = makeHarness();
    const g = graph(
      // boom throws when executed; in production the pin is ignored so it runs → error
      [{ id: 'boom', type: 'test.boom', pinnedData: [item({ name: 'علی' })] }],
      [],
    );
    const res = await executor.start({
      executionId: 'e1', flow: FLOW, graph: g, botId: 'b',
      entry: { nodeId: 'boom', items: { main: [item({})] } },
      // no testRun flag → production
    });
    expect(res.status).toBe('error');
    expect(res.error).toMatch(/kaboom/);
    expect((await store.load('e1'))!.status).toBe('error');
  });

  it('TEST run: a pin on the entry node feeds downstream stable data', async () => {
    const { executor, store } = makeHarness();
    const g = graph(
      [
        { id: 'src', type: 'test.emit', params: { tag: 'X' }, pinnedData: [item({ trail: ['PINNED'] })] },
        { id: 'save', type: 'test.saveVar', params: { name: 'trail', from: 'trail' } },
      ],
      [['src', 'save']],
    );
    const res = await executor.start({
      executionId: 'e1', flow: FLOW, graph: g, botId: 'b',
      entry: { nodeId: 'src', items: { main: [item({})] } },
      testRun: true,
    });
    expect(res.status).toBe('done');
    const exec = await store.load('e1');
    // emit's normal output would be trail:['X']; the pin replaced it
    expect(exec!.state.vars.trail).toEqual(['PINNED']);
  });

  it('TEST run: an EMPTY pin ([]) produces no downstream items', async () => {
    const { executor, store } = makeHarness();
    const g = graph(
      [
        { id: 'src', type: 'test.emit', params: { tag: 'X' }, pinnedData: [] },
        { id: 'save', type: 'test.saveVar', params: { name: 'trail', from: 'trail' } },
      ],
      [['src', 'save']],
    );
    const res = await executor.start({
      executionId: 'e1', flow: FLOW, graph: g, botId: 'b',
      entry: { nodeId: 'src', items: { main: [item({})] } },
      testRun: true,
    });
    expect(res.status).toBe('done');
    const exec = await store.load('e1');
    // save never ran (no items routed) → var stays unset
    expect(exec!.state.vars.trail).toBeUndefined();
    expect(res.steps).toBe(1); // only `src` executed (as a pin)
  });

  it('the testRun flag is persisted on the state and survives a WAIT (I4 durability)', async () => {
    const { executor, store } = makeHarness();
    const g = graph(
      [
        { id: 'ask', type: 'test.ask', params: { question: 'نام؟' } },
        { id: 'after', type: 'test.boom', pinnedData: [item({ ok: true })] },
        { id: 'save', type: 'test.saveVar', params: { name: 'done', from: 'ok' } },
      ],
      [['ask', 'after', 'reply'], ['after', 'save']],
    );
    const res = await executor.start({
      executionId: 'e1', flow: FLOW, graph: g, botId: 'b', chatId: 7,
      entry: { nodeId: 'ask', items: { main: [item({})] } },
      testRun: true,
    });
    expect(res.status).toBe('waiting');
    // the flag round-tripped through the persisted state
    const paused = await store.load('e1');
    expect(paused!.state.testRun).toBe(true);

    // resume: the test-run pin on `after` must STILL be honoured (boom bypassed)
    const r2 = await executor.resume({
      executionId: 'e1', graph: g, flow: FLOW, port: 'reply', items: [item({ reply: 'علی' })],
    });
    expect(r2.status).toBe('done');
    const exec = await store.load('e1');
    expect(exec!.state.vars.done).toBe(true);
  });
});

describe('executor — single-node run (I-T2, gap G16)', () => {
  it('stopAfterNode: runs ONLY the target node and ends without routing downstream', async () => {
    const { executor, store } = makeHarness();
    const g = graph(
      [
        { id: 'src', type: 'test.emit', params: { tag: 'X' } },
        // `save` would run on a normal flow; the single-node boundary must stop
        // before it (and `boom` would throw if ever reached).
        { id: 'save', type: 'test.saveVar', params: { name: 'trail', from: 'trail' } },
      ],
      [['src', 'save']],
    );
    const res = await executor.start({
      executionId: 'e1', flow: FLOW, graph: g, botId: 'b',
      entry: { nodeId: 'src', items: { main: [item({})] } },
      stopAfterNode: 'src',
    });
    expect(res.status).toBe('done');
    expect(res.steps).toBe(1); // exactly one node executed
    const exec = await store.load('e1');
    // `save` never ran → the downstream var is unset
    expect(exec!.state.vars.trail).toBeUndefined();
  });

  it('the target node executes via the full path — its output is captured in the log', async () => {
    const { executor, logs } = makeHarness();
    const g = graph([{ id: 'src', type: 'test.emit', params: { tag: 'Y' } }], []);
    await executor.start({
      executionId: 'e1', flow: FLOW, graph: g, botId: 'b',
      entry: { nodeId: 'src', items: { main: [item({ seed: 1 })] } },
      stopAfterNode: 'src',
    });
    // the I/O snapshot row for `src` carries its emitted output (trail:['Y'])
    const exec = logs.find((l) => l.nodeId === 'src' && l.output);
    expect(exec).toBeDefined();
    expect(exec!.output!.main![0]!.json.trail).toEqual(['Y']);
    expect(logs.some((l) => /single-node run of "src" complete/.test(l.message))).toBe(true);
  });

  it('stopAfterNode is persisted on the state (I4) and the chosen input reaches the node', async () => {
    const { executor, store } = makeHarness();
    // run `mid` alone, feeding it an item that already carries a trail
    const g = graph(
      [
        { id: 'up', type: 'test.emit', params: { tag: 'UP' } },
        { id: 'mid', type: 'test.emit', params: { tag: 'MID' } },
      ],
      [['up', 'mid']],
    );
    const res = await executor.start({
      executionId: 'e1', flow: FLOW, graph: g, botId: 'b',
      entry: { nodeId: 'mid', items: { main: [item({ trail: ['SEED'] })] } },
      stopAfterNode: 'mid',
    });
    expect(res.status).toBe('done');
    const exec = await store.load('e1');
    expect(exec!.state.stopAfterNode).toBe('mid');
  });

  it('a single-node run of a WAIT node reports `waiting` (the wait is not short-circuited)', async () => {
    const { executor, store } = makeHarness();
    const g = graph([{ id: 'ask', type: 'test.ask', params: { question: 'نام؟' } }], []);
    const res = await executor.start({
      executionId: 'e1', flow: FLOW, graph: g, botId: 'b', chatId: 7,
      entry: { nodeId: 'ask', items: { main: [item({})] } },
      stopAfterNode: 'ask',
    });
    expect(res.status).toBe('waiting');
    expect((await store.load('e1'))!.state.stopAfterNode).toBe('ask');
  });

  it('a normal run (no stopAfterNode) is unaffected — it routes through every node', async () => {
    const { executor, store } = makeHarness();
    const g = graph(
      [
        { id: 'src', type: 'test.emit', params: { tag: 'X' } },
        { id: 'save', type: 'test.saveVar', params: { name: 'trail', from: 'trail' } },
      ],
      [['src', 'save']],
    );
    const res = await executor.start({
      executionId: 'e1', flow: FLOW, graph: g, botId: 'b',
      entry: { nodeId: 'src', items: { main: [item({})] } },
      // no stopAfterNode → full flow
    });
    expect(res.status).toBe('done');
    const exec = await store.load('e1');
    expect(exec!.state.vars.trail).toEqual(['X']); // save DID run
    expect(exec!.state.stopAfterNode).toBeUndefined();
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

describe('executor — listen for one live update (J-T1, Report B)', () => {
  // The entry node `boom` would THROW if executed — so a passing arming proves
  // the executor parked WITHOUT firing the entry node.
  const listenGraph = (): ReturnType<typeof graph> =>
    graph(
      [
        { id: 'trig', type: 'test.boom' },
        { id: 'save', type: 'test.saveVar', params: { name: 'who', from: 'name' } },
      ],
      [['trig', 'save']],
    );

  it('arming PARKS a durable trigger-wait WITHOUT executing the entry node', async () => {
    const { executor, store, logs } = makeHarness();
    const res = await executor.start({
      executionId: 'e1', flow: FLOW, graph: listenGraph(), botId: 'b',
      entry: { nodeId: 'trig', items: { main: [] } },
      listenMode: { triggerParams: { event: 'any_message' }, timeoutAt: null },
    });
    expect(res.status).toBe('waiting');
    expect(res.steps).toBe(0); // nothing executed — the entry node was NOT fired
    const exec = await store.load('e1');
    expect(exec!.status).toBe('waiting');
    expect(exec!.wait).toMatchObject({ kind: 'trigger', nodeId: 'trig', triggerParams: { event: 'any_message' } });
    // marked as an armed listen + implicitly a test run (durable across restart)
    expect(exec!.state.listening).toBe(true);
    expect(exec!.state.testRun).toBe(true);
    expect(logs.some((l) => /listening for one live update at "trig"/.test(l.message))).toBe(true);
  });

  it('the next matching update resumes the trigger node → real item flows downstream', async () => {
    const { executor, store } = makeHarness();
    await executor.start({
      executionId: 'e1', flow: FLOW, graph: listenGraph(), botId: 'b',
      entry: { nodeId: 'trig', items: { main: [] } },
      listenMode: { triggerParams: { event: 'any_message' } },
    });
    // The router's test-listen path resumes the trigger node on `main` with the
    // captured trigger item (sender data).
    const r2 = await executor.resume({
      executionId: 'e1', graph: listenGraph(), flow: FLOW, port: 'main',
      items: [item({ name: 'سارا', text: 'سلام' })],
    });
    expect(r2.status).toBe('done');
    const exec = await store.load('e1');
    expect(exec!.state.vars.who).toBe('سارا'); // downstream node saw the captured sender data
  });

  it('the arming SURVIVES a process restart (I4): a fresh executor on the same store resumes it', async () => {
    const { executor, store } = makeHarness();
    await executor.start({
      executionId: 'e1', flow: FLOW, graph: listenGraph(), botId: 'b',
      entry: { nodeId: 'trig', items: { main: [] } },
      listenMode: { triggerParams: { event: 'any_message' } },
    });
    // Simulate a restart: a brand-new Executor instance over the SAME store.
    const { Executor } = await import('../src/engine/executor');
    const { makeRegistry } = await import('./executor-fakes');
    const revived = new Executor(makeRegistry(), store, {
      kv: () => ({ get: async () => undefined, set: async () => undefined, delete: async () => undefined }),
      http: { request: async () => ({ status: 200, headers: {}, body: null }) },
      tg: () => null,
    });
    const reloaded = await store.load('e1');
    expect(reloaded!.wait!.kind).toBe('trigger'); // still armed after the "restart"
    const r2 = await revived.resume({
      executionId: 'e1', graph: listenGraph(), flow: FLOW, port: 'main',
      items: [item({ name: 'رضا' })],
    });
    expect(r2.status).toBe('done');
    expect((await store.load('e1'))!.state.vars.who).toBe('رضا');
  });

  it('a PRODUCTION run (no listenMode) fires the entry node immediately — byte-identical to today', async () => {
    const { executor, store } = makeHarness();
    const g = graph(
      [
        { id: 'trig', type: 'test.emit', params: { tag: 'T' } },
        { id: 'save', type: 'test.saveVar', params: { name: 'trail', from: 'trail' } },
      ],
      [['trig', 'save']],
    );
    const res = await executor.start({
      executionId: 'e1', flow: FLOW, graph: g, botId: 'b',
      entry: { nodeId: 'trig', items: { main: [item({})] } },
      // no listenMode → the trigger executes immediately, the run completes
    });
    expect(res.status).toBe('done');
    const exec = await store.load('e1');
    expect(exec!.state.vars.trail).toEqual(['T']); // executed normally
    expect(exec!.state.listening).toBeUndefined(); // no arming flag on a prod run
  });
});
