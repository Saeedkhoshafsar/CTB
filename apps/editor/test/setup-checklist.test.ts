/**
 * PLAN4 L-T2 — pure tests for the setup-checklist presentation logic.
 *
 * `checklistViews` projects the server's OPEN items (the source of truth, L-T1)
 * into ordered, presentable views: each open id gets an i18n title/desc and the
 * deep-link route that satisfies it. These tests pin the ordering, the omission
 * of already-satisfied items, the `optional` pass-through, the deep-link targets
 * and the defensive skip of unknown ids — all with no React (the F-T1/F-T3
 * pure-module pattern).
 */
import { SETUP_CHECKLIST_IDS, type SetupChecklistItem } from '@ctb/shared';
import { describe, expect, it } from 'vitest';
import { checklistViews } from '../src/lib/setup-checklist';

/** Build an open-item list from ids (all required unless overridden). */
function open(ids: SetupChecklistItem['id'][], optional: Partial<Record<string, boolean>> = {}): SetupChecklistItem[] {
  return ids.map((id) => ({ id, optional: optional[id] ?? false }));
}

describe('checklistViews (L-T2)', () => {
  it('renders one view per open item, in the server canonical id order', () => {
    // Pass them out of order; output must still follow SETUP_CHECKLIST_IDS.
    const items = open(['delivery', 'secret', 'bot']);
    const views = checklistViews(items);
    expect(views.map((v) => v.id)).toEqual(['secret', 'bot', 'delivery']);
  });

  it('omits satisfied items (ids the server did not return)', () => {
    // Only "bot" is still open → only "bot" is shown; the rest are satisfied.
    const views = checklistViews(open(['bot']));
    expect(views).toHaveLength(1);
    expect(views[0]?.id).toBe('bot');
  });

  it('returns an empty array when nothing is open', () => {
    expect(checklistViews([])).toEqual([]);
  });

  it('passes through the optional flag from the server item', () => {
    const views = checklistViews(open(['admins', 'bot'], { admins: true }));
    const admins = views.find((v) => v.id === 'admins');
    const bot = views.find((v) => v.id === 'bot');
    expect(admins?.optional).toBe(true);
    expect(bot?.optional).toBe(false);
  });

  it('deep-links each item to the page that satisfies it', () => {
    const views = checklistViews(open([...SETUP_CHECKLIST_IDS]));
    const route = (id: string) => views.find((v) => v.id === id)?.route;
    expect(route('secret')).toBe('/docs');
    expect(route('owner')).toBe('/admins');
    expect(route('admins')).toBe('/admins');
    expect(route('bot')).toBe('/bots');
    expect(route('activeFlow')).toBe('/bots');
    expect(route('delivery')).toBe('/bots');
  });

  it('gives every item a non-empty title and description key', () => {
    const views = checklistViews(open([...SETUP_CHECKLIST_IDS]));
    expect(views).toHaveLength(SETUP_CHECKLIST_IDS.length);
    for (const v of views) {
      expect(typeof v.titleKey).toBe('string');
      expect(v.titleKey.length).toBeGreaterThan(0);
      expect(typeof v.descKey).toBe('string');
      expect(v.descKey.length).toBeGreaterThan(0);
    }
  });

  it('defensively skips unknown ids (forward-compat with a newer server)', () => {
    // Cast: simulate a server returning an id this editor build does not know.
    const items = [{ id: 'futureThing', optional: false } as unknown as SetupChecklistItem, ...open(['bot'])];
    const views = checklistViews(items);
    expect(views.map((v) => v.id)).toEqual(['bot']);
  });
});
