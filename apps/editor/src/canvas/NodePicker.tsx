/**
 * NodePicker (H-T4) — a small floating node-type chooser shared by the two
 * "wire-first" canvas affordances:
 *
 *   • add-node-on-edge   — click the inline "+" on an edge, pick a type, and the
 *     edge A→B becomes A→N→B (gap G8).
 *   • wire-drop-to-palette — drag a wire onto empty canvas, pick a type, and the
 *     new node is created already wired to the dangling end (gap G9).
 *
 * It is a thin presentational popup (the F-T3 pattern): the structural edits
 * live in the pure `graph.ts` helpers + the canvas store; this just lists the
 * registry types (grouped like the palette) and reports the chosen type at a
 * screen position. A small zustand store drives open/close so any canvas
 * surface can summon it without prop-drilling.
 */
import type { NodeTypeInfo } from '@ctb/shared';
import { useEffect, useRef } from 'react';
import { create } from 'zustand';
import { useI18n, type MessageKey } from '../i18n';
import { useCanvas } from '../stores/canvas';

const CATEGORY_ORDER = ['trigger', 'telegram', 'flow', 'data', 'ai'] as const;

/** What to do with the type the user picks. */
export type PickerIntent =
  | { kind: 'edge'; edgeId: string }
  | { kind: 'dangling'; pending: import('./graph').PendingConnect };

interface PickerState {
  /** screen coords to anchor the popup at, or null when closed. */
  at: { x: number; y: number } | null;
  intent: PickerIntent | null;
  open: (at: { x: number; y: number }, intent: PickerIntent) => void;
  close: () => void;
}

export const useNodePicker = create<PickerState>((set) => ({
  at: null,
  intent: null,
  open: (at, intent) => set({ at, intent }),
  close: () => set({ at: null, intent: null }),
}));

export function NodePicker({
  onPick,
}: {
  /** called with the chosen type + the live intent (caller does the edit). */
  onPick: (type: string, intent: PickerIntent, at: { x: number; y: number }) => void;
}) {
  const t = useI18n((s) => s.t);
  const at = useNodePicker((s) => s.at);
  const intent = useNodePicker((s) => s.intent);
  const close = useNodePicker((s) => s.close);
  const nodeTypes = useCanvas((s) => s.nodeTypes);
  const ref = useRef<HTMLDivElement>(null);

  // Esc + outside-click dismiss (mirrors the NDV's escape handling).
  useEffect(() => {
    if (!at) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) close();
    };
    document.addEventListener('keydown', onKey);
    // defer so the gesture that OPENED the picker doesn't immediately close it
    const id = window.setTimeout(() => document.addEventListener('mousedown', onDown, true), 0);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDown, true);
      window.clearTimeout(id);
    };
  }, [at, close]);

  if (!at || !intent) return null;

  const groups = CATEGORY_ORDER.map((cat) => ({
    cat,
    items: nodeTypes.filter((nt: NodeTypeInfo) => nt.category === cat),
  })).filter((g) => g.items.length > 0);

  // keep the popup on-screen (clamp to the viewport with a small margin)
  const left = Math.min(at.x, window.innerWidth - 240);
  const top = Math.min(at.y, window.innerHeight - 280);

  return (
    <div
      ref={ref}
      className="node-picker"
      style={{ left: Math.max(8, left), top: Math.max(8, top) }}
      role="dialog"
      aria-label={t('editor.picker.title')}
    >
      <div className="node-picker-head">{t('editor.picker.title')}</div>
      <div className="node-picker-body">
        {groups.map(({ cat, items }) => (
          <div key={cat} className="node-picker-group">
            <div className="node-picker-cat">{t(`editor.palette.cat.${cat}` as MessageKey)}</div>
            {items.map((nt) => (
              <button
                key={nt.type}
                type="button"
                className={`node-picker-item cat-${nt.category}`}
                title={nt.type}
                onClick={() => {
                  onPick(nt.type, intent, at);
                  close();
                }}
              >
                {t(nt.meta.labelKey as MessageKey)}
              </button>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
