/**
 * P2-T2 — pure canvas graph helpers: FlowGraph ⇄ React Flow mapping
 * round-trip and the port-aware connection rules.
 */
import { FlowGraphSchema, type NodeTypeInfo } from '@ctb/shared';
import { describe, expect, it } from 'vitest';
import sampleFlow from '../../../packages/shared/test/fixtures/sample-flow.json';
import {
  NOTE_RF_PREFIX,
  buildEdge,
  canConnect,
  effectiveOutputs,
  flowToRfEdges,
  flowToRfNodes,
  nextEdgeId,
  nextNodeId,
  nextNoteId,
  noteIdFromRf,
  notesToRfNodes,
  rfIdForNote,
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

describe('dynamic ports — tg.menu / flow.switch (P2-T6)', () => {
  const menuGraph = FlowGraphSchema.parse({
    nodes: [
      {
        id: 'menu_1',
        type: 'tg.menu',
        params: {
          text: 'انتخاب:',
          buttons: [[{ text: 'خرید', key: 'buy' }], [{ text: 'راهنما', key: 'help' }]],
          timeout: '15m',
        },
        position: { x: 0, y: 0 },
      },
      { id: 'greet', type: 'tg.sendMessage', params: { text: 'hi' }, position: { x: 0, y: 0 } },
    ],
    edges: [],
  });
  const menuNode = menuGraph.nodes[0]!;

  it('effectiveOutputs computes ports from params (menu buttons + timeout)', () => {
    expect(effectiveOutputs(menuNode, byType.get('tg.menu'))).toEqual([
      'btn:buy',
      'btn:help',
      'timeout',
    ]);
    // static-port nodes fall back to the registry list
    expect(effectiveOutputs(menuGraph.nodes[1]!, byType.get('tg.sendMessage'))).toEqual(['main']);
    // draft-tolerant: half-typed buttons don't crash, valid keys still appear
    const draft = { ...menuNode, params: { buttons: [[{ text: '', key: 'ok' }, { key: '' }]] } };
    expect(effectiveOutputs(draft, byType.get('tg.menu'))).toEqual(['btn:ok']);
  });

  it('canConnect accepts a button port and rejects a removed one — menu ports render as separate edges', () => {
    expect(
      canConnect(
        { from: { node: 'menu_1', port: 'btn:buy' }, to: { node: 'greet', port: 'main' } },
        menuGraph,
        byType,
      ),
    ).toEqual({ ok: true });
    expect(
      canConnect(
        { from: { node: 'menu_1', port: 'btn:deleted' }, to: { node: 'greet', port: 'main' } },
        menuGraph,
        byType,
      ),
    ).toEqual({ ok: false, reason: 'unknownSourcePort' });

    // each button becomes its own labeled edge on the canvas (P2-T6 acceptance)
    const wired = FlowGraphSchema.parse({
      nodes: menuGraph.nodes,
      edges: [
        { id: 'e1', from: { node: 'menu_1', port: 'btn:buy' }, to: { node: 'greet', port: 'main' } },
        { id: 'e2', from: { node: 'menu_1', port: 'btn:help' }, to: { node: 'greet', port: 'main' } },
      ],
    });
    const rfEdges = flowToRfEdges(wired, none);
    expect(rfEdges.map((e) => ({ handle: e.sourceHandle, label: e.label }))).toEqual([
      { handle: 'btn:buy', label: 'btn:buy' },
      { handle: 'btn:help', label: 'btn:help' },
    ]);
  });

  it('switch rule ports work the same way (rules + default)', () => {
    const switchGraph = FlowGraphSchema.parse({
      nodes: [
        {
          id: 'sw',
          type: 'flow.switch',
          params: { value: '{{ $json.kind }}', rules: [{ port: 'vip', match: 'vip' }] },
          position: { x: 0, y: 0 },
        },
        { id: 'greet', type: 'tg.sendMessage', params: { text: 'hi' }, position: { x: 0, y: 0 } },
      ],
      edges: [],
    });
    expect(effectiveOutputs(switchGraph.nodes[0]!, byType.get('flow.switch'))).toEqual([
      'vip',
      'default',
    ]);
    expect(
      canConnect(
        { from: { node: 'sw', port: 'default' }, to: { node: 'greet', port: 'main' } },
        switchGraph,
        byType,
      ),
    ).toEqual({ ok: true });
  });
});

describe('typed sub-connections — slots/providers (PB-T1)', () => {
  // synthetic registry: an Agent consumer + three providers, mirroring the
  // shape PB-T5/T6 will ship. NodeTypeInfo carries the new role/slots/provides.
  const slotTypes: NodeTypeInfo[] = [
    ...FAKE_NODE_TYPES,
    {
      type: 'ai.agent',
      category: 'ai',
      meta: { labelKey: 'x' },
      ports: { inputs: ['main'], outputs: ['main'] },
      paramsJsonSchema: {},
      role: 'data',
      inputSlots: [
        { kind: 'ai:model', required: true, repeatable: false },
        { kind: 'ai:tool', required: false, repeatable: true },
      ],
    },
    {
      type: 'ai.modelOpenai',
      category: 'ai',
      meta: { labelKey: 'x' },
      ports: { inputs: [], outputs: ['provider'] },
      paramsJsonSchema: {},
      role: 'provider',
      provides: 'ai:model',
    },
    {
      type: 'ai.memoryKv',
      category: 'ai',
      meta: { labelKey: 'x' },
      ports: { inputs: [], outputs: ['provider'] },
      paramsJsonSchema: {},
      role: 'provider',
      provides: 'ai:memory',
    },
    {
      type: 'tool.think',
      category: 'ai',
      meta: { labelKey: 'x' },
      ports: { inputs: [], outputs: ['provider'] },
      paramsJsonSchema: {},
      role: 'provider',
      provides: 'ai:tool',
    },
  ];
  const slotByType: ReadonlyMap<string, NodeTypeInfo> = new Map(
    slotTypes.map((nt) => [nt.type, nt]),
  );
  const g = FlowGraphSchema.parse({
    nodes: [
      { id: 'a', type: 'ai.agent', params: {}, position: { x: 0, y: 0 } },
      { id: 'm', type: 'ai.modelOpenai', params: {}, position: { x: 0, y: 0 } },
      { id: 'mem', type: 'ai.memoryKv', params: {}, position: { x: 0, y: 0 } },
      { id: 'th', type: 'tool.think', params: {}, position: { x: 0, y: 0 } },
      { id: 's', type: 'tg.sendMessage', params: { text: 'hi' }, position: { x: 0, y: 0 } },
    ],
    edges: [],
  });

  it('a matching provider plugs into its slot', () => {
    expect(
      canConnect(
        { from: { node: 'm', port: 'provider' }, to: { node: 'a', port: 'ai:model' } },
        g,
        slotByType,
      ),
    ).toEqual({ ok: true });
  });

  it('a wrong-kind provider into a slot is rejected', () => {
    expect(
      canConnect(
        { from: { node: 'mem', port: 'provider' }, to: { node: 'a', port: 'ai:model' } },
        g,
        slotByType,
      ),
    ).toEqual({ ok: false, reason: 'slotKindMismatch' });
  });

  it('a data node into a slot is rejected (slotKindMismatch)', () => {
    expect(
      canConnect(
        { from: { node: 's', port: 'main' }, to: { node: 'a', port: 'ai:model' } },
        g,
        slotByType,
      ),
    ).toEqual({ ok: false, reason: 'slotKindMismatch' });
  });

  it('a provider into a plain data port is rejected', () => {
    expect(
      canConnect(
        { from: { node: 'm', port: 'provider' }, to: { node: 's', port: 'main' } },
        g,
        slotByType,
      ),
    ).toEqual({ ok: false, reason: 'providerNotAttachedToSlot' });
  });

  it('a non-repeatable slot rejects a second provider', () => {
    const wired = FlowGraphSchema.parse({
      nodes: g.nodes,
      edges: [{ id: 'e1', from: { node: 'm', port: 'provider' }, to: { node: 'a', port: 'ai:model' } }],
    });
    // a second model provider (reuse 'm' via fan-out, or any model node) is denied
    expect(
      canConnect(
        { from: { node: 'm', port: 'provider' }, to: { node: 'a', port: 'ai:model' } },
        wired,
        slotByType,
      ),
      // same edge → duplicate first; use a distinct second model to hit arity
    ).toEqual({ ok: false, reason: 'duplicate' });
    const twoModels = FlowGraphSchema.parse({
      nodes: [...g.nodes, { id: 'm2', type: 'ai.modelOpenai', params: {}, position: { x: 0, y: 0 } }],
      edges: [{ id: 'e1', from: { node: 'm', port: 'provider' }, to: { node: 'a', port: 'ai:model' } }],
    });
    expect(
      canConnect(
        { from: { node: 'm2', port: 'provider' }, to: { node: 'a', port: 'ai:model' } },
        twoModels,
        slotByType,
      ),
    ).toEqual({ ok: false, reason: 'slotNotRepeatable' });
  });

  it('a repeatable tool slot accepts many providers', () => {
    const wired = FlowGraphSchema.parse({
      nodes: [...g.nodes, { id: 'th2', type: 'tool.think', params: {}, position: { x: 0, y: 0 } }],
      edges: [{ id: 'e1', from: { node: 'th', port: 'provider' }, to: { node: 'a', port: 'ai:tool' } }],
    });
    expect(
      canConnect(
        { from: { node: 'th2', port: 'provider' }, to: { node: 'a', port: 'ai:tool' } },
        wired,
        slotByType,
      ),
    ).toEqual({ ok: true });
  });

  it('flowToRfEdges marks a slot edge as a dashed sub-connection', () => {
    const wired = FlowGraphSchema.parse({
      nodes: g.nodes,
      edges: [
        { id: 'e1', from: { node: 'm', port: 'provider' }, to: { node: 'a', port: 'ai:model' } },
      ],
    });
    const [edge] = flowToRfEdges(wired, none, slotByType);
    expect(edge!.className).toBe('ctb-slot-edge');
    expect(edge!.label).toBe('ai:model');
    expect((edge!.data as { slot?: boolean }).slot).toBe(true);
  });

  it('without byType, edges stay plain data edges (back-compat)', () => {
    const wired = FlowGraphSchema.parse({
      nodes: g.nodes,
      edges: [
        { id: 'e1', from: { node: 'm', port: 'provider' }, to: { node: 'a', port: 'ai:model' } },
      ],
    });
    const [edge] = flowToRfEdges(wired, none);
    expect(edge!.className).toBeUndefined();
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

describe('sticky notes — canvas mapping (H-T1)', () => {
  const noteGraph = FlowGraphSchema.parse({
    nodes: [],
    edges: [],
    notes: [
      {
        id: 'note_1',
        text: 'first',
        position: { x: 10, y: 20 },
        size: { width: 240, height: 160 },
        color: 'yellow',
      },
      {
        id: 'note_2',
        text: 'second',
        position: { x: 300, y: 40 },
        size: { width: 320, height: 200 },
        color: 'blue',
      },
    ],
  });

  it('namespaces note ids under a "note:" prefix and round-trips them', () => {
    expect(rfIdForNote('note_1')).toBe(`${NOTE_RF_PREFIX}note_1`);
    expect(noteIdFromRf(rfIdForNote('note_7'))).toBe('note_7');
    // a flow-node rf id (no prefix) is NOT a note
    expect(noteIdFromRf('sendMessage_1')).toBeNull();
    // empty / partial prefixes are not mistaken for notes
    expect(noteIdFromRf('note')).toBeNull();
  });

  it('maps graph.notes to "sticky" rf nodes carrying size, position and the note payload', () => {
    const rf = notesToRfNodes(noteGraph, none);
    expect(rf).toHaveLength(2);
    const first = rf[0]!;
    const second = rf[1]!;
    expect(first.id).toBe(rfIdForNote('note_1'));
    expect(first.type).toBe('sticky');
    expect(first.position).toEqual({ x: 10, y: 20 });
    expect(first.width).toBe(240);
    expect(first.height).toBe(160);
    expect(first.data.note.text).toBe('first');
    // notes always sit BEHIND flow nodes and never intercept connection drags
    expect(first.zIndex).toBe(0);
    expect(second.data.note.color).toBe('blue');
  });

  it('reflects selection onto the mapped sticky node', () => {
    const selected = new Set([rfIdForNote('note_2')]);
    const rf = notesToRfNodes(noteGraph, selected);
    expect(rf.find((n) => n.id === rfIdForNote('note_1'))!.selected).toBe(false);
    expect(rf.find((n) => n.id === rfIdForNote('note_2'))!.selected).toBe(true);
  });

  it('yields an empty list when the graph has no notes (engine-shaped graph)', () => {
    expect(notesToRfNodes(FlowGraphSchema.parse({ nodes: [], edges: [] }), none)).toEqual([]);
  });

  it('note ids fill the smallest free note_<n> slot, independent of node ids', () => {
    expect(nextNoteId({ nodes: [], edges: [] })).toBe('note_1');
    // a node literally named note_1 must NOT block the first note slot (separate namespaces)
    const withNode = FlowGraphSchema.parse({
      nodes: [{ id: 'note_1', type: 'tg.sendMessage', params: {}, position: { x: 0, y: 0 } }],
      edges: [],
    });
    expect(nextNoteId(withNode)).toBe('note_1');
    expect(nextNoteId(noteGraph)).toBe('note_3'); // note_1, note_2 taken
  });
});
