import { create } from 'zustand';

export interface ConfirmOptions {
  /** Body text shown to the user (already localized). */
  message: string;
  /** Optional title (already localized). Falls back to a generic confirm title. */
  title?: string;
  /** Confirm button label (already localized). */
  confirmLabel?: string;
  /** Cancel button label (already localized). */
  cancelLabel?: string;
  /** Style the confirm button as destructive. */
  danger?: boolean;
}

interface PendingConfirm extends ConfirmOptions {
  id: string;
  resolve: (ok: boolean) => void;
}

interface ConfirmState {
  current: PendingConfirm | null;
  /** Open a confirm dialog; resolves true on confirm, false on cancel/escape. */
  request: (opts: ConfirmOptions) => Promise<boolean>;
  /** Resolve the active dialog and clear it. */
  resolve: (ok: boolean) => void;
}

let seq = 0;

export const useConfirm = create<ConfirmState>((set, get) => ({
  current: null,
  request: (opts) =>
    new Promise<boolean>((resolve) => {
      // If a dialog is already open, reject the previous one as cancelled.
      const existing = get().current;
      if (existing) existing.resolve(false);
      seq += 1;
      set({ current: { ...opts, id: `confirm-${seq}`, resolve } });
    }),
  resolve: (ok) => {
    const cur = get().current;
    if (cur) {
      cur.resolve(ok);
      set({ current: null });
    }
  },
}));

/**
 * Imperative, promise-based confirm usable from event handlers and non-React
 * code. Replaces blocking `window.confirm` (PLAN5 P2-T4 / issue B4).
 *
 *   if (await confirmDialog({ message, danger: true })) { ...destructive... }
 */
export function confirmDialog(opts: ConfirmOptions): Promise<boolean> {
  return useConfirm.getState().request(opts);
}
