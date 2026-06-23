/**
 * Canvas store (P2-T2) — owns the FlowGraph document being edited.
 *
 * Design:
 *  - graph is the FlowGraph contract object, ALWAYS valid against
 *    FlowGraphSchema (every mutation goes through structured actions).
 *  - undo/redo = snapshot stacks of the graph document (small docs, simple
 *    and correct beats clever). Position drags coalesce: moveNode() updates
 *    in place and only commitMove() pushes history, so one drag = one undo.
 *  - autosave: every history-committing change marks dirty and arms a debounce;
 *    save PATCHes /api/flows/:id {graph} (server bumps version + snapshots).
 */
import {
  FlowGraphSchema,
  type FlowGraph,
  type FlowNode,
  type NodeTypeInfo,
  type StickyNote,
} from '@ctb/shared';
import { create } from 'zustand';
import { type ApiClient, api } from '../api/client';
import {
  buildEdge,
  canConnect,
  nextNodeId,
  nextNoteId,
  type ConnectionAttempt,
  type ConnectVerdict,
} from '../canvas/graph';

export type SaveState = 'clean' | 'dirty' | 'saving' | 'saved' | 'error';

const HISTORY_LIMIT = 100;
const AUTOSAVE_MS = 1200;

export interface CanvasState {
  flowId: string | null;
  graph: FlowGraph;
  nodeTypes: NodeTypeInfo[];
  byType: Map<string, NodeTypeInfo>;
  loading: boolean;
  loadError: string | null;
  saveState: SaveState;
  version: number;
  past: FlowGraph[];
  future: FlowGraph[];

  load: (flowId: string) => Promise<void>;
  /** add a node of `type` at canvas position; returns its new id. */
  addNode: (type: string, position: { x: number; y: number }) => string;
  removeNodes: (nodeIds: string[]) => void;
  removeEdges: (edgeIds: string[]) => void;
  connect: (attempt: ConnectionAttempt) => ConnectVerdict;
  /** live drag update — no history entry. */
  moveNode: (nodeId: string, position: { x: number; y: number }) => void;
  /** drag finished — one history entry for the whole gesture. */
  commitMove: () => void;
  updateNode: (nodeId: string, patch: Partial<Pick<FlowNode, 'params' | 'disabled' | 'note' | 'title'>>) => void;

  // ── sticky notes (H-T1) ──────────────────────────────────────────────────
  /** add a sticky note at canvas position; returns its new id. */
  addNote: (position: { x: number; y: number }) => string;
  /** edit a note's text / colour / size (one history entry). */
  updateNote: (
    noteId: string,
    patch: Partial<Pick<StickyNote, 'text' | 'color' | 'size'>>,
  ) => void;
  removeNotes: (noteIds: string[]) => void;
  /** live drag update of a note — no history entry (coalesced like moveNode). */
  moveNote: (noteId: string, position: { x: number; y: number }) => void;
  /** live resize update of a note — no history entry (commit via commitMove). */
  resizeNote: (noteId: string, size: { width: number; height: number }) => void;
  undo: () => void;
  redo: () => void;
  canUndo: () => boolean;
  canRedo: () => boolean;
  /** flush pending autosave immediately (Ctrl+S / navigating away). */
  saveNow: () => Promise<void>;
  reset: () => void;
}

