/**
 * tg.trigger — Telegram Trigger (NODES.md §Triggers).
 *
 * The MATCHING happens in the update router (apps/server/src/engine/match.ts —
 * triggerMatches reads this node's params straight from the graph). By the
 * time execute() runs, the router has already built the trigger item
 * (triggerItem) and injected it via Executor.start entry items — so the node
 * itself is a typed pass-through: it exists to carry the param schema
 * (editor form, validation) and to anchor the entry point in the graph.
 */
import { out, TgTriggerParamsSchema, type NodeDef, type TgTriggerParams } from '@ctb/shared';

export const tgTrigger: NodeDef<TgTriggerParams> = {
  type: 'tg.trigger',
  category: 'trigger',
  meta: { labelKey: 'nodes.tg.trigger.label', descriptionKey: 'nodes.tg.trigger.desc', icon: 'zap' },
  ports: { inputs: [], outputs: ['main'] },
  paramsSchema: TgTriggerParamsSchema,
  async execute(_ctx, _params, items) {
    return out({ main: items });
  },
};
