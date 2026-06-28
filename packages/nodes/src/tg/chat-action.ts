/**
 * tg.chatAction — Send Chat Action (NODES.md §"Send Chat Action", P3-T3).
 *
 * Shows a transient activity indicator ("typing…", "uploading photo…", …) in
 * the chat. Telegram auto-clears it after ~5s or when the next message arrives,
 * so this node fires once per run (not per item) against the target chat and
 * passes its input items through unchanged. All I/O via ctx.tg (I3/I6).
 */
import {
  fail,
  out,
  TgChatActionParamsSchema,
  type NodeDef,
  type TgChatActionParams,
} from '@ctb/shared';
import { coerceChatId, tgNoBotError, tgNoChatError } from './helpers';

export const tgChatAction: NodeDef<TgChatActionParams> = {
  type: 'tg.chatAction',
  category: 'telegram',
  meta: { labelKey: 'nodes.tg.chatAction.label', descriptionKey: 'nodeDesc.tg.chatAction', icon: 'activity' },
  ports: { inputs: ['main'], outputs: ['main'] },
  paramsSchema: TgChatActionParamsSchema,
  async execute(ctx, params, items) {
    if (!ctx.tg) return fail(tgNoBotError('ارسال اکشن چت / send a chat action'));
    if (!ctx.tg.sendChatAction) return fail('tg.chatAction is not supported by this host');

    const explicitChat = params.chat === undefined ? undefined : coerceChatId(params.chat);
    if (params.chat !== undefined && explicitChat === undefined) {
      return fail(`tg.chatAction: invalid chat "${String(params.chat)}"`);
    }
    const chatId = explicitChat ?? ctx.chatId ?? undefined;
    if (chatId === undefined) {
      return fail(tgNoChatError('ارسال اکشن چت / send a chat action'));
    }

    await ctx.tg.sendChatAction({ chat_id: chatId, action: params.action });
    return out({ main: items });
  },
};