export function createCanvasStore(client: ApiClient = api, autosaveMs: number = AUTOSAVE_MS) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  /** graph as it looked before the in-progress drag (for commitMove history). */
  let preMove: FlowGraph | null = null;

  return create<CanvasState>((set, get) => {
    const armAutosave = (): void => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        void get().saveNow();
      }, autosaveMs);
    };

    /** push current graph to past, replace it, mark dirty, arm autosave. */
    const commit = (nextGraph: FlowGraph): void => {
      const { graph, past } = get();
      set({
        graph: nextGraph,
        past: [...past.slice(-HISTORY_LIMIT + 1), graph],
        future: [],
        saveState: 'dirty',
      });
      armAutosave();
    };

    return {
      flowId: null,
      graph: { nodes: [], edges: [], notes: [] },
      nodeTypes: [],
      byType: new Map(),
      loading: false,
      loadError: null,
      saveState: 'clean',
      version: 0,
      past: [],
      future: [],

      load: async (flowId) => {
        get().reset();
        set({ loading: true, flowId });
        try {
          const [flow, nodeTypes] = await Promise.all([
            client.getFlow(flowId),
            client.listNodeTypes(),
          ]);
          set({
            graph: FlowGraphSchema.parse(flow.graph), // normalize defaults once
            version: flow.version,
            nodeTypes,
            byType: new Map(nodeTypes.map((nt) => [nt.type, nt])),
            loading: false,
          });
        } catch (err) {
          set({ loading: false, loadError: err instanceof Error ? err.message : String(err) });
        }
      },

      addNode: (type, position) => {
        const { graph } = get();
        const id = nextNodeId(type, graph);
        const node: FlowNode = { id, type, params: {}, position, disabled: false };
        commit({ ...graph, nodes: [...graph.nodes, node] });
        return id;
      },

      removeNodes: (nodeIds) => {
        if (nodeIds.length === 0) return;
        const gone = new Set(nodeIds);
        const { graph } = get();
        commit({
          nodes: graph.nodes.filter((n) => !gone.has(n.id)),
          // edges touching a removed node go with it (FlowGraphSchema would reject danglers)
          edges: graph.edges.filter((e) => !gone.has(e.from.node) && !gone.has(e.to.node)),
        });
      },

      removeEdges: (edgeIds) => {
        if (edgeIds.length === 0) return;
        const gone = new Set(edgeIds);
        const { graph } = get();
        commit({ ...graph, edges: graph.edges.filter((e) => !gone.has(e.id)) });
      },

      connect: (attempt) => {
        const { graph, byType } = get();
        const verdict = canConnect(attempt, graph, byType);
        if (verdict.ok) {
          commit({ ...graph, edges: [...graph.edges, buildEdge(attempt, graph)] });
        }
        return verdict;
      },

      moveNode: (nodeId, position) => {
        const { graph } = get();
        if (!preMove) preMove = graph;
        set({
          graph: {
            ...graph,
            nodes: graph.nodes.map((n) => (n.id === nodeId ? { ...n, position } : n)),
          },
        });
      },

      commitMove: () => {
        if (!preMove) return;
        const before = preMove;
        preMove = null;
        const { graph, past } = get();
        // no-op drags (click without move) shouldn't pollute history
        if (before === graph) return;
        set({
          past: [...past.slice(-HISTORY_LIMIT + 1), before],
          future: [],
          saveState: 'dirty',
        });
        armAutosave();
      },

      updateNode: (nodeId, patch) => {
        const { graph } = get();
        const target = graph.nodes.find((n) => n.id === nodeId);
        if (!target) return;
        commit({
          ...graph,
          nodes: graph.nodes.map((n) => (n.id === nodeId ? { ...n, ...patch } : n)),
        });
      },

      // ── sticky notes (H-T1) ───────────────────────────────────────────────
      addNote: (position) => {
        const { graph } = get();
        const id = nextNoteId(graph);
        const note: StickyNote = {
          id,
          text: '',
          position,
          size: { width: 240, height: 160 },
          color: 'yellow',
        };
        commit({ ...graph, notes: [...(graph.notes ?? []), note] });
        return id;
      },

      updateNote: (noteId, patch) => {
        const { graph } = get();
        const notes = graph.notes ?? [];
        if (!notes.some((n) => n.id === noteId)) return;
        commit({
          ...graph,
          notes: notes.map((n) => (n.id === noteId ? { ...n, ...patch } : n)),
        });
      },

      removeNotes: (noteIds) => {
        if (noteIds.length === 0) return;
        const gone = new Set(noteIds);
        const { graph } = get();
        commit({ ...graph, notes: (graph.notes ?? []).filter((n) => !gone.has(n.id)) });
      },

      // Live note drag/resize reuse the same preMove/commitMove coalescing as
      // node drags, so one gesture = one undo entry (commitMove is called on
      // gesture end by the canvas change handler).
      moveNote: (noteId, position) => {
        const { graph } = get();
        if (!preMove) preMove = graph;
        set({
          graph: {
            ...graph,
            notes: (graph.notes ?? []).map((n) => (n.id === noteId ? { ...n, position } : n)),
          },
        });
      },

      resizeNote: (noteId, size) => {
        const { graph } = get();
        if (!preMove) preMove = graph;
        set({
          graph: {
            ...graph,
            notes: (graph.notes ?? []).map((n) => (n.id === noteId ? { ...n, size } : n)),
          },
        });
      },

      undo: () => {
        const { past, future, graph } = get();
        const prev = past[past.length - 1];
        if (!prev) return;
        set({
          graph: prev,
          past: past.slice(0, -1),
          future: [graph, ...future],
          saveState: 'dirty',
        });
        armAutosave();
      },

      redo: () => {
        const { past, future, graph } = get();
        const next = future[0];
        if (!next) return;
        set({
          graph: next,
          past: [...past, graph],
          future: future.slice(1),
          saveState: 'dirty',
        });
        armAutosave();
      },

      canUndo: () => get().past.length > 0,
      canRedo: () => get().future.length > 0,

      saveNow: async () => {
        const { flowId, graph, saveState } = get();
        if (!flowId || saveState === 'clean' || saveState === 'saved') return;
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        set({ saveState: 'saving' });
        try {
          const flow = await client.updateFlow(flowId, { graph });
          // a commit may have landed while the PATCH was in flight — stay dirty then
          const stillSame = get().graph === graph;
          set({ version: flow.version, saveState: stillSame ? 'saved' : 'dirty' });
          if (!stillSame) armAutosave();
        } catch {
          set({ saveState: 'error' });
        }
      },

      reset: () => {
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        preMove = null;
        set({
          flowId: null,
          graph: { nodes: [], edges: [], notes: [] },
          loading: false,
          loadError: null,
          saveState: 'clean',
          version: 0,
          past: [],
          future: [],
        });
      },
    };
  });
}

export const useCanvas = createCanvasStore();
