/**
 * Confirm host (UX) — renders a single modal confirm dialog driven by
 * `stores/confirm`. Mounted once in the app shell so any page (or non-React
 * handler) can `await confirmDialog(...)` instead of the blocking, un-stylable,
 * non-RTL `window.confirm` (PLAN5 P2-T4 / issue B4).
 *
 * Accessibility:
 *  - role="dialog" + aria-modal; labelled by its title/message.
 *  - Escape cancels, Enter confirms; the confirm button is auto-focused.
 *  - A backdrop click cancels. Logical-property layout → RTL-safe.
 */
import { useEffect, useRef } from 'react';
import { useI18n } from '../i18n';
import { useConfirm } from '../stores/confirm';

export function ConfirmHost() {
  const t = useI18n((s) => s.t);
  const current = useConfirm((s) => s.current);
  const resolve = useConfirm((s) => s.resolve);
  const confirmBtnRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!current) return;
    confirmBtnRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        resolve(false);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        resolve(true);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [current, resolve]);

  if (!current) return null;

  const title = current.title ?? t('common.confirm.title');
  const confirmLabel = current.confirmLabel ?? t('common.confirm.ok');
  const cancelLabel = current.cancelLabel ?? t('common.cancel');

  return (
    <div
      className="confirm-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) resolve(false);
      }}
    >
      <div
        className="confirm-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-title"
        aria-describedby="confirm-message"
      >
        <h2 id="confirm-title" className="confirm-title">
          {title}
        </h2>
        <p id="confirm-message" className="confirm-message">
          {current.message}
        </p>
        <div className="confirm-actions">
          <button type="button" className="ghost" onClick={() => resolve(false)}>
            {cancelLabel}
          </button>
          <button
            ref={confirmBtnRef}
            type="button"
            className={current.danger ? 'danger' : 'primary'}
            onClick={() => resolve(true)}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
