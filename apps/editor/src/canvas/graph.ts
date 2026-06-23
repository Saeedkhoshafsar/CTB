/**
 * Pure FlowGraph ⇄ React Flow mapping + canvas-side graph rules (P2-T2).
 *
 * The FlowGraph document (shared Zod contract, I5) stays the single source of
 * truth — React Flow nodes/edges are a DERIVED view computed per render.
 * Everything here is side-effect free so the round-trip ("byte-equivalent
 * semantics" acceptance) and connection rules are unit-testable without DOM.
 */
import { dynamicOutputPorts } from '@ctb/shared';
import type { FlowEdge, FlowGraph, FlowNode, NodeTypeInfo, StickyNote } from '@ctb/shared';
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

/** Data payload carried by every sticky-note canvas node (H-T1). */
export interface StickyNodeData extends Record<string, unknown> {
  note: StickyNote;
}
export type StickyRfNode = RfNode<StickyNodeData, 'sticky'>;

/** Any canvas node React Flow renders — a real flow node OR a sticky note. */
export type AnyRfNode = CtbRfNode | StickyRfNode;

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

/**
 * Sticky notes → React Flow nodes (H-T1). Rendered BEHIND the flow nodes (a
 * lower z-index via the 'sticky' type's CSS) so wires stay readable. Notes are
 * never connectable — they carry no handles — so the connection rules above are
 * untouched. The note id is prefixed so it can never clash with a flow-node id
 * in React Flow's flat id space (notesToRf must not collide with flowToRf).
 */
export const NOTE_RF_PREFIX = 'note:' as const;

export function rfIdForNote(noteId: string): string {
  return `${NOTE_RF_PREFIX}${noteId}`;
}
export function noteIdFromRf(rfId: string): string | null {
  return rfId.startsWith(NOTE_RF_PREFIX) ? rfId.slice(NOTE_RF_PREFIX.length) : null;
}

export function notesToRfNodes(
  graph: FlowGraph,
  selected: ReadonlySet<string>,
): StickyRfNode[] {
  return (graph.notes ?? []).map((note) => ({
    id: rfIdForNote(note.id),
    type: 'sticky' as const,
    position: { x: note.position.x, y: note.position.y },
    width: note.size.width,
    height: note.size.height,
    selected: selected.has(rfIdForNote(note.id)),
    // notes render under flow nodes and don't intercept connection drags
    zIndex: 0,
    data: { note },
  }));
}

export function flowToRfEdges(
  graph: FlowGraph,
  selected: ReadonlySet<string>,
  byType?: ReadonlyMap<string, NodeTypeInfo>,
): RfEdge[] {
  const typeOf = (id: string): NodeTypeInfo | undefined => {
    const n = graph.nodes.find((node) => node.id === id);
    return n && byType ? byType.get(n.type) : undefined;
  };
  return graph.edges.map((e) => {
    // A sub-connection edge lands on a typed slot port (PB-T1) — render it as a
    // distinct dashed "provider" wire, not a solid data edge.
    const slot = inputSlots(typeOf(e.to.node)).find((s) => s.kind === e.to.port);
    return {
      id: e.id,
      source: e.from.node,
      sourceHandle: e.from.port,
      target: e.to.node,
      targetHandle: e.to.port,
      selected: selected.has(e.id),
      ...(slot
        ? // dashed, slot-kind-labeled, visually marked as a sub-connection
          {
            label: e.to.port,
            className: 'ctb-slot-edge',
            animated: false,
            style: { strokeDasharray: '6 4', stroke: 'var(--node-ai)' },
            data: { slot: true },
          }
        : // non-default source ports get a label so branches read at a glance
          e.from.port !== 'main'
          ? { label: e.from.port }
          : {}),
    };
  });
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
        | 'duplicate'
        // PB-T1 typed sub-connection rules:
        | 'slotKindMismatch' // a slot port fed by a non-matching / non-provider source
        | 'providerNotAttachedToSlot' // a provider wired into a plain data port
        | 'slotNotRepeatable'; // a single-slot already has a provider
    };

/**
 * The typed input slots a consumer node exposes (PB-T1). A slot's `kind` is
 * ALSO the target port name a provider sub-connection edge lands on, so the
 * canvas can treat slots as extra, type-checked input handles.
 */
export function inputSlots(info: NodeTypeInfo | undefined): NonNullable<NodeTypeInfo['inputSlots']> {
  return info?.inputSlots ?? [];
}

/** True when this node TYPE is a provider sub-node (Chat Model / Memory / Tool). */
export function isProvider(info: NodeTypeInfo | undefined): boolean {
  return info?.role === 'provider';
}

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

  // Re-adding the EXACT same edge is a duplicate no-op — this verdict takes
  // priority over slot-arity ('slotNotRepeatable'), which is reserved for a
  // *different* provider attempting to fill an already-taken single slot.
  const dup = graph.edges.some(
    (e) =>
      e.from.node === attempt.from.node &&
      e.from.port === attempt.from.port &&
      e.to.node === attempt.to.node &&
      e.to.port === attempt.to.port,
  );
  if (dup) return { ok: false, reason: 'duplicate' };

  // ── typed sub-connection rules (PB-T1) ──────────────────────────────────
  // A slot edge lands on a target port that names one of the target's typed
  // input slots (the slot's `kind`); everything else is a plain data edge.
  const slot = inputSlots(targetInfo).find((s) => s.kind === attempt.to.port);
  const sourceProvides = sourceInfo?.provides;

  if (slot) {
    // Slot port → source must be a provider satisfying that exact kind.
    if (!isProvider(sourceInfo) || sourceProvides !== slot.kind) {
      return { ok: false, reason: 'slotKindMismatch' };
    }
    // A non-repeatable slot accepts at most one provider (a different one — the
    // identical-edge case already returned 'duplicate' above).
    if (!slot.repeatable) {
      const taken = graph.edges.some(
        (e) => e.to.node === attempt.to.node && e.to.port === attempt.to.port,
      );
      if (taken) return { ok: false, reason: 'slotNotRepeatable' };
    }
  } else {
    // Not a slot port. A provider may ONLY attach to a matching slot, so wiring
    // it into a plain data input is rejected.
    if (isProvider(sourceInfo)) {
      return { ok: false, reason: 'providerNotAttachedToSlot' };
    }
    if (!targetInfo || !targetInfo.ports.inputs.includes(attempt.to.port)) {
      return { ok: false, reason: 'unknownTargetPort' };
    }
  }

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

/** Sticky-note ids: smallest unused "note_<n>" — readable + stable. */
export function nextNoteId(graph: FlowGraph): string {
  const taken = new Set((graph.notes ?? []).map((n) => n.id));
  for (let i = 1; ; i++) {
    const candidate = `note_${i}`;
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
