/**
 * Empty-state logic (PLAN3 F-T1) — the "I couldn't build anything" cure.
 *
 * The diagnosis behind PLAN3 was discoverability, not missing capability: a
 * brand-new user landed on an empty flow list / empty canvas with no idea what
 * to do, even though import / templates / a blank canvas all already exist. This
 * module is the PURE, DOM-free core of the guided empty state so its decisions
 * (which call-to-action, which i18n keys, is the canvas empty) are unit-testable
 * with no React — exactly the pattern F-T3 used for `flow-export.ts`.
 *
 * Principle 1 (discoverability over capability): every CTA below just SURFACES
 * an affordance the FlowsPage already backs — `template`/`import`/`blank` map
 * 1:1 onto the existing template gallery, import panel and "New flow" form.
 */
import type { FlowGraph } from '@ctb/shared';
import type { MessageKey } from '../i18n';

/**
 * The three things a first-timer can do from an empty flow list. Each id maps to
 * an EXISTING FlowsPage affordance (no new flow-creation path is introduced).
 */
export type EmptyStateActionId = 'template' | 'import' | 'blank';

/** A single call-to-action card in the guided empty state. */
export interface EmptyStateAction {
  /** which existing FlowsPage affordance this opens */
  readonly id: EmptyStateActionId;
  /** i18n key for the button/title (resolved by the component, kept pure here) */
  readonly titleKey: MessageKey;
  /** i18n key for the one-line explanation under the title */
  readonly descKey: MessageKey;
  /** the primary CTA renders emphasized; the rest are secondary */
  readonly primary: boolean;
}

/**
 * The ordered CTAs for a bot with zero flows. Order = recommended-first:
 * "Start from template" is the fastest path to a working bot (the F-T1 goal of
 * a reply in under 5 minutes), so it's primary; import + blank follow.
 *
 * Pure constant function (no globals) so a test can assert the exact set, order
 * and that fa/en both carry every referenced key.
 */
export function emptyStateActions(): readonly EmptyStateAction[] {
  return [
    {
      id: 'template',
      titleKey: 'flows.emptyState.template.title',
      descKey: 'flows.emptyState.template.desc',
      primary: true,
    },
    {
      id: 'import',
      titleKey: 'flows.emptyState.import.title',
      descKey: 'flows.emptyState.import.desc',
      primary: false,
    },
    {
      id: 'blank',
      titleKey: 'flows.emptyState.blank.title',
      descKey: 'flows.emptyState.blank.desc',
      primary: false,
    },
  ];
}

/**
 * Whether a flow's canvas is empty (no nodes). Used by the editor to decide
 * whether to overlay the "add a Telegram Trigger to begin" hint. A graph with
 * any node — even a disconnected one — is considered started, so the hint never
 * nags once the user has placed something.
 */
export function isCanvasEmpty(graph: Pick<FlowGraph, 'nodes'> | null | undefined): boolean {
  return !graph || graph.nodes.length === 0;
}

/** i18n keys for the empty-canvas hint card, kept beside the list above. */
export const CANVAS_HINT_KEYS = {
  title: 'editor.canvasHint.title',
  body: 'editor.canvasHint.body',
  cta: 'editor.canvasHint.cta',
} as const satisfies Record<string, MessageKey>;
