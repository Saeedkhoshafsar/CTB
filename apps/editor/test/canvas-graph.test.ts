/**
 * P2-T2 — pure canvas graph helpers: FlowGraph ⇄ React Flow mapping
 * round-trip and the port-aware connection rules.
 */
import { FlowGraphSchema, type NodeTypeInfo } from '@ctb/shared';
import { describe, expect, it } from 'vitest';
import sampleFlow from '../../../packages/shared/test/fixtures/sample-flow.json';
import {
  buildEdge,
  canConnect,
  flowToRfEdges,
  flowToRfNodes,
  nextEdgeId,
  nextNodeId,
  rfToFlow,
} from '../src/canvas/graph';
import { FAKE_NODE_TYPES } from './fake-fetch';

const byType: ReadonlyMap<string, NodeTypeInfo> = new Map(
  FAKE_NODE_TYPES.map((nt) => [nt.type, nt]),
);
const graph = FlowGraphSchema.parse(sampleFlow);
const none = new Set<string>();

describe('FlowGraph ⇄ React Flow mapping', () => {
  it('round-trips the P1 sample flow without losing anything', () => {
    const rfNodes = flowToRfNodes(graph, byType, none);
    const rfEdges = flowToRfEdges(graph, none);
    const back = rfToFlow(rfNodes, rfEdges);
    expect(back).toEqual(graph);
    // and the round-tripped document still validates against the contract
    expect(FlowGraphSchema.safeParse(back).success).toBe(true);
  });

  it('maps ports to handles (multi-output wait node) and labels branch edges', () => {
    const rfEdges = flowToRfEdges(graph, none);
    const invalidEdge = rfEdges.find((e) => e.id === 'e4')!;
    expect(invalidEdge.sourceHandle).toBe('invalid');
    expect(invalidEdge.label).toBe('invalid'); // non-main ports get a label
    const mainEdge = rfEdges.find((e) => e.id === 'e1')!;
    expect(mainEdge.label).toBeUndefined();
  });

  it('flags unknown node types but still renders them', () => {
    const weird = FlowGraphSchema.parse({
      nodes: [{ id: 'x', type: 'future.node', params: {}, position: { x: 0, y: 0 } }],
      edges: [],
    });
    const [node] = flowToRfNodes(weird, byType, none);
    expect(node!.data.info).toBeUndefined();
    expect(node!.data.flowNode.type).toBe('future.node');
  });
});

describe('canConnect (port-aware, type-checked edges)', () => {
  it('accepts a valid main→main connection and fan-out from one port', () => {
    expect(
      canConnect(
        { from: { node: 'greet', port: 'main' }, to: { node: 'greet_minor', port: 'main' } },
        graph,
        byType,
      ),
    ).toEqual({ ok: true });
    // trigger.main → ask_name.main already exists; fan-out to another node is fine
    expect(
      canConnect(
        { from: { node: 'trigger', port: 'main' }, to: { node: 'greet', port: 'main' } },
        graph,
        byType,
      ),
    ).toEqual({ ok: true });
  });

  it('rejects self-loops, duplicates and unknown nodes', () => {
    expect(
      canConnect(
        { from: { node: 'greet', port: 'main' }, to: { node: 'greet', port: 'main' } },
        graph,
        byType,
      ),
    ).toEqual({ ok: false, reason: 'selfLoop' });
    expect(
      canConnect(
        { from: { node: 'trigger', port: 'main' }, to: { node: 'ask_name', port: 'main' } },
        graph,
        byType,
      ),
    ).toEqual({ ok: false, reason: 'duplicate' });
    expect(
      canConnect(
        { from: { node: 'nope', port: 'main' }, to: { node: 'greet', port: 'main' } },
        graph,
        byType,
      ),
    ).toEqual({ ok: false, reason: 'unknownNode' });
  });

  it('rejects ports the node type does not have', () => {
    // stopError has NO outputs — nothing can leave it
    expect(
      canConnect(
        { from: { node: 'too_many_retries', port: 'main' }, to: { node: 'greet', port: 'main' } },
        graph,
        byType,
      ),
    ).toEqual({ ok: false, reason: 'unknownSourcePort' });
    // IF has true/false, not "maybe"
    expect(
      canConnect(
        { from: { node: 'check_adult', port: 'maybe' }, to: { node: 'greet', port: 'main' } },
        graph,
        byType,
      ),
    ).toEqual({ ok: false, reason: 'unknownSourcePort' });
    // trigger has no inputs — nothing can point at it
    expect(
      canConnect(
        { from: { node: 'greet', port: 'main' }, to: { node: 'trigger', port: 'main' } },
        graph,
        byType,
      ),
    ).toEqual({ ok: false, reason: 'unknownTargetPort' });
  });
});

describe('id generation', () => {
  it('node ids derive from the type local name and never collide', () => {
    expect(nextNodeId('tg.sendMessage', { nodes: [], edges: [] })).toBe('sendMessage_1');
    const taken = FlowGraphSchema.parse({
      nodes: [
        { id: 'sendMessage_1', type: 'tg.sendMessage', params: {}, position: { x: 0, y: 0 } },
      ],
      edges: [],
    });
    expect(nextNodeId('tg.sendMessage', taken)).toBe('sendMessage_2');
  });

  it('edge ids fill the smallest free e<n> slot (fixture convention)', () => {
    expect(nextEdgeId({ nodes: [], edges: [] })).toBe('e1');
    expect(nextEdgeId(graph)).toBe('e7'); // fixture has e1..e6
    const edge = buildEdge(
      { from: { node: 'greet', port: 'main' }, to: { node: 'greet_minor', port: 'main' } },
      graph,
    );
    expect(edge).toEqual({
      id: 'e7',
      from: { node: 'greet', port: 'main' },
      to: { node: 'greet_minor', port: 'main' },
    });
  });
});
