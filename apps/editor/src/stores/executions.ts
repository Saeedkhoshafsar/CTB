/**
 * Executions inspector store (P2-T5) — list + filters + detail + cancel.
 *
 * Read-mostly server facts, separate from canvas/run-data: the inspector is
 * a standalone page (any flow, any bot), while run-data is the NDV's overlay
 * for the flow open in the editor. The page drives "live-ish" refresh by
 * calling `refresh()` on an interval — the store itself owns no timer, so
 * tests stay deterministic and unmount can't leak.
 *
 * Cancel updates BOTH the list row and the open detail from the server's
 * response (no optimistic drift — same rule as the bots/flows stores), then
 * re-fetches the detail so the audit log row appears immediately.
 */
import type { ExecutionDetail, ExecutionStatus, ExecutionSummary } from '@ctb/shared';
import { create } from 'zustand';
import { ApiError, type ApiClient, api } from '../api/client';

export type StatusFilter = ExecutionStatus | 'all';

export interface ExecutionsState {
  rows: ExecutionSummary[];
  status: StatusFilter;
  /** Optional flow scope (deep link from the flow editor). */
  flowId: string | null;
  loading: boolean;
  error: string | null;

  selectedId: string | null;
  detail: ExecutionDetail | null;
  detailLoading: boolean;

  /** True while a refresh is in flight — guards overlapping interval ticks. */
  refreshing: boolean;

  load: (opts?: { status?: StatusFilter; flowId?: string | null }) => Promise<void>;
  setStatus: (status: StatusFilter) => Promise<void>;
  /** Re-fetch list (and open detail) without dropping current view state. */
  refresh: () => Promise<void>;
  select: (id: string | null) => Promise<void>;
  /** Cancel a live execution. true = canceled (409 just refreshes the truth). */
  cancel: (id: string) => Promise<boolean>;
  reset: () => void;
}

const INITIAL = {
  rows: [] as ExecutionSummary[],
  status: 'all' as StatusFilter,
  flowId: null as string | null,
  loading: false,
  error: null as string | null,
  selectedId: null as string | null,
  detail: null as ExecutionDetail | null,
  detailLoading: false,
  refreshing: false,
};

export function createExecutionsStore(client: ApiClient = api) {
  async function fetchRows(status: StatusFilter, flowId: string | null): Promise<ExecutionSummary[]> {
    return client.listExecutions({
      ...(status !== 'all' ? { status } : {}),
      ...(flowId ? { flowId } : {}),
      limit: 100,
    });
  }

  return create<ExecutionsState>((set, get) => ({
    ...INITIAL,

    load: async (opts = {}) => {
      const status = opts.status ?? get().status;
      const flowId = opts.flowId !== undefined ? opts.flowId : get().flowId;
      set({ status, flowId, loading: true, error: null });
      try {
        const rows = await fetchRows(status, flowId);
        set({ rows, loading: false });
      } catch (err) {
        set({ loading: false, error: err instanceof Error ? err.message : String(err) });
      }
    },

    setStatus: async (status) => {
      await get().load({ status });
    },

    refresh: async () => {
      if (get().refreshing) return; // interval tick while previous fetch is slow
      set({ refreshing: true });
      try {
        const { status, flowId, selectedId } = get();
        const rows = await fetchRows(status, flowId);
        set({ rows, error: null });
        if (selectedId) {
          // keep the open detail in sync (a waiting row may have resumed)
          const detail = await client.getExecution(selectedId);
          // only apply if the user hasn't switched selection meanwhile
          if (get().selectedId === selectedId) set({ detail });
        }
      } catch (err) {
        set({ error: err instanceof Error ? err.message : String(err) });
      } finally {
        set({ refreshing: false });
      }
    },

    select: async (id) => {
      if (id === null) {
        set({ selectedId: null, detail: null, detailLoading: false });
        return;
      }
      set({ selectedId: id, detail: null, detailLoading: true });
      try {
        const detail = await client.getExecution(id);
        if (get().selectedId === id) set({ detail, detailLoading: false });
      } catch (err) {
        set({ detailLoading: false, error: err instanceof Error ? err.message : String(err) });
      }
    },

    cancel: async (id) => {
      try {
        const summary = await client.cancelExecution(id);
        set({ rows: get().rows.map((r) => (r.id === id ? summary : r)) });
        if (get().selectedId === id) {
          const detail = await client.getExecution(id); // pick up the audit log row
          if (get().selectedId === id) set({ detail });
        }
        return true;
      } catch (err) {
        if (err instanceof ApiError && (err.status === 409 || err.status === 404)) {
          // already finished / gone — refresh shows the truth, not an error
          await get().refresh();
          return false;
        }
        set({ error: err instanceof Error ? err.message : String(err) });
        return false;
      }
    },

    reset: () => set({ ...INITIAL }),
  }));
}

export const useExecutions = createExecutionsStore();
