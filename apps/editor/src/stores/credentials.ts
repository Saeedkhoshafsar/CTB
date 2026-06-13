/**
 * Credentials store (P3-T4) — list + CRUD over the typed client. Mirrors the
 * bots store: every mutation re-syncs from the server response so the UI never
 * drifts from the DB. The secret half NEVER reaches the client — rows carry
 * only the masked `hint` (invariant I7).
 */
import type { CreateCredentialBody, CredentialPublic, UpdateCredentialBody } from '@ctb/shared';
import { create } from 'zustand';
import { type ApiClient, api } from '../api/client';

export interface CredentialsState {
  credentials: CredentialPublic[];
  loading: boolean;
  error: string | null;
  load: () => Promise<void>;
  createCredential: (body: CreateCredentialBody) => Promise<CredentialPublic>;
  updateCredential: (id: string, body: UpdateCredentialBody) => Promise<CredentialPublic>;
  deleteCredential: (id: string) => Promise<void>;
}

export function createCredentialsStore(client: ApiClient = api) {
  return create<CredentialsState>((set, get) => ({
    credentials: [],
    loading: false,
    error: null,

    load: async () => {
      set({ loading: true, error: null });
      try {
        set({ credentials: await client.listCredentials(), loading: false });
      } catch (err) {
        set({ loading: false, error: err instanceof Error ? err.message : String(err) });
      }
    },

    createCredential: async (body) => {
      const cred = await client.createCredential(body);
      set({ credentials: [...get().credentials, cred] });
      return cred;
    },

    updateCredential: async (id, body) => {
      const cred = await client.updateCredential(id, body);
      set({ credentials: get().credentials.map((c) => (c.id === id ? cred : c)) });
      return cred;
    },

    deleteCredential: async (id) => {
      await client.deleteCredential(id);
      set({ credentials: get().credentials.filter((c) => c.id !== id) });
    },
  }));
}

export const useCredentials = createCredentialsStore();
