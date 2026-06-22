/**
 * PLAN3 F-T1 — guided empty-state logic tests.
 *
 * F-T1's whole point is discoverability, so the risk worth pinning is the PURE
 * decision layer (`lib/empty-state.ts`): the exact set/order of the three CTAs a
 * brand-new user sees, the "is this canvas empty?" gate that shows/hides the
 * editor hint, and — crucially — that every i18n key those surfaces reference
 * actually exists in BOTH catalogs (fa default + en), so neither locale renders
 * a raw key. The React glue (FlowsEmptyState/CanvasEmptyHint) is thin and left
 * to the integration layer, mirroring how F-T3 tested `flow-export`'s pure core.
 */
import { describe, expect, it } from 'vitest';
import { en } from '../src/i18n/en';
import { fa } from '../src/i18n/fa';
import {
  CANVAS_HINT_KEYS,
  type EmptyStateActionId,
  emptyStateActions,
  isCanvasEmpty,
} from '../src/lib/empty-state';

const catalogs = { fa, en } as const;

describe('emptyStateActions', () => {
  it('offers exactly the three existing FlowsPage affordances, in order', () => {
    const ids = emptyStateActions().map((a) => a.id);
    expect(ids).toEqual<EmptyStateActionId[]>(['template', 'import', 'blank']);
  });

  it('marks "Start from template" as the single primary CTA (fastest path)', () => {
    const actions = emptyStateActions();
    const primaries = actions.filter((a) => a.primary).map((a) => a.id);
    expect(primaries).toEqual(['template']);
  });

  it('returns a fresh, stable array each call (no shared mutable state)', () => {
    const a = emptyStateActions();
    const b = emptyStateActions();
    expect(a).not.toBe(b);
    expect(a).toEqual(b);
  });

  it('every CTA title/desc key resolves in BOTH locales (no raw keys)', () => {
    for (const locale of ['fa', 'en'] as const) {
      const cat: Record<string, string> = catalogs[locale];
      for (const a of emptyStateActions()) {
        expect(cat[a.titleKey], `${locale}:${a.titleKey}`).toBeTruthy();
        expect(cat[a.descKey], `${locale}:${a.descKey}`).toBeTruthy();
      }
    }
  });

  it('the empty-state heading + lead exist in both locales', () => {
    for (const locale of ['fa', 'en'] as const) {
      const cat: Record<string, string> = catalogs[locale];
      expect(cat['flows.emptyState.title']).toBeTruthy();
      expect(cat['flows.emptyState.lead']).toBeTruthy();
    }
  });
});

describe('isCanvasEmpty', () => {
  it('is true for null / undefined / a node-less graph', () => {
    expect(isCanvasEmpty(null)).toBe(true);
    expect(isCanvasEmpty(undefined)).toBe(true);
    expect(isCanvasEmpty({ nodes: [] })).toBe(true);
  });

  it('is false as soon as any node exists (even disconnected)', () => {
    // a bare {id,type,...} is enough — the gate only counts nodes.
    const graph = { nodes: [{ id: 'n1' }] } as unknown as Parameters<typeof isCanvasEmpty>[0];
    expect(isCanvasEmpty(graph)).toBe(false);
  });
});

describe('canvas-hint i18n', () => {
  it('every canvas-hint key resolves in both locales', () => {
    for (const locale of ['fa', 'en'] as const) {
      const cat: Record<string, string> = catalogs[locale];
      for (const key of Object.values(CANVAS_HINT_KEYS)) {
        expect(cat[key], `${locale}:${key}`).toBeTruthy();
      }
    }
  });
});
