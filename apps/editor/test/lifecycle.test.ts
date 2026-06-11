/**
 * P2-T4 — flow lifecycle store tests over the fake server.
 * The fake's activate endpoint calls the SAME shared validateFlowForActivation
 * with the SAME shared param schemas the real registry holds, so the 422
 * semantics asserted here are the server's semantics.
 */
import { FlowGraphSchema, type FlowGraph } from '@ctb/shared';
import { describe, expect, it } from 'vitest';
import { ApiClient } from '../src/api/client';
import { createLifecycleStore } from '../src/stores/lifecycle';
import { createFakeServer } from './fake-fetch';

const VALID_TOKEN = '123456789:AAEabcdefghijklmnopqrstuvwxy-z12345';

const GOOD_GRAPH: FlowGraph = FlowGraphSchema.parse({
  nodes: [
    { id: 't', type: 'tg.trigger', params: { event: 'any_message' }, position: { x: 0, y: 0 } },
    { id: 's', type: 'tg.sendMessage', params: { text: 'سلام' }, position: { x: 200, y: 0 } },
  ],
  edges: [{ id: 'e1', from: { node: 't', port: 'main' }, to: { node: 's', port: 'main' } }],
});

/** sendMessage with empty params → real schema's superRefine demands `text`. */
const BAD_PARAMS_GRAPH: FlowGraph = FlowGraphSchema.parse({
  nodes: [
    { id: 't', type: 'tg.trigger', params: { event: 'any_message' }, position: { x: 0, y: 0 } },
    { id: 's', type: 'tg.sendMessage', params: {}, position: { x: 200, y: 0 } },
  ],
  edges: [{ id: 'e1', from: { node: 't', port: 'main' }, to: { node: 's', port: 'main' } }],
});

async function setup(graph: FlowGraph) {
  const srv = createFakeServer();
  const client = new ApiClient({ fetchImpl: srv.fetch });
  await client.login({ username: 'admin', password: 'pw' });
  const bot = await client.createBot({
    name: 'b',
    token: VALID_TOKEN,
    mode: 'polling',
    settings: {},
  });
  const flow = await client.createFlow({ botId: bot.id, name: 'f', graph });
  return { srv, client, flow };
}

describe('lifecycle store (P2-T4)', () => {
  it('activate on a valid flow → status active, no problems', async () => {
    const { client, flow } = await setup(GOOD_GRAPH);
    const useLc = createLifecycleStore(client);
    useLc.getState().init(flow.id, flow.status);

    expect(await useLc.getState().activate()).toBe(true);
    expect(useLc.getState().status).toBe('active');
    expect(useLc.getState().problems).toEqual([]);

    await useLc.getState().deactivate();
    expect(useLc.getState().status).toBe('draft');
  });

  it('activating an invalid flow is blocked with node-pinned problems (acceptance)', async () => {
    const { client, flow } = await setup(BAD_PARAMS_GRAPH);
    const useLc = createLifecycleStore(client);
    useLc.getState().init(flow.id, flow.status);

    expect(await useLc.getState().activate()).toBe(false);
    expect(useLc.getState().status).toBe('draft'); // unchanged
    const { problems, problemsByNode } = useLc.getState();
    expect(problems.length).toBeGreaterThan(0);
    // the offending node is identified → canvas badge can render
    expect(problemsByNode.has('s')).toBe(true);
    expect(problemsByNode.get('s')![0]).toContain('text');
  });

  it('flow-level problem (no trigger) has nodeId null — toolbar strip only', async () => {
    const { client, flow } = await setup({ nodes: [], edges: [] });
    const useLc = createLifecycleStore(client);
    useLc.getState().init(flow.id, flow.status);

    expect(await useLc.getState().activate()).toBe(false);
    const { problems, problemsByNode } = useLc.getState();
    expect(problems[0]).toMatchObject({ nodeId: null });
    expect(problemsByNode.size).toBe(0);
  });

  it('loadVersions lists snapshots; rollback restores the older graph (acceptance)', async () => {
    const { client, flow } = await setup(GOOD_GRAPH);
    // bump to v2: v1 (GOOD_GRAPH) becomes a snapshot
    const v2: FlowGraph = { nodes: [GOOD_GRAPH.nodes[0]!], edges: [] };
    await client.updateFlow(flow.id, { graph: v2 });

    const useLc = createLifecycleStore(client);
    useLc.getState().init(flow.id, flow.status);

    await useLc.getState().loadVersions();
    expect(useLc.getState().current).toBe(2);
    expect(useLc.getState().versions).toEqual([
      expect.objectContaining({ version: 1, nodeCount: 2, edgeCount: 1 }),
    ]);

    const restored = await useLc.getState().rollback(1);
    expect(restored).not.toBeNull();
    expect(restored!.version).toBe(3);
    expect(restored!.graph).toEqual(GOOD_GRAPH); // older graph restored

    // rollback snapshotted the outgoing v2 → history now [2, 1]
    expect(useLc.getState().versions.map((v) => v.version)).toEqual([2, 1]);

    const undone = await useLc.getState().rollback(2);
    expect(undone!.graph).toEqual(v2); // rollback is itself undoable
  });

  it('rollback of an unknown version surfaces an error, never throws', async () => {
    const { client, flow } = await setup(GOOD_GRAPH);
    const useLc = createLifecycleStore(client);
    useLc.getState().init(flow.id, flow.status);
    expect(await useLc.getState().rollback(99)).toBeNull();
    expect(useLc.getState().error).toBeTruthy();
  });
});
