/**
 * Auth store (P2-T1) — session state mirrored from the server cookie.
 *
 * `status` starts 'unknown' until the first `/api/auth/me` probe resolves;
 * the router shows a splash for 'unknown' and redirects to /login for
 * 'anonymous'. The ApiClient is injected so tests drive the store with a
 * fake transport.
 */
import type { SessionUser } from '@ctb/shared';
import { create } from 'zustand';
import { ApiError, type ApiClient, api } from '../api/client';

export type AuthStatus = 'unknown' | 'anonymous' | 'authenticated';

export interface AuthState {
  status: AuthStatus;
  user: SessionUser | null;
  /** i18n key of the last login failure, or null. */
  loginError: 'login.error.invalid' | 'login.error.unavailable' | 'error.network' | null;
  loggingIn: boolean;
  probe: () => Promise<void>;
  login: (username: string, password: string) => Promise<boolean>;
  logout: () => Promise<void>;
}

export function createAuthStore(client: ApiClient = api) {
  return create<AuthState>((set) => ({
    status: 'unknown',
    user: null,
    loginError: null,
    loggingIn: false,

    probe: async () => {
      try {
        const user = await client.me();
        set(user ? { status: 'authenticated', user } : { status: 'anonymous', user: null });
      } catch {
        // Server unreachable — treat as anonymous so the login page renders.
        set({ status: 'anonymous', user: null });
      }
    },

    login: async (username, password) => {
      set({ loggingIn: true, loginError: null });
      try {
        const user = await client.login({ username, password });
        set({ status: 'authenticated', user, loggingIn: false });
        return true;
      } catch (err) {
        let loginError: AuthState['loginError'] = 'error.network';
        if (err instanceof ApiError) {
          loginError = err.status === 503 ? 'login.error.unavailable' : 'login.error.invalid';
        }
        set({ status: 'anonymous', user: null, loggingIn: false, loginError });
        return false;
      }
    },

    logout: async () => {
      try {
        await client.logout();
      } finally {
        set({ status: 'anonymous', user: null });
      }
    },
  }));
}

export const useAuth = createAuthStore();
