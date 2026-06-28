import {
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react';
import { Link } from 'react-router-dom';
import { useI18n } from '../i18n';

export interface ActionMenuItem {
  /** Stable key for the item. */
  key: string;
  /** Visible label. */
  label: ReactNode;
  /** Optional leading icon/emoji. */
  icon?: ReactNode;
  /** If set, the item renders as a router Link to this path. */
  to?: string;
  /** If set (and no `to`), the item renders as a button calling this. */
  onClick?: () => void;
  /** Style the item as destructive (red). */
  danger?: boolean;
  /** Disable the item. */
  disabled?: boolean;
}

export interface ActionMenuProps {
  items: ActionMenuItem[];
  /** Accessible label for the trigger; defaults to the i18n "more actions" string. */
  label?: string;
}

/**
 * Overflow ("kebab") menu. RTL-safe (menu aligns to `inset-inline-end`),
 * keyboard-navigable (Escape closes, Enter/Space activates), and closes on an
 * outside click. Used to declutter action rows that previously showed 4–7
 * inline buttons (PLAN5 P1-T3 / issue A3).
 */
export function ActionMenu({ items, label }: ActionMenuProps) {
  const t = useI18n((s) => s.t);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const menuId = useId();
  const triggerLabel = label ?? t('common.moreActions');

  const close = useCallback(() => setOpen(false), []);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, close]);

  if (items.length === 0) return null;

  return (
    <div className="action-menu" ref={rootRef}>
      <button
        type="button"
        className="btn ghost action-menu-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={menuId}
        aria-label={triggerLabel}
        title={triggerLabel}
        onClick={() => setOpen((v) => !v)}
      >
        ⋯
      </button>
      {open && (
        <div className="action-menu-list" id={menuId} role="menu">
          {items.map((item) =>
            item.to ? (
              <Link
                key={item.key}
                role="menuitem"
                className={`action-menu-item${item.danger ? ' danger' : ''}`}
                to={item.to}
                onClick={close}
              >
                {item.icon && <span className="action-menu-icon">{item.icon}</span>}
                <span>{item.label}</span>
              </Link>
            ) : (
              <button
                key={item.key}
                type="button"
                role="menuitem"
                className={`action-menu-item${item.danger ? ' danger' : ''}`}
                disabled={item.disabled}
                onClick={() => {
                  close();
                  item.onClick?.();
                }}
              >
                {item.icon && <span className="action-menu-icon">{item.icon}</span>}
                <span>{item.label}</span>
              </button>
            ),
          )}
        </div>
      )}
    </div>
  );
}
