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
import type { InputSlot, NodeRole, SlotKind } from './node-def';

const EXPR_MARK = '{{';

/**
 * The slot/role facts the validator needs about a node TYPE (PB-T1). The server
 * and the editor's test fake each build this from the SAME registry the engine
 * runs (I5), so a flow that activates here activates there. A missing entry for
 * a type means "plain data node, no slots" — which is exactly every Phase-A node.
 */
export interface NodeSlotMeta {
  role?: NodeRole;
  inputSlots?: readonly InputSlot[];
  provides?: SlotKind;
}

/** True when this `to.port` is a typed sub-connection slot, not a data port. */
function slotForPort(meta: NodeSlotMeta | undefined, port: string): InputSlot | undefined {
  return meta?.inputSlots?.find((s) => s.kind === port);
}

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
  // P4-T2: a cron schedule is a flow entry point — the Scheduler starts the
  // flow at this node (chatId=null, or per-user on a for_each_user fan-out)
  // when the cron expression fires.
  'schedule.trigger',
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
  nodeMeta?: ReadonlyMap<string, NodeSlotMeta>,
): FlowProblem[] {
  const problems: FlowProblem[] = [];

  // A `role:'provider'` sub-node is NOT a flow entry point (PB-T1), so it never
  // counts as a trigger even if it lived in the trigger namespace.
  const isProvider = (type: string): boolean => nodeMeta?.get(type)?.role === 'provider';

  // Any trigger-namespace anchor counts (tg.trigger, flow.manualTrigger,
  // future webhook/schedule/collection triggers).
  const triggers = graph.nodes.filter(
    (n) => TRIGGER_TYPES.has(n.type) && !n.disabled && !isProvider(n.type),
  );
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

  // ── typed sub-connection rules (PB-T1) ──────────────────────────────────
  // Only enforced when slot/role metadata is supplied; without it (legacy
  // callers, pure-schema tests) the graph is judged exactly as before.
  if (nodeMeta) validateSubConnections(graph, nodeMeta, problems);

  return problems;
}

/**
 * Enforce the provider/slot contract over the graph's edges (PB-T1):
 *  - an edge into a consumer's slot port must come from a `provider` node whose
 *    `provides` matches the slot kind (no data node, no wrong kind);
 *  - a `provider` node's output may ONLY land on a matching slot — never on a
 *    plain data input port, and a provider is never a data sink either;
 *  - a non-`repeatable` slot accepts at most one provider;
 *  - a `required` slot must be filled (skipped for a disabled consumer).
 * Disabled nodes (consumer or provider) are ignored, matching the executor's
 * pass-through behavior.
 */
function validateSubConnections(
  graph: FlowGraph,
  nodeMeta: ReadonlyMap<string, NodeSlotMeta>,
  problems: FlowProblem[],
): void {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const metaOf = (id: string): NodeSlotMeta | undefined => {
    const n = byId.get(id);
    return n ? nodeMeta.get(n.type) : undefined;
  };
  const isProviderNode = (id: string): boolean => metaOf(id)?.role === 'provider';

  // Count providers landing on each consumer slot, to check arity + required.
  const slotFill = new Map<string, number>(); // key: `${consumerId}\u0000${slotKind}`

  for (const edge of graph.edges) {
    const source = byId.get(edge.from.node);
    const target = byId.get(edge.to.node);
    if (!source || !target) continue; // FlowGraphSchema already flags dangling edges
    if (source.disabled || target.disabled) continue;

    const targetMeta = metaOf(edge.to.node);
    const slot = slotForPort(targetMeta, edge.to.port);
    const sourceIsProvider = isProviderNode(edge.from.node);

    if (slot) {
      // This edge targets a typed slot → its source MUST be a matching provider.
      const provides = metaOf(edge.from.node)?.provides;
      if (!sourceIsProvider || provides !== slot.kind) {
        problems.push({
          nodeId: edge.to.node,
          message: `slot "${slot.kind}" must be fed by a ${slot.kind} provider, not "${source.type}"`,
        });
      } else {
        const key = `${edge.to.node}\u0000${slot.kind}`;
        slotFill.set(key, (slotFill.get(key) ?? 0) + 1);
      }
    } else if (sourceIsProvider) {
      // A provider's wire landed on a NON-slot port (a plain data input, or a
      // consumer with no such slot) — providers attach only to matching slots.
      problems.push({
        nodeId: edge.from.node,
        message: `provider "${source.type}" can only attach to a matching ${metaOf(edge.from.node)?.provides} slot`,
      });
    }
  }

  // A non-repeatable slot may hold at most one provider; a required slot must
  // be filled. Checked per enabled consumer that declares slots.
  for (const node of graph.nodes) {
    if (node.disabled) continue;
    const meta = nodeMeta.get(node.type);
    if (!meta?.inputSlots || meta.inputSlots.length === 0) continue;
    for (const slot of meta.inputSlots) {
      const filled = slotFill.get(`${node.id}\u0000${slot.kind}`) ?? 0;
      if (slot.required && filled === 0) {
        problems.push({ nodeId: node.id, message: `required slot "${slot.kind}" is not connected` });
      }
      if (!slot.repeatable && filled > 1) {
        problems.push({
          nodeId: node.id,
          message: `slot "${slot.kind}" accepts only one provider (got ${filled})`,
        });
      }
    }
  }
}

/** Flatten structured problems into the legacy `problems: string[]` strings. */
export function problemStrings(problems: FlowProblem[]): string[] {
  return problems.map((p) => (p.nodeId ? `${p.nodeId}: ${p.message}` : p.message));
}
