/**
 * flow.stopError — Stop & Error (NODES.md §Flow control).
 * Ends the execution with status=error + message (lands in exec_logs and on
 * the execution row). Optional notify_user sends the message to the chat
 * first — a sender failure must not mask the intended error.
 */
import {
  fail,
  FlowStopErrorParamsSchema,
  type FlowStopErrorParams,
  type NodeDef,
} from '@ctb/shared';

export const flowStopError: NodeDef<FlowStopErrorParams> = {
  type: 'flow.stopError',
  category: 'flow',
  meta: { labelKey: 'nodes.flow.stopError.label', descriptionKey: 'nodes.flow.stopError.desc', icon: 'octagon-x' },
  ports: { inputs: ['main'], outputs: [] },
  paramsSchema: FlowStopErrorParamsSchema,
  async execute(ctx, params) {
    if (params.notify_user && ctx.tg && ctx.chatId !== null) {
      try {
        await ctx.tg.sendMessage({ chat_id: ctx.chatId, type: 'text', text: params.message });
      } catch (err) {
        ctx.log('warn', `flow.stopError: notify_user send failed: ${err instanceof Error ? err.message : err}`);
      }
    }
    return fail(params.message);
  },
};
