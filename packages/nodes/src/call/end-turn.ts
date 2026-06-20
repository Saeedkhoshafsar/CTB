/**
 * call.endTurn — lineup: close the current speaker's turn (NODES.md §Live voice,
 * PE-T4). After a granted listener finishes, this hands the mic back so the queue
 * can advance (the flow then calls `call.grantTurn` for the next person, or the
 * host auto-advances when `maxTurnSeconds` is set). Goes through `ctx.call` (I6);
 * runs ONCE per node run; fails loud when no Call Session Service is wired.
 */
import {
  CallEndTurnParamsSchema,
  fail,
  out,
  type CallEndTurnParams,
  type NodeDef,
} from '@ctb/shared';

export const callEndTurn: NodeDef<CallEndTurnParams> = {
  type: 'call.endTurn',
  category: 'flow',
  meta: {
    labelKey: 'nodes.call.endTurn.label',
    descriptionKey: 'nodeDesc.call.endTurn',
    icon: 'mic-off',
  },
  ports: { inputs: ['main'], outputs: ['main'] },
  paramsSchema: CallEndTurnParamsSchema,
  async execute(ctx, params, items) {
    if (!ctx.call) {
      return fail('call.endTurn: live-voice is not available in this context (no Call Session Service)');
    }
    try {
      await ctx.call.endTurn({ target: { kind: params.targetKind, id: params.targetId } });
    } catch (err) {
      return fail(`call.endTurn: ${err instanceof Error ? err.message : String(err)}`);
    }
    return out({ main: items.length > 0 ? items : [{ json: {} }] });
  },
};
