/**
 * Users store (Users page, P3-T5) — list + edit over the typed client. Users
 * are per-bot (like flows), so `load` takes a botId. Edits (tags / profile)
 * re-sync from the server response so the UI never drifts from the DB. The
 * store is GENERIC: it knows tags + a free-form profile bag, no domain field.
 */
import type { UpdateUserBody, UserPublic } from '@ctb/shared';
import { create } from 'zustand';
import { type ApiClient, api } from '../api/client';

export interface UsersState {
  users: UserPublic[];
  botId: string | null;
  loading: boolean;
  error: string | null;
  load: (botId: string) => Promise<void>;
  updateUser: (id: string, body: UpdateUserBody) => Promise<UserPublic>;
}

export function createUsersStore(client: ApiClient = api) {
  return create<UsersState>((set, get) => ({
    users: [],
    botId: null,
    loading: false,
    error: null,

    load: async (botId) => {
      set({ loading: true, error: null, botId });
      try {
        set({ users: await client.listUsers(botId), loading: false });
      } catch (err) {
        set({ loading: false, error: err instanceof Error ? err.message : String(err) });
      }
    },

    updateUser: async (id, body) => {
      const user = await client.updateUser(id, body);
      set({ users: get().users.map((u) => (u.id === id ? user : u)) });
      return user;
    },
  }));
}

export const useUsers = createUsersStore();
