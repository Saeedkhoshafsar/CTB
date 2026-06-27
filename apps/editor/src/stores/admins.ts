/**
 * Admins store (PLAN4 K-T3) — list + mutations over the typed client for the
 * Admins page. Mirrors the credentials store: every mutation re-syncs from the
 * authoritative server response (the store / admins API enforce the owner
 * invariants — K-T1/K-T2) so the UI never drifts from the DB.
 *
 * Rows are keyed by `tgUserId` (the panel-admin primary key). Transfer-ownership
 * touches two rows at once, so it re-loads the whole list rather than patching.
 */
import type {
  AddPanelAdminBody,
  PanelAdmin,
  SetPanelAdminRoleBody,
  TransferOwnerBody,
} from '@ctb/shared';
import { create } from 'zustand';
import { type ApiClient, api } from '../api/client';

export interface AdminsState {
  admins: PanelAdmin[];
  loading: boolean;
  error: string | null;
  load: () => Promise<void>;
  addAdmin: (body: AddPanelAdminBody) => Promise<PanelAdmin>;
  removeAdmin: (tgUserId: string) => Promise<void>;
  setAdminRole: (tgUserId: string, body: SetPanelAdminRoleBody) => Promise<PanelAdmin>;
  transferOwner: (body: TransferOwnerBody) => Promise<void>;
}

export function createAdminsStore(client: ApiClient = api) {
  return create<AdminsState>((set, get) => ({
    admins: [],
    loading: false,
    error: null,

    load: async () => {
      set({ loading: true, error: null });
      try {
        set({ admins: await client.listAdmins(), loading: false });
      } catch (err) {
        set({ loading: false, error: err instanceof Error ? err.message : String(err) });
      }
    },

    addAdmin: async (body) => {
      const admin = await client.addAdmin(body);
      set({ admins: [...get().admins, admin] });
      return admin;
    },

    removeAdmin: async (tgUserId) => {
      await client.removeAdmin(tgUserId);
      set({ admins: get().admins.filter((a) => a.tgUserId !== tgUserId) });
    },

    setAdminRole: async (tgUserId, body) => {
      const admin = await client.setAdminRole(tgUserId, body);
      set({ admins: get().admins.map((a) => (a.tgUserId === tgUserId ? admin : a)) });
      return admin;
    },

    transferOwner: async (body) => {
      await client.transferOwner(body);
      // Two rows change at once (old owner → admin, target → owner); re-sync.
      await get().load();
    },
  }));
}

export const useAdmins = createAdminsStore();
