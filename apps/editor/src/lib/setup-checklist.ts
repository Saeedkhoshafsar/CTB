/**
 * Setup-checklist presentation logic (PLAN4 L-T2) — the PURE, DOM-free core of
 * the first-run "go-live" panel. The server (L-T1) owns the TRUTH of which
 * prerequisite tasks are still open (`GET /api/setup/checklist`); this module
 * only maps each open `SetupChecklistId` to how it's shown: an i18n title +
 * description and the in-app route that SATISFIES it (the deep-link). Keeping it
 * pure means the mapping + ordering is unit-tested with no React (the F-T1/F-T3
 * pattern), and the component is thin glue.
 *
 * Principle 1 (the source of truth is real state): there is no client-side
 * "done" memory here — every render re-derives from the server's open list, so a
 * task re-appears if its prerequisite is later undone.
 */
import { SETUP_CHECKLIST_IDS, type SetupChecklistId, type SetupChecklistItem } from '@ctb/shared';
import type { MessageKey } from '../i18n';

/** How one open checklist item is presented: copy + the page that fixes it. */
export interface ChecklistView {
  readonly id: SetupChecklistId;
  readonly titleKey: MessageKey;
  readonly descKey: MessageKey;
  /** HashRouter path the user is sent to in order to satisfy this item. */
  readonly route: string;
  /** Recommended-only (doesn't block readiness) — rendered less emphatically. */
  readonly optional: boolean;
}

/** Static per-id presentation: i18n keys + the deep-link target. */
const VIEW: Record<SetupChecklistId, { titleKey: MessageKey; descKey: MessageKey; route: string }> = {
  secret: {
    titleKey: 'setup.item.secret.title',
    descKey: 'setup.item.secret.desc',
    route: '/docs',
  },
  owner: {
    titleKey: 'setup.item.owner.title',
    descKey: 'setup.item.owner.desc',
    route: '/admins',
  },
  admins: {
    titleKey: 'setup.item.admins.title',
    descKey: 'setup.item.admins.desc',
    route: '/admins',
  },
  bot: {
    titleKey: 'setup.item.bot.title',
    descKey: 'setup.item.bot.desc',
    route: '/bots',
  },
  activeFlow: {
    titleKey: 'setup.item.activeFlow.title',
    descKey: 'setup.item.activeFlow.desc',
    route: '/bots',
  },
  delivery: {
    titleKey: 'setup.item.delivery.title',
    descKey: 'setup.item.delivery.desc',
    route: '/bots',
  },
};

/** Display order of the checklist, matching the server's canonical id order. */
const ORDER: readonly SetupChecklistId[] = SETUP_CHECKLIST_IDS;

/**
 * Project the server's OPEN items into ordered, presentable views. Unknown ids
 * (a future server adding an item the editor doesn't yet know) are skipped
 * rather than crashing — the panel degrades to the items it can render.
 */
export function checklistViews(items: readonly SetupChecklistItem[]): ChecklistView[] {
  const byId = new Map(items.map((i) => [i.id, i]));
  const views: ChecklistView[] = [];
  for (const id of ORDER) {
    const item = byId.get(id);
    if (!item) continue; // satisfied (omitted by the server) — nothing to show
    const v = VIEW[id];
    if (!v) continue; // unknown id — skip defensively
    views.push({ id, titleKey: v.titleKey, descKey: v.descKey, route: v.route, optional: item.optional });
  }
  return views;
}
