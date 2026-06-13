/**
 * Records store (Data section, P3.5-T4) — server-side-paginated list + CRUD over
 * the typed client for ONE collection. The auto-generated CRUD panel drives it:
 * `query` re-fetches the page with the current filter/sort/pagination, the
 * mutations re-sync the visible page so the table never drifts from the DB.
 *
 * GENERIC (invariant I2): the store knows "a collection has records", never a
 * domain. Validation lives entirely server-side via the shared `validateRecord`
 * (I5) — a 422 surfaces as a structured field-error map the form renders inline.
 */
import type {
  CreateRecordBody,
  QueryRecordsBody,
  RecordPublic,
  UpdateRecordBody,
} from '@ctb/shared';
import { create } from 'zustand';
import { ApiError, type ApiClient, api } from '../api/client';

/** Field-level validation errors keyed by dotted path, from a 422 response. */
export type FieldErrors = Record<string, string>;

function extractFieldErrors(err: unknown): FieldErrors | null {
  if (err instanceof ApiError && err.status === 422) {
    const body = err.body as { fields?: { path: string; message: string }[] };
    if (Array.isArray(body.fields)) {
      const out: FieldErrors = {};
      for (const f of body.fields) out[f.path] = f.message;
      return out;
    }
    return {};
  }
  return null;
}

export interface RecordsState {
  collectionId: string | null;
  records: RecordPublic[];
  total: number;
  loading: boolean;
  error: string | null;
  /** Re-query the current collection with a filter (server-side pagination). */
  query: (collectionId: string, body: QueryRecordsBody) => Promise<void>;
  /**
   * Create a record. Resolves to the new record on success, or a FieldErrors map
   * on a 422 (so the form renders inline messages); re-throws other errors.
   */
  createRecord: (collectionId: string, body: CreateRecordBody) => Promise<RecordPublic | FieldErrors>;
  updateRecord: (
    collectionId: string,
    id: string,
    body: UpdateRecordBody,
  ) => Promise<RecordPublic | FieldErrors>;
  deleteRecord: (collectionId: string, id: string) => Promise<void>;
}

export function createRecordsStore(client: ApiClient = api) {
  return create<RecordsState>((set, get) => ({
    collectionId: null,
    records: [],
    total: 0,
    loading: false,
    error: null,

    query: async (collectionId, body) => {
      set({ loading: true, error: null, collectionId });
      try {
        const page = await client.queryRecords(collectionId, body);
        set({ records: page.records, total: page.total, loading: false });
      } catch (err) {
        set({ loading: false, error: err instanceof Error ? err.message : String(err) });
      }
    },

    createRecord: async (collectionId, body) => {
      try {
        const rec = await client.createRecord(collectionId, body);
        // Prepend optimistically; a re-query will re-sort per the active filter.
        set((s) => ({ records: [rec, ...s.records], total: s.total + 1 }));
        return rec;
      } catch (err) {
        const fe = extractFieldErrors(err);
        if (fe) return fe;
        throw err;
      }
    },

    updateRecord: async (collectionId, id, body) => {
      try {
        const rec = await client.updateRecord(collectionId, id, body);
        set((s) => ({ records: s.records.map((r) => (r.id === id ? rec : r)) }));
        return rec;
      } catch (err) {
        const fe = extractFieldErrors(err);
        if (fe) return fe;
        throw err;
      }
    },

    deleteRecord: async (collectionId, id) => {
      await client.deleteRecord(collectionId, id);
      set((s) => ({ records: s.records.filter((r) => r.id !== id), total: Math.max(0, s.total - 1) }));
    },
  }));
}

export const useRecords = createRecordsStore();
