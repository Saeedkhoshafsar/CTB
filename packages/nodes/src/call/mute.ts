/**
 * call.mute — mute or unmute a participant (NODES.md §Live voice, PE-T4). A
 * moderation action for both modes (silence a noisy listener in `lineup`, or a
 * caller in `support`). `muted:true` mutes, `false` unmutes. Goes through
 * `ctx.call` (I6); runs ONCE per node run; fails loud when no Call Session
 * Service is wired or the connector errors.
 */
import {
  CallMuteParamsSchema,
  fail,
  out,
  type CallMuteParams,
  type NodeDef,
} from '@ctb/shared';

export const callMute: NodeDef<CallMuteParams> = {
  type: 'call.mute',
  category: 'flow',
  meta: {
    labelKey: 'nodes.call.mute.label',
    descriptionKey: 'nodeDesc.call.mute',
    icon: 'volume-x',
  },
  ports: { inputs: ['main'], outputs: ['main'] },
  paramsSchema: CallMuteParamsSchema,
  async execute(ctx, params, items) {
    if (!ctx.call) {
      return fail('call.mute: live-voice is not available in this context (no Call Session Service)');
    }
    try {
      await ctx.call.mute({
        target: { kind: params.targetKind, id: params.targetId },
        userId: params.userId,
        muted: params.muted,
      });
    } catch (err) {
      return fail(`call.mute: ${err instanceof Error ? err.message : String(err)}`);
    }
    return out({ main: items.length > 0 ? items : [{ json: {} }] });
  },
};
