/**
 * call.grantTurn — lineup: open the mic to a listener (NODES.md §Live voice, PE-T4).
 *
 * In `lineup` (Q&A) mode the host queues listeners who ask to speak; this action
 * grants a turn — to a specific `userId` (jumps the line) or, when blank, the
 * next person in the queue (the host applies the call's `order`). It resolves
 * with the user granted the turn (or null when the queue is empty), saved on
 * every output item under `save_as` (default `granted`) so the flow can greet
 * them. Goes through `ctx.call` (I6); runs ONCE per node run.
 */
import {
  CallGrantTurnParamsSchema,
  fail,
  out,
  type CallGrantTurnParams,
  type FlowItem,
  type NodeDef,
} from '@ctb/shared';

export const callGrantTurn: NodeDef<CallGrantTurnParams> = {
  type: 'call.grantTurn',
  category: 'flow',
  meta: {
    labelKey: 'nodes.call.grantTurn.label',
    descriptionKey: 'nodeDesc.call.grantTurn',
    icon: 'mic',
  },
  ports: { inputs: ['main'], outputs: ['main'] },
  paramsSchema: CallGrantTurnParamsSchema,
  async execute(ctx, params, items) {
    if (!ctx.call) {
      return fail('call.grantTurn: live-voice is not available in this context (no Call Session Service)');
    }

    let granted: number | string | null;
    try {
      granted = await ctx.call.grantTurn({
        target: { kind: params.targetKind, id: params.targetId },
        ...(params.userId ? { userId: params.userId } : {}),
      });
    } catch (err) {
      return fail(`call.grantTurn: ${err instanceof Error ? err.message : String(err)}`);
    }

    const input: FlowItem[] = items.length > 0 ? items : [{ json: {} }];
    if (!params.save_as) return out({ main: input });
    return out({
      main: input.map((item) => {
        const next: FlowItem = { json: { ...item.json, [params.save_as]: granted } };
        if (item.binary !== undefined) next.binary = item.binary;
        return next;
      }),
    });
  },
};
