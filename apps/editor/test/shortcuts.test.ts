/**
 * I-T3 (gap G11) — the PURE shortcut matcher + catalog.
 *
 * The risky logic in a shortcut system is the matching (which key + modifiers
 * → which action, cross-platform Ctrl/⌘, and yielding to text fields). Per the
 * F-T3/H-T2 pattern that logic is DOM-free in `canvas/shortcuts.ts` and tested
 * directly here; the React handler in FlowCanvas is thin glue. We also pin the
 * catalog/help invariants (unique actions, every label keyed, help generated
 * from the same list the handler matches against).
 */
import { describe, expect, it } from 'vitest';
import {
  SHORTCUTS,
  SHORTCUT_GROUPS,
  isTypingTarget,
  matchShortcut,
  type ShortcutEvent,
} from '../src/canvas/shortcuts';
import { en } from '../src/i18n/en';
import { fa } from '../src/i18n/fa';

/** Build a ShortcutEvent with sane defaults. */
function ev(over: Partial<ShortcutEvent>): ShortcutEvent {
  return { key: '', ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...over };
}

describe('matchShortcut — modifier + key resolution', () => {
  it('Ctrl+Z → undo, Meta+Z → undo (cross-platform mod)', () => {
    expect(matchShortcut(ev({ key: 'z', ctrlKey: true }), false)).toBe('undo');
    expect(matchShortcut(ev({ key: 'z', metaKey: true }), false)).toBe('undo');
  });

  it('Ctrl+Y → redo AND Ctrl+Shift+Z → redo (not undo)', () => {
    expect(matchShortcut(ev({ key: 'y', ctrlKey: true }), false)).toBe('redo');
    expect(matchShortcut(ev({ key: 'z', ctrlKey: true, shiftKey: true }), false)).toBe('redo');
  });

  it('Ctrl+D → duplicate, Ctrl+A → selectAll, Ctrl+S → save', () => {
    expect(matchShortcut(ev({ key: 'd', ctrlKey: true }), false)).toBe('duplicate');
    expect(matchShortcut(ev({ key: 'a', ctrlKey: true }), false)).toBe('selectAll');
    expect(matchShortcut(ev({ key: 's', ctrlKey: true }), false)).toBe('save');
  });

  it('Shift+1 → fitView (no mod), and uppercase key resolves the same', () => {
    expect(matchShortcut(ev({ key: '1', shiftKey: true }), false)).toBe('fitView');
    // browsers may report the uppercase letter when shift is held
    expect(matchShortcut(ev({ key: 'A', ctrlKey: true }), false)).toBe('selectAll');
  });

  it('? → help, Escape → closeOverlay, Delete/Backspace → delete', () => {
    expect(matchShortcut(ev({ key: '?' }), false)).toBe('help');
    expect(matchShortcut(ev({ key: 'Escape' }), false)).toBe('closeOverlay');
    expect(matchShortcut(ev({ key: 'Delete' }), false)).toBe('delete');
    expect(matchShortcut(ev({ key: 'Backspace' }), false)).toBe('delete');
  });

  it('returns null for an unbound combo / bare letter without a mod', () => {
    expect(matchShortcut(ev({ key: 'z' }), false)).toBeNull(); // no mod
    expect(matchShortcut(ev({ key: 'q', ctrlKey: true }), false)).toBeNull(); // unbound
  });
});

describe('matchShortcut — yields to text editing', () => {
  it('suppresses editor shortcuts while typing in an input', () => {
    expect(matchShortcut(ev({ key: 'a', ctrlKey: true }), true)).toBeNull(); // select-all in field
    expect(matchShortcut(ev({ key: 'z', ctrlKey: true }), true)).toBeNull(); // native undo wins
    expect(matchShortcut(ev({ key: 'd', ctrlKey: true }), true)).toBeNull();
    expect(matchShortcut(ev({ key: '?' }), true)).toBeNull();
  });

  it('still allows Escape (allowInInput) to close an overlay while typing', () => {
    expect(matchShortcut(ev({ key: 'Escape' }), true)).toBe('closeOverlay');
  });

  it('isTypingTarget detects form controls only', () => {
    expect(isTypingTarget('INPUT')).toBe(true);
    expect(isTypingTarget('TEXTAREA')).toBe(true);
    expect(isTypingTarget('SELECT')).toBe(true);
    expect(isTypingTarget('DIV')).toBe(false);
    expect(isTypingTarget(undefined)).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });
});

describe('SHORTCUTS catalog — help/binding invariants', () => {
  it('every action is unique (no two specs claim the same action)', () => {
    const actions = SHORTCUTS.map((s) => s.action);
    expect(new Set(actions).size).toBe(actions.length);
  });

  it('every spec belongs to a known group and has a hint', () => {
    for (const s of SHORTCUTS) {
      expect(SHORTCUT_GROUPS).toContain(s.group);
      expect(s.hint.length).toBeGreaterThan(0);
      expect(s.keys.length).toBeGreaterThan(0);
    }
  });

  it('every labelKey resolves in BOTH catalogs (help can render fa + en)', () => {
    for (const s of SHORTCUTS) {
      expect((en as Record<string, string>)[s.labelKey], `en ${s.labelKey}`).toBeTruthy();
      expect((fa as Record<string, string>)[s.labelKey], `fa ${s.labelKey}`).toBeTruthy();
    }
  });

  it('every shortcut spec is actually matchable by matchShortcut', () => {
    // feed each spec's own (mod/shift/firstKey) back through the matcher → it
    // must resolve to that spec's action (guards drift between table + matcher).
    for (const s of SHORTCUTS) {
      const e = ev({
        key: s.keys[0]!,
        ctrlKey: s.mod,
        shiftKey: s.shift,
      });
      expect(matchShortcut(e, false)).toBe(s.action);
    }
  });
});
