/**
 * Keyboard-shortcut catalog + a PURE, DOM-free matcher (PLAN3 I-T3, gap G11).
 *
 * The risky part of a shortcut system is the matching logic (which key + which
 * modifiers map to which action, cross-platform Ctrl/⌘). Per the F-T3/H-T2
 * pattern we keep that logic here as a pure function over a plain
 * `ShortcutEvent` (a structural subset of the DOM `KeyboardEvent`) so it is
 * unit-tested directly; the React layer (FlowEditorPage handler + the help
 * overlay) is thin glue that feeds real events in and reads the catalog out.
 *
 * The `?` overlay is generated FROM `SHORTCUTS` so the help text and the live
 * bindings can never drift apart — adding a shortcut here lists it in the help.
 */

/** The actions a shortcut can trigger. Stable ids — used by the handler + tests. */
export type ShortcutAction =
  | 'undo'
  | 'redo'
  | 'save'
  | 'duplicate'
  | 'selectAll'
  | 'fitView'
  | 'delete'
  | 'help'
  | 'closeOverlay';

/** Logical groups for the help overlay (rendered in this order). */
export type ShortcutGroup = 'edit' | 'canvas' | 'general';

/**
 * The structural subset of a DOM KeyboardEvent the matcher reads. Using a plain
 * interface (not the DOM type) keeps the matcher testable without jsdom.
 */
export interface ShortcutEvent {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

export interface ShortcutSpec {
  action: ShortcutAction;
  group: ShortcutGroup;
  /** i18n key for the human description (resolved by the overlay). */
  labelKey: string;
  /** `true` ⇒ requires Ctrl (Windows/Linux) or ⌘ (macOS). */
  mod: boolean;
  shift: boolean;
  /** Lower-cased `event.key` values that fire this action (any one matches). */
  keys: readonly string[];
  /** Human key hint shown in the overlay, e.g. "Ctrl/⌘ + Z". */
  hint: string;
  /**
   * `true` ⇒ this shortcut is safe to fire while typing in an input/textarea
   * (only Escape qualifies; everything else must yield to text editing).
   */
  allowInInput?: boolean;
}

const MOD = 'Ctrl/⌘';

/**
 * The single source of truth. Order within a group = display order.
 * NOTE: redo intentionally lists BOTH Ctrl+Y and Ctrl+Shift+Z; the matcher
 * handles the shift variant via `shift` + an explicit `z` fallback below.
 */
export const SHORTCUTS: readonly ShortcutSpec[] = [
  // ── edit ────────────────────────────────────────────────────────────────
  { action: 'undo', group: 'edit', labelKey: 'editor.shortcut.undo', mod: true, shift: false, keys: ['z'], hint: `${MOD} + Z` },
  { action: 'redo', group: 'edit', labelKey: 'editor.shortcut.redo', mod: true, shift: false, keys: ['y'], hint: `${MOD} + Y / ${MOD} + Shift + Z` },
  { action: 'duplicate', group: 'edit', labelKey: 'editor.shortcut.duplicate', mod: true, shift: false, keys: ['d'], hint: `${MOD} + D` },
  { action: 'delete', group: 'edit', labelKey: 'editor.shortcut.delete', mod: false, shift: false, keys: ['delete', 'backspace'], hint: 'Delete / Backspace' },
  // ── canvas ──────────────────────────────────────────────────────────────
  { action: 'selectAll', group: 'canvas', labelKey: 'editor.shortcut.selectAll', mod: true, shift: false, keys: ['a'], hint: `${MOD} + A` },
  { action: 'fitView', group: 'canvas', labelKey: 'editor.shortcut.fitView', mod: false, shift: true, keys: ['1'], hint: 'Shift + 1' },
  // ── general ─────────────────────────────────────────────────────────────
  { action: 'save', group: 'general', labelKey: 'editor.shortcut.save', mod: true, shift: false, keys: ['s'], hint: `${MOD} + S` },
  { action: 'help', group: 'general', labelKey: 'editor.shortcut.help', mod: false, shift: false, keys: ['?'], hint: '?' },
  { action: 'closeOverlay', group: 'general', labelKey: 'editor.shortcut.close', mod: false, shift: false, keys: ['escape'], hint: 'Esc', allowInInput: true },
];

/** Groups in the order the overlay renders them. */
export const SHORTCUT_GROUPS: readonly ShortcutGroup[] = ['edit', 'canvas', 'general'];

/** `true` if the event originated inside a text-editing control. */
export function isTypingTarget(tagName: string | undefined | null): boolean {
  if (!tagName) return false;
  return /^(INPUT|TEXTAREA|SELECT)$/.test(tagName);
}

/**
 * Pure matcher: given a key event (and whether the focus is in a text field),
 * return the action it triggers, or `null`. Cross-platform: `mod` matches
 * Ctrl OR Meta. Redo is special-cased so Ctrl+Shift+Z resolves to `redo`
 * (the `z`+shift variant) while plain Ctrl+Z stays `undo`.
 */
export function matchShortcut(ev: ShortcutEvent, inTextField: boolean): ShortcutAction | null {
  const key = ev.key.toLowerCase();
  const mod = ev.ctrlKey || ev.metaKey;

  // Redo via Ctrl+Shift+Z (handled before the generic table so the shift
  // variant of `z` is not swallowed by undo).
  if (mod && ev.shiftKey && key === 'z') return inTextField ? null : 'redo';

  for (const s of SHORTCUTS) {
    if (!s.keys.includes(key)) continue;
    if (s.mod !== mod) continue;
    if (s.shift !== ev.shiftKey) continue;
    // While typing, only `allowInInput` shortcuts (Escape) are honoured.
    if (inTextField && !s.allowInInput) return null;
    return s.action;
  }
  return null;
}
