/**
 * tg.deleteMessage — Delete Message (NODES.md §"Delete Message", P3-T3).
 *
 * Deletes one message per input item; the id defaults to the id the item
 * carries (`$json.sent_message_id` / `$json.clicked.message_id`). Items pass
 * through unchanged so the flow can continue. All I/O via ctx.tg (I3/I6).
 */
import {
  fail,
  out,
  TgDeleteMessageParamsSchema,
  type FlowItem,
  type NodeDef,
  type TgDeleteMessageParams,
} from '@ctb/shared';
import { coerceChatId, coerceMessageId, messageIdFromItem } from './helpers';

export const tgDeleteMessage: NodeDef<TgDeleteMessageParams> = {
  type: 'tg.deleteMessage',
  category: 'telegram',
  meta: { labelKey: 'nodes.tg.deleteMessage.label', descriptionKey: 'nodeDesc.tg.deleteMessage', icon: 'trash' },
  ports: { inputs: ['main'], outputs: ['main'] },
  paramsSchema: TgDeleteMessageParamsSchema,
  async execute(ctx, params, items) {
    if (!ctx.tg) return fail('tg.deleteMessage requires a Telegram context (no sender injected)');
    if (!ctx.tg.deleteMessage) return fail('tg.deleteMessage is not supported by this host');

    const explicitChat = params.chat === undefined ? undefined : coerceChatId(params.chat);
    if (params.chat !== undefined && explicitChat === undefined) {
      return fail(`tg.deleteMessage: invalid chat "${String(params.chat)}"`);
    }
    const chatId = explicitChat ?? ctx.chatId ?? undefined;
    if (chatId === undefined) {
      return fail('tg.deleteMessage: no chat — execution has no chat context and `chat` param is empty');
    }

    const inputs: FlowItem[] = items.length > 0 ? items : [{ json: {} }];
    for (const item of inputs) {
      const messageId =
        params.message_id !== undefined ? coerceMessageId(params.message_id) : messageIdFromItem(item.json);
      if (messageId === undefined) {
        return fail('tg.deleteMessage: no message_id — set the param or pipe an item carrying sent_message_id/clicked.message_id');
      }
      await ctx.tg.deleteMessage({ chat_id: chatId, message_id: messageId });
    }
    return out({ main: inputs });
  },
};
