/**
 * Test-run mode decision (PLAN4 J-T2) — the cure for the "I can't even test"
 * blocker (Report B). Before J-T2 the editor's only way to trial a flow was the
 * `flow.manualTrigger`; a flow whose real entry is a `tg.trigger` got a dead-end
 * "use the Manual trigger instead" alert. n8n's answer is "listen for one test
 * event": the SAME trigger node arms, waits for the next live update, and feeds
 * the real sender data downstream — then powers production unchanged.
 *
 * This module is the PURE, DOM-free core of that choice (the F-T3 pattern used
 * by `flow-export.ts`): given the flow's nodes it decides whether Test-run
 * should fire the `manual` path (synchronous `POST /run`), the `listen` path
 * (arm `POST /test-listen` and wait), or `none` (no enabled trigger at all → the
 * only case that still surfaces a "add a trigger" hint). Keeping it pure means
 * the decision — which is the behaviour users actually feel — is unit-tested
 * with no React, and the page component stays a thin wire over it.
 *
 * Precedence rationale: a `flow.manualTrigger` is an explicit "test this with a
 * sample payload" affordance, so when BOTH triggers exist we honour the manual
 * one (it runs instantly and deterministically, the historical behaviour). Only
 * a flow with NO manual trigger but a live `tg.trigger` enters listen mode — the
 * exact flows that used to hit the dead-end alert.
 */
import type { FlowGraph } from '@ctb/shared';

/** The two real run paths plus the no-trigger sentinel. */
export type TestRunMode = 'manual' | 'listen' | 'none';

/** Node-type the server's `/run` endpoint starts at (synchronous test run). */
export const MANUAL_TRIGGER_TYPE = 'flow.manualTrigger';
/** Node-type that arms a live "listen for one update" test run (J-T1 seam). */
export const TELEGRAM_TRIGGER_TYPE = 'tg.trigger';

/** A node is eligible as an entry only when it is present AND not disabled. */
function hasEnabled(graph: Pick<FlowGraph, 'nodes'>, type: string): boolean {
  return graph.nodes.some((n) => n.type === type && !n.disabled);
}

/**
 * Decide how the editor's "Test run" button should behave for this flow.
 *
 * - `manual` → there is an enabled `flow.manualTrigger` (runs synchronously via
 *   `POST /api/flows/:id/run`); takes precedence so the historical sample-payload
 *   path is byte-for-byte unchanged when a manual trigger exists.
 * - `listen` → no manual trigger, but an enabled `tg.trigger` exists: arm the
 *   live listen (`POST /api/flows/:id/test-listen`) and wait for one real update.
 * - `none`   → neither enabled trigger exists; the page shows the "add a trigger"
 *   hint (the ONLY remaining alert — never the old "use Manual instead" one).
 *
 * Pure: depends solely on the graph's node types/disabled flags, no DOM/globals.
 */
export function decideTestRunMode(graph: Pick<FlowGraph, 'nodes'> | null | undefined): TestRunMode {
  if (!graph) return 'none';
  if (hasEnabled(graph, MANUAL_TRIGGER_TYPE)) return 'manual';
  if (hasEnabled(graph, TELEGRAM_TRIGGER_TYPE)) return 'listen';
  return 'none';
}
