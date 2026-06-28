/**
 * tg.editMessage — Edit Message (NODES.md §"Edit Message", P3-T3).
 *
 * Edits a message's text, caption, or just its inline keyboard, once per input
 * item. The message id defaults to the id the item already carries
 * (`$json.sent_message_id` from a prior tg.sendMessage, or
 * `$json.clicked.message_id` from a button click) so the common "edit what I
 * just sent / what was clicked" flow needs no params. All Telegram I/O rides
 * ctx.tg (the centralized, rate-limited sender) — invariants I3/I6.
 */
import {
  fail,
  out,
  TgEditMessageParamsSchema,
  type FlowItem,
  type NodeDef,
  type TgEditMessageParams,
} from '@ctb/shared';
import { keyboardToMarkup } from '../lib/telegram';
import { coerceChatId, coerceMessageId, messageIdFromItem, tgNoBotError, tgNoChatError } from './helpers';

export const tgEditMessage: NodeDef<TgEditMessageParams> = {
  type: 'tg.editMessage',
  category: 'telegram',
  meta: { labelKey: 'nodes.tg.editMessage.label', descriptionKey: 'nodeDesc.tg.editMessage', icon: 'pencil' },
  ports: { inputs: ['main'], outputs: ['main'] },
  paramsSchema: TgEditMessageParamsSchema,
  async execute(ctx, params, items) {
    if (!ctx.tg) return fail(tgNoBotError('ویرایش پیام / edit a message'));

    const explicitChat = params.chat === undefined ? undefined : coerceChatId(params.chat);
    if (params.chat !== undefined && explicitChat === undefined) {
      return fail(`tg.editMessage: invalid chat "${String(params.chat)}"`);
    }
    const chatId = explicitChat ?? ctx.chatId ?? undefined;
    if (chatId === undefined) {
      return fail(tgNoChatError('ویرایش پیام / edit a message'));
    }

    // Pick the capability matching the target up front so a missing host
    // injection fails loudly instead of silently no-op'ing.
    const cap =
      params.target === 'text'
        ? ctx.tg.editMessageText
        : params.target === 'caption'
          ? ctx.tg.editMessageCaption
          : ctx.tg.editMessageReplyMarkup;
    if (!cap) {
      return fail(`tg.editMessage: editing "${params.target}" is not supported by this host`);
    }

    const inputs: FlowItem[] = items.length > 0 ? items : [{ json: {} }];
    const markup = params.keyboard ? keyboardToMarkup(params.keyboard) : undefined;

    for (const item of inputs) {
      const messageId =
        params.message_id !== undefined ? coerceMessageId(params.message_id) : messageIdFromItem(item.json);
      if (messageId === undefined) {
        return fail('tg.editMessage: no message_id — set the param or pipe an item carrying sent_message_id/clicked.message_id');
      }

      const payload: Record<string, unknown> = { chat_id: chatId, message_id: messageId };
      if (params.target === 'text') {
        payload.text = params.text;
        if (params.parse_mode) payload.parse_mode = params.parse_mode;
        if (markup) payload.reply_markup = markup;
      } else if (params.target === 'caption') {
        payload.caption = params.text;
        if (params.parse_mode) payload.parse_mode = params.parse_mode;
        if (markup) payload.reply_markup = markup;
      } else {
        // keyboard-only edit
        payload.reply_markup = markup;
      }
      await cap(payload);
    }
    return out({ main: inputs });
  },
};
