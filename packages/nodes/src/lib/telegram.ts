/**
 * Shared Telegram param → Bot-API payload mapping used by tg.sendMessage and
 * tg.waitForReply's prompt. Kept here so the two stay byte-identical.
 */
import type { Keyboard, ParseMode } from '@ctb/shared';

export interface SendOpts {
  chatId: number;
  type: 'text' | 'photo' | 'video' | 'document' | 'audio' | 'sticker';
  text?: string | undefined;
  caption?: string | undefined;
  media?: string | undefined;
  parseMode?: ParseMode | undefined;
  keyboard?: Keyboard | undefined;
  disablePreview?: boolean | undefined;
  protectContent?: boolean | undefined;
  replyTo?: number | undefined;
  silent?: boolean | undefined;
}

/** Build the opts object handed to ctx.tg.sendMessage (the centralized sender). */
export function buildSendPayload(o: SendOpts): Record<string, unknown> {
  const payload: Record<string, unknown> = { chat_id: o.chatId, type: o.type };
  if (o.type === 'text') payload.text = o.text ?? '';
  else {
    payload.media = o.media;
    if (o.caption !== undefined) payload.caption = o.caption;
  }
  if (o.parseMode) payload.parse_mode = o.parseMode;
  if (o.keyboard) payload.reply_markup = keyboardToMarkup(o.keyboard);
  if (o.disablePreview) payload.disable_web_page_preview = true;
  if (o.protectContent) payload.protect_content = true;
  if (o.replyTo !== undefined) payload.reply_to_message_id = o.replyTo;
  if (o.silent) payload.disable_notification = true;
  return payload;
}

/** Keyboard param → Telegram reply_markup. Callback data uses the "btn:<key>" convention. */
export function keyboardToMarkup(kb: Keyboard): Record<string, unknown> {
  switch (kb.kind) {
    case 'inline':
      return {
        inline_keyboard: kb.rows.map((row) =>
          row.map((b) => {
            switch (b.kind) {
              case 'url':
                return { text: b.text, url: b.value };
              case 'web_app':
                return { text: b.text, web_app: { url: b.value } };
              default:
                return { text: b.text, callback_data: `btn:${b.value || b.text}` };
            }
          }),
        ),
      };
    case 'reply':
      return {
        keyboard: kb.rows.map((row) => row.map((text) => ({ text }))),
        resize_keyboard: true,
        one_time_keyboard: kb.one_time,
      };
    case 'remove':
      return { remove_keyboard: true };
  }
}
