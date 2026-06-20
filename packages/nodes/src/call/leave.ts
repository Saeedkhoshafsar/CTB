/**
 * call.leave — leave/end a live call (NODES.md §Live voice, PE-T4). The clean
 * teardown after the conversation ends (the host also auto-leaves on the
 * `maxCallSeconds` cap). Idempotent per target (leaving a call that's already
 * gone is a host no-op). Goes through `ctx.call` (I6); runs ONCE per node run;
 * fails loud when no Call Session Service is wired or the connector errors.
 */
import {
  CallLeaveParamsSchema,
  fail,
  out,
  type CallLeaveParams,
  type NodeDef,
} from '@ctb/shared';

export const callLeave: NodeDef<CallLeaveParams> = {
  type: 'call.leave',
  category: 'flow',
  meta: {
    labelKey: 'nodes.call.leave.label',
    descriptionKey: 'nodeDesc.call.leave',
    icon: 'phone-off',
  },
  ports: { inputs: ['main'], outputs: ['main'] },
  paramsSchema: CallLeaveParamsSchema,
  async execute(ctx, params, items) {
    if (!ctx.call) {
      return fail('call.leave: live-voice is not available in this context (no Call Session Service)');
    }
    try {
      await ctx.call.leave({ target: { kind: params.targetKind, id: params.targetId } });
    } catch (err) {
      return fail(`call.leave: ${err instanceof Error ? err.message : String(err)}`);
    }
    return out({ main: items.length > 0 ? items : [{ json: {} }] });
  },
};
