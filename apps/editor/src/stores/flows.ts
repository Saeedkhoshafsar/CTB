/**
 * Flows store (P2-T1) — flows of the currently-viewed bot.
 * The canvas store (P2-T2) will layer graph editing on top; this store owns
 * only list/lifecycle concerns.
 */
import type { CreateFlowBody, FlowPublic } from '@ctb/shared';
import { create } from 'zustand';
import { type ApiClient, api } from '../api/client';

export interface FlowsState {
  /** botId the current list belongs to (avoids showing stale lists). */
  botId: string | null;
  flows: FlowPublic[];
  loading: boolean;
  error: string | null;
  load: (botId: string) => Promise<void>;
  createFlow: (body: CreateFlowBody) => Promise<FlowPublic>;
  deleteFlow: (id: string) => Promise<void>;
  activateFlow: (id: string) => Promise<void>;
  deactivateFlow: (id: string) => Promise<void>;
}

export function createFlowsStore(client: ApiClient = api) {
  const refreshOne = async (id: string, set: (p: Partial<FlowsState>) => void, get: () => FlowsState) => {
    const flow = await client.getFlow(id);
    set({ flows: get().flows.map((f) => (f.id === id ? flow : f)) });
  };

  return create<FlowsState>((set, get) => ({
    botId: null,
    flows: [],
    loading: false,
    error: null,

    load: async (botId) => {
      set({ loading: true, error: null, botId });
      try {
        set({ flows: await client.listFlows(botId), loading: false });
      } catch (err) {
        set({ loading: false, error: err instanceof Error ? err.message : String(err) });
      }
    },

    createFlow: async (body) => {
      const flow = await client.createFlow(body);
      if (get().botId === body.botId) set({ flows: [...get().flows, flow] });
      return flow;
    },

    deleteFlow: async (id) => {
      await client.deleteFlow(id);
      set({ flows: get().flows.filter((f) => f.id !== id) });
    },

    activateFlow: async (id) => {
      await client.activateFlow(id);
      await refreshOne(id, set, get);
    },

    deactivateFlow: async (id) => {
      await client.deactivateFlow(id);
      await refreshOne(id, set, get);
    },
  }));
}

export const useFlows = createFlowsStore();
