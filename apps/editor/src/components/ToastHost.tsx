/**
 * Toast host (UX) — renders the live toast queue from `stores/toast`. Mounted
 * once in the app shell so any page (or non-React handler) can fire a toast via
 * the `toast.*` helpers without prop-drilling.
 *
 * Design notes:
 *  - Pinned to the viewport's bottom-inline-start corner using LOGICAL
 *    properties (inset-inline-start), so it sits bottom-right in RTL (fa) and
 *    bottom-left in LTR (en) for free — matching the rest of the editor.
 *  - Each toast is a polite live-region (`role="status"`, aria-live) so screen
 *    readers announce results without stealing focus the way `alert()` did.
 *  - A manual close button is always available; auto-dismiss is handled by the
 *    store's timer so it keeps ticking even if this component re-renders.
 */
import { useToasts, type ToastKind } from '../stores/toast';

const ICON: Record<ToastKind, string> = {
  success: '✓',
  error: '✕',
  info: 'ℹ',
  warn: '!',
};

export function ToastHost() {
  const toasts = useToasts((s) => s.toasts);
  const dismiss = useToasts((s) => s.dismiss);

  if (toasts.length === 0) return null;

  return (
    <div className="toast-host" aria-live="polite" aria-atomic="false">
      {toasts.map((tt) => (
        <div key={tt.id} className={`toast toast-${tt.kind}`} role="status">
          <span className="toast-icon" aria-hidden="true">
            {ICON[tt.kind]}
          </span>
          <span className="toast-msg">{tt.message}</span>
          <button
            type="button"
            className="toast-close"
            onClick={() => dismiss(tt.id)}
            aria-label="✕"
          >
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}
