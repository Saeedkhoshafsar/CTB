/**
 * Bots store (P2-T1) — list + CRUD actions over the typed client.
 * Mutations are optimistic-free in v1: every action re-syncs from the
 * server response so the UI can never drift from the DB.
 */
import type { BotPublic, CreateBotBody } from '@ctb/shared';
import { create } from 'zustand';
import { type ApiClient, api } from '../api/client';

export interface BotsState {
  bots: BotPublic[];
  loading: boolean;
  error: string | null;
  load: () => Promise<void>;
  createBot: (body: CreateBotBody) => Promise<BotPublic>;
  deleteBot: (id: string) => Promise<void>;
  startBot: (id: string) => Promise<void>;
  stopBot: (id: string) => Promise<void>;
}

export function createBotsStore(client: ApiClient = api) {
  return create<BotsState>((set, get) => ({
    bots: [],
    loading: false,
    error: null,

    load: async () => {
      set({ loading: true, error: null });
      try {
        set({ bots: await client.listBots(), loading: false });
      } catch (err) {
        set({ loading: false, error: err instanceof Error ? err.message : String(err) });
      }
    },

    createBot: async (body) => {
      const bot = await client.createBot(body);
      set({ bots: [...get().bots, bot] });
      return bot;
    },

    deleteBot: async (id) => {
      await client.deleteBot(id);
      set({ bots: get().bots.filter((b) => b.id !== id) });
    },

    startBot: async (id) => {
      await client.startBot(id);
      const bot = await client.getBot(id);
      set({ bots: get().bots.map((b) => (b.id === id ? bot : b)) });
    },

    stopBot: async (id) => {
      await client.stopBot(id);
      const bot = await client.getBot(id);
      set({ bots: get().bots.map((b) => (b.id === id ? bot : b)) });
    },
  }));
}

export const useBots = createBotsStore();
