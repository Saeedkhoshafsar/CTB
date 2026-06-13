/**
 * flow.executeSubFlow — Execute Sub-Flow (NODES.md §"Execute Sub-Flow", P3-T1).
 *
 * Calls another flow OF THE SAME BOT, passing the current items as its entry
 * payload. The host (engine/wire.ts) owns the nested run (invariant I6 — a node
 * never instantiates an executor) via the injected `ctx.subflow` capability,
 * which also enforces same-bot ownership and the recursion-depth cap.
 *
 *  • wait            — run the child to completion and emit the items its
 *                      flow.return node handed back, on `main`.
 *  • fire_and_forget — start the child but don't wait; pass THIS node's input
 *                      through on `main` unchanged. A child failure is logged,
 *                      never surfaced (the parent has already moved on).
 *
 * A direct self-call is rejected up front (the depth cap would eventually stop
 * indirect recursion, but a flow calling itself is almost always a mistake).
 */
import {
  fail,
  FlowExecuteSubFlowParamsSchema,
  out,
  type FlowExecuteSubFlowParams,
  type NodeDef,
} from '@ctb/shared';

export const flowExecuteSubFlow: NodeDef<FlowExecuteSubFlowParams> = {
  type: 'flow.executeSubFlow',
  category: 'flow',
  meta: {
    labelKey: 'nodes.flow.executeSubFlow.label',
    descriptionKey: 'nodeDesc.flow.executeSubFlow',
    icon: 'workflow',
  },
  ports: { inputs: ['main'], outputs: ['main'] },
  paramsSchema: FlowExecuteSubFlowParamsSchema,
  async execute(ctx, params, items) {
    // A flow calling itself directly is rejected before touching the host —
    // keeps `subflowCalls` empty and gives a clear message instead of relying
    // on the depth cap to unwind a tight self-loop.
    if (params.flow_id === ctx.flowId) {
      return fail('flow.executeSubFlow: a flow cannot call itself directly');
    }
    if (!ctx.subflow) {
      return fail('flow.executeSubFlow: sub-flow execution is not available on this instance');
    }

    if (params.mode === 'fire_and_forget') {
      // Start the child but don't await it; swallow + log any failure so the
      // parent run is never affected by a detached child blowing up.
      void ctx.subflow.run(params.flow_id, items).catch((err) => {
        ctx.log('warn', `flow.executeSubFlow: fire-and-forget child flow failed: ${err instanceof Error ? err.message : err}`);
      });
      // Pass our own input straight through — the child's result is discarded.
      return out({ main: items });
    }

    // wait: run the child synchronously and emit what it returned.
    try {
      const result = await ctx.subflow.run(params.flow_id, items);
      return out({ main: result.items });
    } catch (err) {
      return fail(`flow.executeSubFlow: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
};