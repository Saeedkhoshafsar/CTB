/**
 * call.connect — join/start a live Telegram call (NODES.md §Live voice, PE-T4).
 *
 * The flow's first live-voice ACTION: it asks the host's Call Session Service to
 * dial `target` using a `voiceConnection` credential, in moderation `mode`. The
 * node holds NO media socket — it calls the one typed `ctx.call` capability and
 * the host owns the connection (invariants I3/I4/I6). `target`/`mode` are
 * SETTINGS, so the SAME node serves both scenarios: a 1:1 `support` AI call and
 * a group/channel `lineup` Q&A broadcast (PLAN2 §E.1, invariant I2).
 *
 * Idempotent per target (connecting an already-live call is a host no-op). Runs
 * ONCE per node run (a call is shared state, not per-item). Fails loud when no
 * Call Session Service is wired (`ctx.call === null`, I6) or the connector errors.
 */
import {
  CallConnectParamsSchema,
  fail,
  out,
  type CallConnectParams,
  type CallMode,
  type CallTurnOrder,
  type NodeDef,
} from '@ctb/shared';

export const callConnect: NodeDef<CallConnectParams> = {
  type: 'call.connect',
  category: 'flow',
  meta: {
    labelKey: 'nodes.call.connect.label',
    descriptionKey: 'nodeDesc.call.connect',
    icon: 'phone',
  },
  ports: { inputs: ['main'], outputs: ['main'] },
  paramsSchema: CallConnectParamsSchema,
  async execute(ctx, params, items) {
    if (!ctx.call) {
      return fail('call.connect: live-voice is not available in this context (no Call Session Service)');
    }
    try {
      await ctx.call.connect({
        credentialId: params.connection,
        target: { kind: params.targetKind, id: params.targetId },
        mode: params.mode as CallMode,
        order: params.order as CallTurnOrder,
        maxTurnSeconds: params.maxTurnSeconds,
      });
    } catch (err) {
      return fail(`call.connect: ${err instanceof Error ? err.message : String(err)}`);
    }
    return out({ main: items.length > 0 ? items : [{ json: {} }] });
  },
};
