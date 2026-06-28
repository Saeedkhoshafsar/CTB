/**
 * Toast notification store (UX) — lightweight, dependency-free queue of
 * transient messages rendered by <ToastHost> (mounted once in the shell).
 *
 * Why this exists: the app used the browser's native `window.alert()` for
 * test-run results, export failures, etc. Native alerts are blocking, LTR-only
 * (they ignore the app's RTL direction + theme), and look out of place in a
 * polished dark-themed editor. This store replaces them with non-blocking,
 * theme-aware, RTL-friendly toasts that auto-dismiss.
 *
 * Deliberately tiny — mirrors the existing zustand stores: a flat list of
 * toasts plus `push`/`dismiss`. Convenience helpers (`toast.success`, …) are
 * exported for non-React call sites so a page can fire a toast without wiring
 * the hook through props.
 */
import { create } from 'zustand';

export type ToastKind = 'success' | 'error' | 'info' | 'warn';

export interface Toast {
  id: string;
  kind: ToastKind;
  message: string;
  /** ms before auto-dismiss; 0 keeps it until the user closes it. */
  duration: number;
}

export interface ToastInput {
  kind?: ToastKind;
  message: string;
  duration?: number;
}

interface ToastState {
  toasts: Toast[];
  push: (input: ToastInput) => string;
  dismiss: (id: string) => void;
  clear: () => void;
}

/** Default visible time per kind — errors linger so they aren't missed. */
const DEFAULT_DURATION: Record<ToastKind, number> = {
  success: 3500,
  info: 4000,
  warn: 5000,
  error: 6000,
};

let seq = 0;
function nextId(): string {
  seq += 1;
  return `toast-${Date.now()}-${seq}`;
}

export const useToasts = create<ToastState>((set, get) => ({
  toasts: [],
  push: ({ kind = 'info', message, duration }) => {
    const id = nextId();
    const ms = duration ?? DEFAULT_DURATION[kind];
    set((s) => ({ toasts: [...s.toasts, { id, kind, message, duration: ms }] }));
    if (ms > 0) {
      // Use the global `setTimeout` (not `window.setTimeout`) so it resolves in
      // non-DOM environments too and is intercepted by fake timers in tests.
      setTimeout(() => get().dismiss(id), ms);
    }
    return id;
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((tt) => tt.id !== id) })),
  clear: () => set({ toasts: [] }),
}));

/**
 * Imperative helpers for non-React code (page handlers, catch blocks). Each
 * resolves the live store so it works outside the React render tree.
 */
function fire(kind: ToastKind, message: string, duration?: number): string {
  const input: ToastInput = { kind, message };
  if (duration !== undefined) input.duration = duration;
  return useToasts.getState().push(input);
}

export const toast = {
  show: (input: ToastInput): string => useToasts.getState().push(input),
  success: (message: string, duration?: number): string => fire('success', message, duration),
  error: (message: string, duration?: number): string => fire('error', message, duration),
  info: (message: string, duration?: number): string => fire('info', message, duration),
  warn: (message: string, duration?: number): string => fire('warn', message, duration),
  dismiss: (id: string): void => useToasts.getState().dismiss(id),
};
