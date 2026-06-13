/**
 * flow.return — Return (NODES.md §"Execute Sub-Flow", P3-T1).
 *
 * Terminal node inside a sub-flow: the items it receives become the sub-flow's
 * result. It parks a copy of those items in a reserved $vars key; the host's
 * sub-flow runner (engine/wire.ts) reads that key after the child finishes and
 * hands the items back to the parent's flow.executeSubFlow node, then ends the
 * run like any other terminal node.
 *
 * Reaching flow.return OUTSIDE a sub-flow (a flow run directly) is harmless —
 * it parks the items (nobody reads them) and ends the run normally.
 */
import {
  end,
  FlowReturnParamsSchema,
  type FlowReturnParams,
  type NodeDef,
} from '@ctb/shared';

/**
 * Reserved $vars key the sub-flow's returned items are parked under. Double
 * underscores keep it clear of any user variable name; the host reads it via
 * the SAME exported constant so the contract can never drift.
 */
export const SUBFLOW_RETURN_VAR = '__return__';

export const flowReturn: NodeDef<FlowReturnParams> = {
  type: 'flow.return',
  category: 'flow',
  meta: { labelKey: 'nodes.flow.return.label', descriptionKey: 'nodeDesc.flow.return', icon: 'corner-down-left' },
  ports: { inputs: ['main'], outputs: [] },
  paramsSchema: FlowReturnParamsSchema,
  async execute(ctx, _params, items) {
    // structuredClone so a later mutation of the live items array (the run is
    // about to end, but be defensive) can't leak into what the parent reads.
    ctx.vars.set(SUBFLOW_RETURN_VAR, structuredClone(items));
    return end();
  },
};
