/**
 * Flow lifecycle store (P2-T4) — activation state, validation problems,
 * version history + rollback for the flow OPEN IN THE EDITOR.
 *
 * Separate from the canvas store on purpose: the canvas owns the editable
 * document (undo/autosave), this store owns server-side lifecycle facts
 * (status, activation problems, version list). Rollback returns the fresh
 * FlowPublic so the PAGE decides how to reload the document — the lifecycle
 * store never reaches into canvas history.
 *
 * Activation problems come back as structured `FlowProblem[]` (shared DTO,
 * P2-T4): `nodeId` lets the canvas badge the offending node; `nodeId: null`
 * is a flow-level problem (e.g. "no enabled trigger") shown in the toolbar
 * strip.
 */
import type { FlowProblem, FlowPublic, FlowStatus, FlowVersionInfo } from '@ctb/shared';
import { create } from 'zustand';
import { ApiError, type ApiClient, api } from '../api/client';

export interface LifecycleState {
  flowId: string | null;
  status: FlowStatus;
  /** Last activation attempt's problems ([] = none / not attempted). */
  problems: FlowProblem[];
  /** nodeId → messages, derived once per set for cheap canvas lookups. */
  problemsByNode: Map<string, string[]>;
  busy: boolean;
  error: string | null;

  versionsOpen: boolean;
  versions: FlowVersionInfo[];
  current: number;
  versionsLoading: boolean;

  init: (flowId: string, status: FlowStatus) => void;
  /** Try to activate; on 422 stores the structured problems. true = activated. */
  activate: () => Promise<boolean>;
  deactivate: () => Promise<void>;
  clearProblems: () => void;
  toggleVersions: () => void;
  loadVersions: () => Promise<void>;
  /** Restore a snapshot; returns the new FlowPublic (caller reloads the canvas). */
  rollback: (version: number) => Promise<FlowPublic | null>;
  reset: () => void;
}

function byNode(problems: FlowProblem[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const p of problems) {
    if (!p.nodeId) continue;
    map.set(p.nodeId, [...(map.get(p.nodeId) ?? []), p.message]);
  }
  return map;
}

const INITIAL = {
  flowId: null,
  status: 'draft' as FlowStatus,
  problems: [] as FlowProblem[],
  problemsByNode: new Map<string, string[]>(),
  busy: false,
  error: null,
  versionsOpen: false,
  versions: [] as FlowVersionInfo[],
  current: 0,
  versionsLoading: false,
};

export function createLifecycleStore(client: ApiClient = api) {
  return create<LifecycleState>((set, get) => ({
    ...INITIAL,
    problemsByNode: new Map(),

    init: (flowId, status) => {
      set({ ...INITIAL, problemsByNode: new Map(), flowId, status });
    },

    activate: async () => {
      const { flowId } = get();
      if (!flowId) return false;
      set({ busy: true, error: null });
      try {
        await client.activateFlow(flowId);
        set({ busy: false, status: 'active', problems: [], problemsByNode: new Map() });
        return true;
      } catch (err) {
        if (err instanceof ApiError && err.status === 422) {
          // structured problems when the server sends them; fall back to strings
          const probs: FlowProblem[] =
            err.body.nodeProblems ??
            (err.body.problems ?? ['not activatable']).map((message) => ({ nodeId: null, message }));
          set({ busy: false, problems: probs, problemsByNode: byNode(probs) });
        } else {
          set({ busy: false, error: err instanceof Error ? err.message : String(err) });
        }
        return false;
      }
    },

    deactivate: async () => {
      const { flowId } = get();
      if (!flowId) return;
      set({ busy: true, error: null });
      try {
        await client.deactivateFlow(flowId);
        set({ busy: false, status: 'draft' });
      } catch (err) {
        set({ busy: false, error: err instanceof Error ? err.message : String(err) });
      }
    },

    clearProblems: () => set({ problems: [], problemsByNode: new Map() }),

    toggleVersions: () => {
      const open = !get().versionsOpen;
      set({ versionsOpen: open });
      if (open) void get().loadVersions();
    },

    loadVersions: async () => {
      const { flowId } = get();
      if (!flowId) return;
      set({ versionsLoading: true, error: null });
      try {
        const res = await client.listFlowVersions(flowId);
        set({ versionsLoading: false, versions: res.versions, current: res.current });
      } catch (err) {
        set({ versionsLoading: false, error: err instanceof Error ? err.message : String(err) });
      }
    },

    rollback: async (version) => {
      const { flowId } = get();
      if (!flowId) return null;
      set({ busy: true, error: null });
      try {
        const flow = await client.rollbackFlow(flowId, version);
        set({ busy: false, status: flow.status, problems: [], problemsByNode: new Map() });
        await get().loadVersions(); // the outgoing graph became a new snapshot
        return flow;
      } catch (err) {
        set({ busy: false, error: err instanceof Error ? err.message : String(err) });
        return null;
      }
    },

    reset: () => set({ ...INITIAL, problemsByNode: new Map() }),
  }));
}

export const useLifecycle = createLifecycleStore();
