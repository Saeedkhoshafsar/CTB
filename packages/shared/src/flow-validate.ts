/**
 * Activation-time flow validation (P2-T4) — pure, shared.
 *
 * One implementation produces the `FlowProblem[]` that (a) the server's
 * activate endpoint returns as a 422 and (b) the editor surfaces as badges
 * on the offending canvas nodes. Lives in shared (not server) because the
 * editor's test fake must mirror the real endpoint EXACTLY (I5) — both call
 * this function with their own type→Zod-schema map.
 *
 * Expression caveat: node params may carry `{{ }}` templates that only
 * resolve at runtime (the executor evaluates BEFORE Zod, P1-T4). A static
 * check can't know what an expression yields, so Zod issues whose offending
 * value is a string containing `{{` are skipped — we refuse to block
 * activation on values we cannot honestly judge.
 */
import type { ZodType } from 'zod';
import type { FlowProblem } from './api';
import type { FlowGraph } from './flow';

const EXPR_MARK = '{{';

/** Node types that anchor a flow's entry point (activation requires one). */
const TRIGGER_TYPES: ReadonlySet<string> = new Set([
  'tg.trigger',
  'flow.manualTrigger',
  // P3.5-T5: a record-write trigger is a flow entry point too — the event bus
  // starts the flow at this node (chatId=null) when a matching record changes.
  'collection.recordChanged',
  // P4-T1: an inbound HTTP webhook is a flow entry point — the webhook route
  // starts the flow at this node (chatId=null) when a signed request arrives.
  'webhook.trigger',
]);

/** Walk a Zod issue path into the raw params object (tolerant of misses). */
function valueAtPath(root: unknown, path: ReadonlyArray<PropertyKey>): unknown {
  let cur: unknown = root;
  for (const key of path) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<PropertyKey, unknown>)[key];
  }
  return cur;
}

/**
 * Validate a graph for activation against a map of node type → params schema.
 * Returns [] when activatable. Disabled nodes are skipped (the executor
 * passes items straight through them, so their params never run).
 */
export function validateFlowForActivation(
  graph: FlowGraph,
  paramSchemas: ReadonlyMap<string, ZodType>,
): FlowProblem[] {
  const problems: FlowProblem[] = [];

  // Any trigger-namespace anchor counts (tg.trigger, flow.manualTrigger,
  // future webhook/schedule/collection triggers).
  const triggers = graph.nodes.filter((n) => TRIGGER_TYPES.has(n.type) && !n.disabled);
  if (triggers.length === 0) {
    problems.push({ nodeId: null, message: 'flow has no enabled trigger node' });
  }

  for (const node of graph.nodes) {
    if (node.disabled) continue;
    const schema = paramSchemas.get(node.type);
    if (!schema) {
      problems.push({ nodeId: node.id, message: `unknown node type "${node.type}"` });
      continue;
    }
    const parsed = schema.safeParse(node.params);
    if (parsed.success) continue;
    for (const issue of parsed.error.issues) {
      const offending = valueAtPath(node.params, issue.path);
      if (typeof offending === 'string' && offending.includes(EXPR_MARK)) continue;
      const at = issue.path.join('.') || '(params)';
      problems.push({ nodeId: node.id, message: `${at}: ${issue.message}` });
    }
  }
  return problems;
}

/** Flatten structured problems into the legacy `problems: string[]` strings. */
export function problemStrings(problems: FlowProblem[]): string[] {
  return problems.map((p) => (p.nodeId ? `${p.nodeId}: ${p.message}` : p.message));
}
