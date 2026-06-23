/**
 * React Flow canvas wrapper (P2-T2).
 *
 * React Flow is a CONTROLLED view here: nodes/edges are derived from the
 * canvas store's FlowGraph on every render; user gestures translate back
 * into store actions (the store is the only writer of the document). This
 * keeps undo/redo/autosave correct without syncing two sources of truth.
 */
import {
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  useReactFlow,
  type Connection,
  type EdgeChange,
  type NodeChange,
  type OnConnectStartParams,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useCallback, useEffect, useMemo, useRef, type DragEvent } from 'react';
import { useCanvas } from '../stores/canvas';
import { CtbNode } from './CtbNode';
import { CtbEdge } from './CtbEdge';
import {
  canConnect,
  flowToRfEdges,
  flowToRfNodes,
  noteIdFromRf,
  notesToRfNodes,
  type AnyRfNode,
  type CtbRfNode,
  type PendingConnect,
} from './graph';
import { StickyNote } from './StickyNote';
import { useNodeDetail } from './NodeDetail';
import { NodePicker, useNodePicker, type PickerIntent } from './NodePicker';
import { PALETTE_MIME } from './Palette';
import { create } from 'zustand';

const nodeTypes = { ctb: CtbNode, sticky: StickyNote };
const edgeTypes = { default: CtbEdge };

/** selection is view-state, not document-state — lives outside undo history. */
interface SelectionState {
  nodes: Set<string>;
  edges: Set<string>;
  set: (nodes: Set<string>, edges: Set<string>) => void;
}
export const useSelection = create<SelectionState>((set) => ({
  nodes: new Set<string>(),
  edges: new Set<string>(),
  set: (nodes, edges) => set({ nodes, edges }),
}));

