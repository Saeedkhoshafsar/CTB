/**
 * Run-data store (P2-T3.5) — feeds the node detail view's INPUT/OUTPUT panes.
 *
 * Loads the LATEST execution of the open flow and maps its step log onto
 * canvas node ids (run-data.ts). Refreshable on demand (the NDV's refresh
 * button); kept separate from the canvas store because run data is a
 * read-only overlay — it never touches the document, undo history or
 * autosave.
 */
import type { ExecutionSummary } from '@ctb/shared';
import { create } from 'zustand';
import { type ApiClient, api } from '../api/client';
import { mapRunData, type NodeRunData } from '../canvas/run-data';

export interface RunDataState {
  flowId: string | null;
  /** Latest execution of the flow, or null when it never ran. */
  execution: ExecutionSummary | null;
  byNode: Map<string, NodeRunData>;
  loading: boolean;
  error: string | null;

  load: (flowId: string) => Promise<void>;
  refresh: () => Promise<void>;
  reset: () => void;
}

export function createRunDataStore(client: ApiClient = api) {
  return create<RunDataState>((set, get) => ({
    flowId: null,
    execution: null,
    byNode: new Map(),
    loading: false,
    error: null,

    load: async (flowId) => {
      set({ flowId, loading: true, error: null });
      try {
        const list = await client.listExecutions({ flowId, limit: 1 });
        const latest = list[0];
        if (!latest) {
          set({ execution: null, byNode: new Map(), loading: false });
          return;
        }
        const detail = await client.getExecution(latest.id);
        set({ execution: latest, byNode: mapRunData(detail.logs), loading: false });
      } catch (err) {
        set({ loading: false, error: err instanceof Error ? err.message : String(err) });
      }
    },

    refresh: async () => {
      const { flowId } = get();
      if (flowId) await get().load(flowId);
    },

    reset: () =>
      set({ flowId: null, execution: null, byNode: new Map(), loading: false, error: null }),
  }));
}

export const useRunData = createRunDataStore();
