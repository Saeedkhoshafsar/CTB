/**
 * Keyboard-shortcut help overlay (PLAN3 I-T3, gap G11).
 *
 * A `?`-triggered modal listing every editor shortcut, generated FROM the
 * `SHORTCUTS` catalog so the help can never drift from the live bindings. The
 * open-state lives in a tiny zustand store (like `useNodeDetail`) so both the
 * canvas keydown handler (which opens it on `?`) and the toolbar `?` button can
 * drive it, and the overlay renders at the page level over the whole editor.
 */
import { create } from 'zustand';
import { useI18n, type MessageKey } from '../i18n';
import { SHORTCUTS, SHORTCUT_GROUPS, type ShortcutGroup } from './shortcuts';

interface ShortcutHelpState {
  open: boolean;
  show: () => void;
  hide: () => void;
  toggle: () => void;
}

export const useShortcutHelp = create<ShortcutHelpState>((set, get) => ({
  open: false,
  show: () => set({ open: true }),
  hide: () => set({ open: false }),
  toggle: () => set({ open: !get().open }),
}));

const GROUP_TITLE: Record<ShortcutGroup, MessageKey> = {
  edit: 'editor.shortcut.group.edit',
  canvas: 'editor.shortcut.group.canvas',
  general: 'editor.shortcut.group.general',
};

export function ShortcutHelp() {
  const open = useShortcutHelp((s) => s.open);
  const hide = useShortcutHelp((s) => s.hide);
  const t = useI18n((s) => s.t);
  if (!open) return null;
  return (
    <div className="shortcut-help-backdrop" role="presentation" onClick={hide}>
      <div
        className="shortcut-help"
        role="dialog"
        aria-modal="true"
        aria-label={t('editor.shortcut.title')}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="shortcut-help-head">
          <h2>{t('editor.shortcut.title')}</h2>
          <button className="ghost" onClick={hide} aria-label={t('editor.shortcut.close')}>
            ✕
          </button>
        </header>
        <div className="shortcut-help-body">
          {SHORTCUT_GROUPS.map((group) => {
            const rows = SHORTCUTS.filter((s) => s.group === group);
            if (rows.length === 0) return null;
            return (
              <section key={group} className="shortcut-group">
                <h3>{t(GROUP_TITLE[group])}</h3>
                <dl>
                  {rows.map((s) => (
                    <div key={s.action} className="shortcut-row">
                      <dt>{t(s.labelKey as MessageKey)}</dt>
                      <dd>
                        <kbd>{s.hint}</kbd>
                      </dd>
                    </div>
                  ))}
                </dl>
              </section>
            );
          })}
        </div>
      </div>
    </div>
  );
}
