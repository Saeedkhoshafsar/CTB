/**
 * Go-live setup checklist — the PURE model (PLAN4 Phase L, L-T1).
 *
 * `computeChecklist(state)` turns a snapshot of already-stored facts into the
 * list of OPEN prerequisite tasks + a `ready` flag. It is deliberately pure and
 * side effect-free (the F-T3 pattern): the route gathers the `SetupState` from
 * the real stores/env, and THIS function — unit-tested against crafted states —
 * decides what's still missing. A task "disappears" simply by its predicate
 * becoming true, so the checklist is always derived from real state, never a
 * stored set of done-flags (principle 1: the source of truth is reality).
 *
 * `ready` is true when no REQUIRED item remains open; recommended-only items
 * (currently just `admins`) are listed while open but do NOT block readiness —
 * a single-owner instance is already operable.
 */
import {
  type SetupChecklist,
  type SetupChecklistId,
  type SetupChecklistItem,
  type SetupState,
} from '@ctb/shared';

/** Per-id predicate "is this item SATISFIED?" + whether it's merely recommended. */
interface ChecklistRule {
  id: SetupChecklistId;
  optional: boolean;
  satisfied: (s: SetupState) => boolean;
}

/**
 * The rules, in display order. Each `satisfied` is a pure predicate over the
 * snapshot; an item is OPEN exactly when its predicate is false.
 */
const RULES: ChecklistRule[] = [
  { id: 'secret', optional: false, satisfied: (s) => s.hasSecret },
  { id: 'owner', optional: false, satisfied: (s) => s.hasOwner },
  // Recommended: a second pair of hands. A lone owner can still operate.
  { id: 'admins', optional: true, satisfied: (s) => s.nonOwnerAdminCount > 0 },
  { id: 'bot', optional: false, satisfied: (s) => s.botCount > 0 },
  { id: 'activeFlow', optional: false, satisfied: (s) => s.activeFlowCount > 0 },
  { id: 'delivery', optional: false, satisfied: (s) => s.hasDelivery },
];

/** Derive the OPEN items + `ready` from a snapshot of stored state. PURE. */
export function computeChecklist(state: SetupState): SetupChecklist {
  const items: SetupChecklistItem[] = RULES.filter((r) => !r.satisfied(state)).map((r) => ({
    id: r.id,
    optional: r.optional,
  }));
  // Ready when no REQUIRED item is still open (optional items don't block).
  const ready = items.every((i) => i.optional);
  return { items, ready };
}
