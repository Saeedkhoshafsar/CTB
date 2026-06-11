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
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useCallback, useMemo, useRef, type DragEvent } from 'react';
import { useCanvas } from '../stores/canvas';
import { CtbNode } from './CtbNode';
import { flowToRfEdges, flowToRfNodes, type CtbRfNode } from './graph';
import { PALETTE_MIME } from './Palette';
import { create } from 'zustand';

const nodeTypes = { ctb: CtbNode };

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

  const rfNodes = useMemo(
    () => flowToRfNodes(graph, byType, selection.nodes),
    [graph, byType, selection.nodes],
  );
  const rfEdges = useMemo(() => flowToRfEdges(graph, selection.edges), [graph, selection.edges]);

  const onNodesChange = useCallback(
    (changes: NodeChange<CtbRfNode>[]) => {
      let selNodes: Set<string> | null = null;
      const removed: string[] = [];
      for (const ch of changes) {
        if (ch.type === 'position' && ch.position) {
          useCanvas.getState().moveNode(ch.id, ch.position);
          if (ch.dragging === false) useCanvas.getState().commitMove();
        } else if (ch.type === 'select') {
          selNodes ??= new Set(useSelection.getState().nodes);
          if (ch.selected) selNodes.add(ch.id);
          else selNodes.delete(ch.id);
        } else if (ch.type === 'remove') {
          removed.push(ch.id);
        }
      }
      if (selNodes) useSelection.getState().set(selNodes, useSelection.getState().edges);
      if (removed.length) useCanvas.getState().removeNodes(removed);
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

  const onConnect = useCallback((conn: Connection) => {
    if (!conn.source || !conn.target) return;
    useCanvas.getState().connect({
      from: { node: conn.source, port: conn.sourceHandle ?? 'main' },
      to: { node: conn.target, port: conn.targetHandle ?? 'main' },
    });
  }, []);

  /** port-aware pre-check so React Flow shows invalid targets as forbidden. */
  const isValidConnection = useCallback(
    (conn: Connection | { source: string; target: string; sourceHandle?: string | null; targetHandle?: string | null }) => {
      const { graph: g, byType: bt } = useCanvas.getState();
      const verdict = (() => {
        const source = g.nodes.find((n) => n.id === conn.source);
        const target = g.nodes.find((n) => n.id === conn.target);
        if (!source || !target || source.id === target.id) return false;
        const si = bt.get(source.type);
        const ti = bt.get(target.type);
        return Boolean(
          si?.ports.outputs.includes(conn.sourceHandle ?? 'main') &&
            ti?.ports.inputs.includes(conn.targetHandle ?? 'main'),
        );
      })();
      return verdict;
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
    <ReactFlow
      nodes={rfNodes}
      edges={rfEdges}
      nodeTypes={nodeTypes}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      onConnect={onConnect}
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
  );
}

export { CanvasInner as FlowCanvas };
