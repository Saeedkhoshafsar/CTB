/**
 * P2-T2 — canvas store tests over the fake server.
 *
 * Includes the PLAN acceptance check: build the P1 demo flow purely through
 * store actions (= what canvas gestures call) → the autosaved JSON validates
 * against FlowGraphSchema and is byte-equivalent in SEMANTICS to the seed
 * fixture (same nodes/params/edges; positions may differ — engine ignores
 * them; here we even drag nodes to the fixture positions so the full
 * documents compare deep-equal).
 */
import { FlowGraphSchema, type FlowGraph } from '@ctb/shared';
import { describe, expect, it } from 'vitest';
import sampleFlow from '../../../packages/shared/test/fixtures/sample-flow.json';
import { ApiClient } from '../src/api/client';
import { createAuthStore } from '../src/stores/auth';
import { createCanvasStore } from '../src/stores/canvas';
import { createFakeServer } from './fake-fetch';

const fixture = FlowGraphSchema.parse(sampleFlow);

async function setup() {
  const srv = createFakeServer();
  const client = new ApiClient({ fetchImpl: srv.fetch });
  await createAuthStore(client).getState().login('admin', 'pw');
  // seed one bot + one empty flow to edit
  const bot = await client.createBot({
    name: 'b',
    token: '123456789:AAEabcdefghijklmnopqrstuvwxy-z12345',
    mode: 'polling',
    settings: {},
  });
  const flow = await client.createFlow({ botId: bot.id, name: 'f', graph: { nodes: [], edges: [] } });
  // autosaveMs=5 so tests can await the debounce quickly
  const useCanvas = createCanvasStore(client, 5);
  await useCanvas.getState().load(flow.id);
  return { srv, client, flow, useCanvas };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** order-insensitive semantic comparison of two flow graphs. */
function sortGraph(g: FlowGraph): FlowGraph {
  return {
    nodes: [...g.nodes].sort((a, b) => a.id.localeCompare(b.id)),
    edges: [...g.edges].sort((a, b) => a.id.localeCompare(b.id)),
  };
}

describe('canvas store basics', () => {
  it('load pulls graph + node types from the server', async () => {
    const { useCanvas } = await setup();
    const s = useCanvas.getState();
    expect(s.graph).toEqual({ nodes: [], edges: [] });
    expect(s.nodeTypes.length).toBeGreaterThanOrEqual(6);
    expect(s.byType.get('flow.if')?.ports.outputs).toEqual(['true', 'false']);
    expect(s.version).toBe(1);
    expect(s.saveState).toBe('clean');
  });

  it('connect enforces canConnect — invalid edges never enter the document', async () => {
    const { useCanvas } = await setup();
    const a = useCanvas.getState().addNode('tg.trigger', { x: 0, y: 0 });
    const b = useCanvas.getState().addNode('tg.sendMessage', { x: 100, y: 0 });
    // trigger has no inputs
    const bad = useCanvas.getState().connect({
      from: { node: b, port: 'main' },
      to: { node: a, port: 'main' },
    });
    expect(bad).toEqual({ ok: false, reason: 'unknownTargetPort' });
    expect(useCanvas.getState().graph.edges).toHaveLength(0);
    const good = useCanvas.getState().connect({
      from: { node: a, port: 'main' },
      to: { node: b, port: 'main' },
    });
    expect(good).toEqual({ ok: true });
    expect(useCanvas.getState().graph.edges).toHaveLength(1);
  });

  it('removing a node removes its edges (no danglers)', async () => {
    const { useCanvas } = await setup();
    const a = useCanvas.getState().addNode('tg.trigger', { x: 0, y: 0 });
    const b = useCanvas.getState().addNode('tg.sendMessage', { x: 100, y: 0 });
    useCanvas.getState().connect({ from: { node: a, port: 'main' }, to: { node: b, port: 'main' } });
    useCanvas.getState().removeNodes([b]);
    const g = useCanvas.getState().graph;
    expect(g.nodes.map((n) => n.id)).toEqual([a]);
    expect(g.edges).toHaveLength(0);
    expect(FlowGraphSchema.safeParse(g).success).toBe(true);
  });

  it('undo/redo walk history; drags coalesce into one entry', async () => {
    const { useCanvas } = await setup();
    const a = useCanvas.getState().addNode('tg.trigger', { x: 0, y: 0 });
    // simulate a drag: many moves, one commit
    for (let x = 1; x <= 5; x++) useCanvas.getState().moveNode(a, { x: x * 10, y: 0 });
    useCanvas.getState().commitMove();
    expect(useCanvas.getState().graph.nodes[0]!.position).toEqual({ x: 50, y: 0 });
    expect(useCanvas.getState().past).toHaveLength(2); // add + drag

    useCanvas.getState().undo(); // whole drag undone at once
    expect(useCanvas.getState().graph.nodes[0]!.position).toEqual({ x: 0, y: 0 });
    useCanvas.getState().undo(); // node add undone
    expect(useCanvas.getState().graph.nodes).toHaveLength(0);
    useCanvas.getState().redo();
    useCanvas.getState().redo();
    expect(useCanvas.getState().graph.nodes[0]!.position).toEqual({ x: 50, y: 0 });
    expect(useCanvas.getState().canRedo()).toBe(false);
  });

  it('autosave debounces, PATCHes the graph and tracks the server version', async () => {
    const { srv, useCanvas, flow } = await setup();
    useCanvas.getState().addNode('tg.trigger', { x: 0, y: 0 });
    expect(useCanvas.getState().saveState).toBe('dirty');
    await sleep(40); // > autosaveMs
    expect(useCanvas.getState().saveState).toBe('saved');
    expect(useCanvas.getState().version).toBe(2); // server bumped on graph write
    const patches = srv.calls.filter(
      (c) => c.method === 'PATCH' && c.path === `/api/flows/${flow.id}`,
    );
    expect(patches).toHaveLength(1); // debounced — one write, not one per keystroke
    expect(srv.flows.get(flow.id)!.graph.nodes).toHaveLength(1);
  });
});

describe('PLAN P2-T2 acceptance — build the P1 demo flow via canvas actions', () => {
  it('reproduces the seed flow with byte-equivalent semantics', async () => {
    const { srv, useCanvas, flow } = await setup();
    const s = () => useCanvas.getState();

    // 1. drag nodes from the palette (fixture ids are produced by renaming —
    //    until P2-T3's inspector lands we add with the fixture's own ids by
    //    building through addNode + updateNode, then aligning ids via params;
    //    semantics comparison below is id-aware, so we add in fixture order
    //    and map generated ids → fixture ids when wiring edges.)
    const idMap = new Map<string, string>();
    for (const fn of fixture.nodes) {
      const id = s().addNode(fn.type, fn.position);
      idMap.set(fn.id, id);
      s().updateNode(id, {
        params: fn.params,
        ...(fn.note !== undefined ? { note: fn.note } : {}),
      });
    }

    // 2. connect the ports exactly like the fixture
    for (const fe of fixture.edges) {
      const verdict = s().connect({
        from: { node: idMap.get(fe.from.node)!, port: fe.from.port },
        to: { node: idMap.get(fe.to.node)!, port: fe.to.port },
      });
      expect(verdict).toEqual({ ok: true });
    }

    // 3. autosave fires → server holds the document
    await sleep(40);
    expect(s().saveState).toBe('saved');
    const saved = srv.flows.get(flow.id)!.graph;

    // validates against the shared contract
    expect(FlowGraphSchema.safeParse(saved).success).toBe(true);

    // byte-equivalent semantics: rename generated ids back to fixture ids and
    // the two documents are deep-equal (nodes incl. params/positions/notes,
    // edges incl. ports).
    const reverse = new Map([...idMap].map(([fixtureId, genId]) => [genId, fixtureId]));
    const renamed: FlowGraph = {
      nodes: saved.nodes.map((n) => ({ ...n, id: reverse.get(n.id) ?? n.id })),
      edges: saved.edges.map((e, i) => ({
        id: fixture.edges[i]!.id,
        from: { node: reverse.get(e.from.node) ?? e.from.node, port: e.from.port },
        to: { node: reverse.get(e.to.node) ?? e.to.node, port: e.to.port },
      })),
    };
    expect(sortGraph(renamed)).toEqual(sortGraph(fixture));
  });
});
