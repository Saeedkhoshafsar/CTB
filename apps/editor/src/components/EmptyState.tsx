/**
 * Guided empty states (PLAN3 F-T1) — the "I couldn't build anything" cure.
 *
 * Two presentational components over the PURE logic in `lib/empty-state.ts`:
 *
 *  - <FlowsEmptyState> replaces the bare "this bot has no flows" line with three
 *    call-to-action cards (Start from template · Import a flow · Blank canvas),
 *    each just OPENING an affordance FlowsPage already owns (principle 1:
 *    discoverability over capability).
 *  - <CanvasEmptyHint> overlays a single hint card on an empty canvas pointing
 *    the user at the palette to drop their first (trigger) node.
 *
 * No state lives here; callers pass the handlers that drive the existing flows.
 */
import { useI18n } from '../i18n';
import { CANVAS_HINT_KEYS, type EmptyStateActionId, emptyStateActions } from '../lib/empty-state';

/**
 * The three-CTA empty state shown when a bot has zero flows.
 * `onAction(id)` is wired by FlowsPage to its existing template / import / blank
 * affordances — this component owns no flow-creation logic of its own.
 */
export function FlowsEmptyState({
  onAction,
}: {
  onAction: (id: EmptyStateActionId) => void;
}) {
  const t = useI18n((s) => s.t);
  const actions = emptyStateActions();
  return (
    <div className="empty-state" data-testid="flows-empty-state">
      <h2 className="empty-state-title">{t('flows.emptyState.title')}</h2>
      <p className="empty-state-lead">{t('flows.emptyState.lead')}</p>
      <div className="empty-state-cards">
        {actions.map((a) => (
          <button
            key={a.id}
            type="button"
            className={`empty-state-card${a.primary ? ' primary' : ''}`}
            data-testid={`empty-cta-${a.id}`}
            onClick={() => onAction(a.id)}
          >
            <span className="empty-state-card-title">{t(a.titleKey)}</span>
            <span className="empty-state-card-desc">{t(a.descKey)}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * A dismissible hint overlaid on an EMPTY editor canvas: "add a Telegram Trigger
 * to begin". `onOpenPalette` lets the host nudge the (always-visible) palette —
 * e.g. scroll it into view + flash it — so a first-timer knows where nodes come
 * from. Purely a pointer; it never adds a node itself.
 */
export function CanvasEmptyHint({
  onOpenPalette,
}: {
  onOpenPalette: () => void;
}) {
  const t = useI18n((s) => s.t);
  return (
    <div className="canvas-hint" data-testid="canvas-empty-hint">
      <div className="canvas-hint-title">{t(CANVAS_HINT_KEYS.title)}</div>
      <div className="canvas-hint-body">{t(CANVAS_HINT_KEYS.body)}</div>
      <button type="button" className="primary" onClick={onOpenPalette}>
        {t(CANVAS_HINT_KEYS.cta)}
      </button>
    </div>
  );
}
