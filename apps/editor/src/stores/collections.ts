/**
 * Collections store (Data section, P3.5-T3) — list + define + alter + drop over
 * the typed client. Collections are per-bot (ARCHITECTURE §13.7), so `load`
 * takes a botId. Every mutation re-syncs from the server response so the UI never
 * drifts from the DB.
 *
 * GENERIC by construction (invariant I2): the store knows "a collection has a
 * field schema + display hints", never a domain ("product"). It also exposes a
 * thin `recordCount` helper the schema-builder uses to warn before a destructive
 * edit (removing a field) — the accept criterion for P3.5-T3.
 */
import type {
  CollectionPublic,
  CreateCollectionBody,
  UpdateCollectionBody,
} from '@ctb/shared';
import { create } from 'zustand';
import { type ApiClient, api } from '../api/client';

export interface CollectionsState {
  collections: CollectionPublic[];
  botId: string | null;
  loading: boolean;
  error: string | null;
  load: (botId: string) => Promise<void>;
  createCollection: (botId: string, body: CreateCollectionBody) => Promise<CollectionPublic>;
  updateCollection: (id: string, body: UpdateCollectionBody) => Promise<CollectionPublic>;
  deleteCollection: (id: string) => Promise<void>;
  /** Live record count for the destructive-edit warning. 0 on any error. */
  recordCount: (collectionId: string) => Promise<number>;
}

export function createCollectionsStore(client: ApiClient = api) {
  return create<CollectionsState>((set, get) => ({
    collections: [],
    botId: null,
    loading: false,
    error: null,

    load: async (botId) => {
      set({ loading: true, error: null, botId });
      try {
        set({ collections: await client.listCollections(botId), loading: false });
      } catch (err) {
        set({ loading: false, error: err instanceof Error ? err.message : String(err) });
      }
    },

    createCollection: async (botId, body) => {
      const col = await client.createCollection(botId, body);
      set({ collections: [...get().collections, col] });
      return col;
    },

    updateCollection: async (id, body) => {
      const col = await client.updateCollection(id, body);
      set({ collections: get().collections.map((c) => (c.id === id ? col : c)) });
      return col;
    },

    deleteCollection: async (id) => {
      await client.deleteCollection(id);
      set({ collections: get().collections.filter((c) => c.id !== id) });
    },

    recordCount: async (collectionId) => {
      try {
        return await client.countRecords(collectionId);
      } catch {
        return 0;
      }
    },
  }));
}

export const useCollections = createCollectionsStore();
