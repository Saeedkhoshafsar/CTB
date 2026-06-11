/**
 * tg.sendMessage — Send Message (NODES.md §Telegram).
 *
 * Per-item: sends one message per input item (n8n semantics), passes items
 * through with `sent_message_id` added to json. The actual Telegram I/O goes
 * through ctx.tg (the centralized, rate-limited TgSender) — this node never
 * sees a token or an HTTP socket (invariants I3/I6).
 */
import {
  fail,
  out,
  TgSendMessageParamsSchema,
  type FlowItem,
  type NodeDef,
  type TgSendMessageParams,
} from '@ctb/shared';
import { buildSendPayload } from '../lib/telegram';

export const tgSendMessage: NodeDef<TgSendMessageParams> = {
  type: 'tg.sendMessage',
  category: 'telegram',
  meta: { labelKey: 'nodes.tg.sendMessage.label', descriptionKey: 'nodes.tg.sendMessage.desc', icon: 'send' },
  ports: { inputs: ['main'], outputs: ['main'] },
  paramsSchema: TgSendMessageParamsSchema,
  async execute(ctx, params, items) {
    if (!ctx.tg) return fail('tg.sendMessage requires a Telegram context (no sender injected)');

    const explicitChat =
      params.chat === undefined ? undefined : coerceChatId(params.chat);
    if (params.chat !== undefined && explicitChat === undefined) {
      return fail(`tg.sendMessage: invalid chat "${String(params.chat)}"`);
    }
    const chatId = explicitChat ?? ctx.chatId ?? undefined;
    if (chatId === undefined) {
      return fail('tg.sendMessage: no chat — execution has no chat context and `chat` param is empty');
    }

    const inputs: FlowItem[] = items.length > 0 ? items : [{ json: {} }];
    const outputs: FlowItem[] = [];
    for (const item of inputs) {
      const payload = buildSendPayload({
        chatId,
        type: params.type,
        text: params.text,
        caption: params.caption,
        media: params.media,
        parseMode: params.parse_mode,
        keyboard: params.keyboard,
        disablePreview: params.options?.disable_preview,
        protectContent: params.options?.protect_content,
        replyTo: params.options?.reply_to,
        silent: params.options?.silent,
      });
      const { messageId } = await ctx.tg.sendMessage(payload);
      outputs.push({ ...item, json: { ...item.json, sent_message_id: messageId } });
    }
    return out({ main: outputs });
  },
};

function coerceChatId(chat: number | string): number | undefined {
  if (typeof chat === 'number') return Number.isInteger(chat) ? chat : undefined;
  const n = Number(chat.trim());
  return Number.isInteger(n) && chat.trim() !== '' ? n : undefined;
}