function CanvasInner() {
  const graph = useCanvas((s) => s.graph);
  const byType = useCanvas((s) => s.byType);
  const canvas = useRef(useCanvas.getState()).current; // stable action refs
  const selection = useSelection();
  const { screenToFlowPosition } = useReactFlow();

  const rfNodes = useMemo<AnyRfNode[]>(
    // notes first so they paint BEHIND the flow nodes (z-index also set to 0)
    () => [
      ...notesToRfNodes(graph, selection.nodes),
      ...flowToRfNodes(graph, byType, selection.nodes),
    ],
    [graph, byType, selection.nodes],
  );
  const rfEdges = useMemo(
    () => flowToRfEdges(graph, selection.edges, byType),
    [graph, selection.edges, byType],
  );

  const onNodesChange = useCallback(
    (changes: NodeChange<AnyRfNode>[]) => {
      let selNodes: Set<string> | null = null;
      const removedNodes: string[] = [];
      const removedNotes: string[] = [];
      const store = useCanvas.getState();
      for (const ch of changes) {
        // A sticky note's RF id is "note:<id>"; everything else is a flow node.
        const noteId = 'id' in ch ? noteIdFromRf(ch.id) : null;
        if (ch.type === 'position' && ch.position) {
          if (noteId) store.moveNote(noteId, ch.position);
          else store.moveNode(ch.id, ch.position);
          if (ch.dragging === false) store.commitMove();
        } else if (ch.type === 'dimensions' && ch.dimensions && ch.resizing !== undefined) {
          // live resize of a sticky note (NodeResizer drives this); the final
          // size is also committed via the component's onResizeEnd, but driving
          // the live value here keeps the box tracking the handle smoothly.
          if (noteId)
            store.resizeNote(noteId, {
              width: ch.dimensions.width,
              height: ch.dimensions.height,
            });
          if (ch.resizing === false) store.commitMove();
        } else if (ch.type === 'select') {
          selNodes ??= new Set(useSelection.getState().nodes);
          if (ch.selected) selNodes.add(ch.id);
          else selNodes.delete(ch.id);
        } else if (ch.type === 'remove') {
          if (noteId) removedNotes.push(noteId);
          else removedNodes.push(ch.id);
        }
      }
      if (selNodes) useSelection.getState().set(selNodes, useSelection.getState().edges);
      if (removedNodes.length) store.removeNodes(removedNodes);
      if (removedNotes.length) store.removeNotes(removedNotes);
    },
    [],
  );

  const onEdgesChange = useCallback((changes: EdgeChange[]) => {
    let selEdges: Set<string> | null = null;
    const removed: string[] = [];
    for (const ch of changes) {
      if (ch.type === 'select') {
        selEdges ??= new Set(useSelection.getState().edges);
        if (ch.selected) selEdges.add(ch.id);
        else selEdges.delete(ch.id);
      } else if (ch.type === 'remove') {
        removed.push(ch.id);
      }
    }
    if (selEdges) useSelection.getState().set(useSelection.getState().nodes, selEdges);
    if (removed.length) useCanvas.getState().removeEdges(removed);
  }, []);

  /**
   * Double-click opens the node detail view (n8n NDV, P2-T3.5).
   *
   * React Flow's own onNodeDoubleClick is unreliable here: it doesn't fire for
   * a real user's sequential clicks, and by the time the native `dblclick`
   * event fires the `.react-flow__pane` interaction layer is the event target —
   * so neither composedPath nor an elementsFromPoint hit-test finds the node
   * (verified via UI probe, including a genuine Chrome double-click over CDP).
   *
   * Instead we install CAPTURE-phase listeners on the canvas wrapper (which run
   * before React Flow's handlers): we remember the node pressed on the gesture's
   * first `mousedown` — when the node IS still the target — and open its NDV
   * when the `dblclick` arrives within the OS double-click window.
   */
  const wrapRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    // Resolve the node under an event's target chain, falling back to a
    // point hit-test (covers React Flow's pane intercepting the target).
    const nodeIdAt = (e: globalThis.MouseEvent): string | null => {
      const path = (e.composedPath?.() ?? []) as HTMLElement[];
      for (const p of path) {
        const id = p?.getAttribute?.('data-id');
        if (id && p.classList?.contains('react-flow__node')) return id;
      }
      for (const hit of document.elementsFromPoint(e.clientX, e.clientY)) {
        const nodeEl = (hit as HTMLElement).closest?.('.react-flow__node[data-id]') as HTMLElement | null;
        const id = nodeEl?.getAttribute('data-id');
        if (id) return id;
      }
      return null;
    };
    // On a real double-click React Flow's interaction pane is the dblclick
    // target, so by then the node is no longer under the pointer. We instead
    // remember the node pressed on the FIRST mousedown of the gesture and open
    // its NDV when the dblclick fires (within the OS double-click window).
    let pressedId: string | null = null;
    let pressedAt = 0;
    const onDown = (e: globalThis.MouseEvent) => {
      const id = nodeIdAt(e);
      if (id) { pressedId = id; pressedAt = Date.now(); }
    };
    const onDbl = (e: globalThis.MouseEvent) => {
      const direct = nodeIdAt(e);
      const id = direct ?? (Date.now() - pressedAt <= 700 ? pressedId : null);
      // Sticky notes ("note:<id>") handle their own in-place edit on dblclick —
      // don't open the node-detail view for them.
      if (id && noteIdFromRf(id) === null) useNodeDetail.getState().open(id);
    };
    el.addEventListener('mousedown', onDown, true); // capture, before React Flow
    el.addEventListener('dblclick', onDbl, true);
    return () => {
      el.removeEventListener('mousedown', onDown, true);
      el.removeEventListener('dblclick', onDbl, true);
    };
  }, []);

  const onConnect = useCallback((conn: Connection) => {
    if (!conn.source || !conn.target) return;
    useCanvas.getState().connect({
      from: { node: conn.source, port: conn.sourceHandle ?? 'main' },
      to: { node: conn.target, port: conn.targetHandle ?? 'main' },
    });
  }, []);

  /**
   * H-T4 (gap G9) — wire-drop-to-palette. We remember which handle a connection
   * drag STARTED from (onConnectStart); if it ends on the empty pane rather than
   * a handle (onConnectEnd with no valid Connection), we open the NodePicker
   * pre-targeted at the dangling end so picking a type creates + wires the node.
   */
  const pending = useRef<OnConnectStartParams | null>(null);
  const onConnectStart = useCallback(
    (_e: unknown, params: OnConnectStartParams) => {
      pending.current = params;
    },
    [],
  );
  const onConnectEnd = useCallback(
    (e: MouseEvent | TouchEvent) => {
      const params = pending.current;
      pending.current = null;
      if (!params?.nodeId) return;
      // a drop ON a handle is handled by onConnect; only act on a pane drop
      const target = e.target as HTMLElement | null;
      const onPane = !!target?.classList?.contains('react-flow__pane');
      if (!onPane) return;
      const pt = 'changedTouches' in e ? e.changedTouches[0] : e;
      const at = { x: pt?.clientX ?? 0, y: pt?.clientY ?? 0 };
      // dragging FROM an output handle gives a source; FROM an input gives a target
      const port = params.handleId ?? 'main';
      const pc: PendingConnect =
        params.handleType === 'target'
          ? { target: params.nodeId, toPort: port }
          : { source: params.nodeId, fromPort: port };
      useNodePicker.getState().open(at, { kind: 'dangling', pending: pc });
    },
    [],
  );

  /**
   * The NodePicker reports the chosen type + the live intent + the screen point.
   * Add-on-edge splits the edge; wire-drop creates the node at the drop point
   * (converted to flow coords) already wired to the dangling end.
   */
  const onPick = useCallback(
    (type: string, intent: PickerIntent, at: { x: number; y: number }) => {
      const store = useCanvas.getState();
      const pos = screenToFlowPosition({ x: at.x, y: at.y });
      const position = { x: Math.round(pos.x), y: Math.round(pos.y) };
      if (intent.kind === 'edge') store.insertNodeOnEdge(intent.edgeId, type, position);
      else store.addNodeFromDangling(intent.pending, type, position);
    },
    [screenToFlowPosition],
  );

  /**
   * port-aware pre-check so React Flow shows invalid targets as forbidden.
   * Delegates to the SAME shared `canConnect` the store commits with, so the
   * drag preview and the actual edit agree — including the PB-T1 typed
   * sub-connection rules (a provider only into a matching slot, etc.).
   */
  const isValidConnection = useCallback(
    (conn: Connection | { source: string; target: string; sourceHandle?: string | null; targetHandle?: string | null }) => {
      if (!conn.source || !conn.target) return false;
      const { graph: g, byType: bt } = useCanvas.getState();
      return canConnect(
        {
          from: { node: conn.source, port: conn.sourceHandle ?? 'main' },
          to: { node: conn.target, port: conn.targetHandle ?? 'main' },
        },
        g,
        bt,
      ).ok;
    },
    [],
  );

  const onDragOver = useCallback((e: DragEvent) => {
    if (e.dataTransfer.types.includes(PALETTE_MIME)) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
    }
  }, []);

  const onDrop = useCallback(
    (e: DragEvent) => {
      const type = e.dataTransfer.getData(PALETTE_MIME);
      if (!type) return;
      e.preventDefault();
      const pos = screenToFlowPosition({ x: e.clientX, y: e.clientY });
      canvas.addNode(type, { x: Math.round(pos.x), y: Math.round(pos.y) });
    },
    [screenToFlowPosition, canvas],
  );

  return (
    <div ref={wrapRef} style={{ width: '100%', height: '100%' }}>
      <ReactFlow
        nodes={rfNodes}
        edges={rfEdges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onConnectStart={onConnectStart}
        onConnectEnd={onConnectEnd}
        isValidConnection={isValidConnection}
        onDragOver={onDragOver}
        onDrop={onDrop}
        deleteKeyCode={['Delete', 'Backspace']}
        fitView
        proOptions={{ hideAttribution: true }}
        colorMode="dark"
      >
        <Background gap={20} />
        <Controls position="bottom-right" />
        <MiniMap pannable zoomable position="bottom-left" />
      </ReactFlow>
      <NodePicker onPick={onPick} />
    </div>
  );
}

export { CanvasInner as FlowCanvas };
