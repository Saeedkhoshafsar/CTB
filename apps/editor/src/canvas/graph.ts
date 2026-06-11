/**
 * Pure FlowGraph ⇄ React Flow mapping + canvas-side graph rules (P2-T2).
 *
 * The FlowGraph document (shared Zod contract, I5) stays the single source of
 * truth — React Flow nodes/edges are a DERIVED view computed per render.
 * Everything here is side-effect free so the round-trip ("byte-equivalent
 * semantics" acceptance) and connection rules are unit-testable without DOM.
 */
import { dynamicOutputPorts } from '@ctb/shared';
import type { FlowEdge, FlowGraph, FlowNode, NodeTypeInfo } from '@ctb/shared';
import type { Edge as RfEdge, Node as RfNode } from '@xyflow/react';

/**
 * Effective output ports of a node INSTANCE (P2-T6): dynamic-port types
 * (tg.menu, flow.switch) compute ports from params via the SAME shared
 * helper the node implementations use; everything else uses the registry's
 * static list. Unknown types render a 'main' handle so existing edges stay
 * visible/selectable.
 */
export function effectiveOutputs(node: FlowNode, info: NodeTypeInfo | undefined): string[] {
  const dynamic = dynamicOutputPorts(node.type, node.params);
  if (dynamic !== null) return dynamic;
  return info?.ports.outputs ?? ['main'];
}

/** Data payload carried by every canvas node. */
export interface CtbNodeData extends Record<string, unknown> {
  flowNode: FlowNode;
  info: NodeTypeInfo | undefined; // undefined = unknown type (still rendered, flagged)
}

export type CtbRfNode = RfNode<CtbNodeData, 'ctb'>;

// ---------------------------------------------------------------------------
// FlowGraph → React Flow
// ---------------------------------------------------------------------------

export function flowToRfNodes(
  graph: FlowGraph,
  byType: ReadonlyMap<string, NodeTypeInfo>,
  selected: ReadonlySet<string>,
): CtbRfNode[] {
  return graph.nodes.map((n) => ({
    id: n.id,
    type: 'ctb' as const,
    position: { x: n.position.x, y: n.position.y },
    selected: selected.has(n.id),
    data: { flowNode: n, info: byType.get(n.type) },
  }));
}

export function flowToRfEdges(graph: FlowGraph, selected: ReadonlySet<string>): RfEdge[] {
  return graph.edges.map((e) => ({
    id: e.id,
    source: e.from.node,
    sourceHandle: e.from.port,
    target: e.to.node,
    targetHandle: e.to.port,
    selected: selected.has(e.id),
    // non-default source ports get a label so branches read at a glance
    ...(e.from.port !== 'main' ? { label: e.from.port } : {}),
  }));
}

// ---------------------------------------------------------------------------
// React Flow → FlowGraph (only positions flow back this way; structure edits
// go through the canvas store actions — but the full mapping keeps the
// round-trip property honest and gives P2 tests their acceptance check)
// ---------------------------------------------------------------------------

export function rfToFlow(nodes: readonly CtbRfNode[], edges: readonly RfEdge[]): FlowGraph {
  return {
    nodes: nodes.map((rn) => ({
      ...rn.data.flowNode,
      position: { x: rn.position.x, y: rn.position.y },
    })),
    edges: edges.map((re) => ({
      id: re.id,
      from: { node: re.source, port: re.sourceHandle ?? 'main' },
      to: { node: re.target, port: re.targetHandle ?? 'main' },
    })),
  };
}

// ---------------------------------------------------------------------------
// connection rules (port-aware, type-checked edges)
// ---------------------------------------------------------------------------

export interface ConnectionAttempt {
  from: { node: string; port: string };
  to: { node: string; port: string };
}

export type ConnectVerdict =
  | { ok: true }
  | {
      ok: false;
      reason:
        | 'unknownNode'
        | 'selfLoop'
        | 'unknownSourcePort'
        | 'unknownTargetPort'
        | 'duplicate';
    };

/**
 * Validates a prospective edge against the graph + registry metadata.
 * Fan-out (many edges from one output port) is ALLOWED — the executor runs
 * branches FIFO. Cycles through several nodes are allowed (loops are a
 * feature); a direct self-loop is rejected as an obvious mistake.
 */
export function canConnect(
  attempt: ConnectionAttempt,
  graph: FlowGraph,
  byType: ReadonlyMap<string, NodeTypeInfo>,
): ConnectVerdict {
  const source = graph.nodes.find((n) => n.id === attempt.from.node);
  const target = graph.nodes.find((n) => n.id === attempt.to.node);
  if (!source || !target) return { ok: false, reason: 'unknownNode' };
  if (source.id === target.id) return { ok: false, reason: 'selfLoop' };

  // Unknown node types (e.g. flow built by a newer server) cannot be wired —
  // we cannot verify their ports, and the engine would reject them anyway.
  const sourceInfo = byType.get(source.type);
  const targetInfo = byType.get(target.type);
  // dynamic-port nodes (menu/switch) validate against their params-derived
  // ports — a button the user just removed can no longer be wired.
  if (!sourceInfo || !effectiveOutputs(source, sourceInfo).includes(attempt.from.port)) {
    return { ok: false, reason: 'unknownSourcePort' };
  }
  if (!targetInfo || !targetInfo.ports.inputs.includes(attempt.to.port)) {
    return { ok: false, reason: 'unknownTargetPort' };
  }

  const dup = graph.edges.some(
    (e) =>
      e.from.node === attempt.from.node &&
      e.from.port === attempt.from.port &&
      e.to.node === attempt.to.node &&
      e.to.port === attempt.to.port,
  );
  if (dup) return { ok: false, reason: 'duplicate' };

  return { ok: true };
}

// ---------------------------------------------------------------------------
// id generation
// ---------------------------------------------------------------------------

/**
 * Node ids: "<localName>_<n>" from the type's local part — readable in logs
 * and exec inspector ("sendMessage_2"), unique within the graph.
 */
export function nextNodeId(type: string, graph: FlowGraph): string {
  const local = type.split('.')[1] ?? type.replace(/[^A-Za-z0-9_-]/g, '_');
  const taken = new Set(graph.nodes.map((n) => n.id));
  for (let i = 1; ; i++) {
    const candidate = `${local}_${i}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** Edge ids: smallest unused "e<n>" — matches the seed-flow convention. */
export function nextEdgeId(graph: FlowGraph): string {
  const taken = new Set(graph.edges.map((e) => e.id));
  for (let i = 1; ; i++) {
    const candidate = `e${i}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** Edge factory used by the store once canConnect passed. */
export function buildEdge(attempt: ConnectionAttempt, graph: FlowGraph): FlowEdge {
  return {
    id: nextEdgeId(graph),
    from: { node: attempt.from.node, port: attempt.from.port },
    to: { node: attempt.to.node, port: attempt.to.port },
  };
}
