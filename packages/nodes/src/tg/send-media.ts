/**
 * tg.sendMedia — Send Media / Album (NODES.md §Telegram, PLAN2 PA-T1).
 *
 * Sends ONE media message, or an ALBUM (media group) of 2–10 photos/videos in a
 * single message. Unlike tg.sendMessage (which only accepts a URL or a Telegram
 * file_id), this node can UPLOAD BYTES — from a CTB Collection / file-store file
 * id (`source:'file'`, read host-side via ctx.files) or inline base64
 * (`source:'base64'`). Caption + parse-mode are preserved; a keyboard is allowed
 * on single-item sends only (Telegram forbids one on a media group).
 *
 * The node resolves each author-configured media item into a `TgInputMedia`
 * (URL/file_id passed through as `ref`; file/base64 turned into `bytes`) and
 * hands the batch to ctx.tg.sendMedia — the HOST owns the actual Bot-API upload
 * (sendPhoto/sendVideo/sendDocument/sendAudio or sendMediaGroup) and the token,
 * socket and disk (invariants I3/I6). Runs once per node run (an album is one
 * message; one send per item would defeat the point); passes items through with
 * `sent_message_ids` (and `sent_message_id` = the first) added to json.
 */
import {
  fail,
  out,
  TgSendMediaParamsSchema,
  type FlowItem,
  type MediaItem,
  type NodeDef,
  type TgInputMedia,
  type TgSendMediaParams,
} from '@ctb/shared';
import { keyboardToMarkup } from '../lib/telegram';
import { coerceChatId, tgNoBotError, tgNoChatError } from './helpers';

/** Decode a base64 string to bytes (pure; no Node Buffer dependency in nodes). */
function decodeBase64(value: string): Uint8Array {
  // Strip an optional data-URL prefix ("data:image/png;base64,....").
  const comma = value.indexOf(',');
  const b64 = value.startsWith('data:') && comma !== -1 ? value.slice(comma + 1) : value;
  const bin = atob(b64.replace(/\s+/g, ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

export const tgSendMedia: NodeDef<TgSendMediaParams> = {
  type: 'tg.sendMedia',
  category: 'telegram',
  meta: { labelKey: 'nodes.tg.sendMedia.label', descriptionKey: 'nodes.tg.sendMedia.desc', icon: 'image' },
  ports: { inputs: ['main'], outputs: ['main'] },
  paramsSchema: TgSendMediaParamsSchema,
  async execute(ctx, params, items) {
    if (!ctx.tg) return fail(tgNoBotError('ارسال رسانه / send media'));
    if (!ctx.tg.sendMedia) {
      return fail('tg.sendMedia is not available on this instance (host did not inject sendMedia)');
    }

    const explicitChat =
      params.chat === undefined ? undefined : coerceChatId(params.chat);
    if (params.chat !== undefined && explicitChat === undefined) {
      return fail(`tg.sendMedia: invalid chat "${String(params.chat)}"`);
    }
    const chatId = explicitChat ?? ctx.chatId ?? undefined;
    if (chatId === undefined) {
      return fail(tgNoChatError('ارسال رسانه / send media'));
    }

    // Resolve each author item into a TgInputMedia (ref vs bytes).
    const resolved: TgInputMedia[] = [];
    for (const m of params.media) {
      try {
        resolved.push(await resolveMedia(ctx, m));
      } catch (err) {
        return fail(`tg.sendMedia: ${(err as Error).message}`);
      }
    }

    const opts: Parameters<NonNullable<typeof ctx.tg.sendMedia>>[0] = {
      chat_id: chatId,
      media: resolved,
    };
    if (params.caption !== undefined) opts.caption = params.caption;
    if (params.parse_mode) opts.parse_mode = params.parse_mode;
    if (params.keyboard) opts.reply_markup = keyboardToMarkup(params.keyboard);
    if (params.options?.protect_content) opts.protect_content = true;
    if (params.options?.reply_to !== undefined) opts.reply_to_message_id = params.options.reply_to;
    if (params.options?.silent) opts.disable_notification = true;

    let messageIds: number[];
    try {
      ({ messageIds } = await ctx.tg.sendMedia(opts));
    } catch (err) {
      return fail(`tg.sendMedia: send failed — ${(err as Error).message}`);
    }

    const inputs: FlowItem[] = items.length > 0 ? items : [{ json: {} }];
    const outputs: FlowItem[] = inputs.map((it) => ({
      ...it,
      json: { ...it.json, sent_message_ids: messageIds, sent_message_id: messageIds[0] ?? null },
    }));
    return out({ main: outputs });
  },
};

/** Turn an author media item into a TgInputMedia (resolving file/base64 to bytes). */
async function resolveMedia(
  ctx: Parameters<NonNullable<NodeDef<TgSendMediaParams>['execute']>>[0],
  m: MediaItem,
): Promise<TgInputMedia> {
  const base: TgInputMedia = { kind: m.kind };
  if (m.caption !== undefined) base.caption = m.caption;
  if (m.filename !== undefined) base.filename = m.filename;
  if (m.mime !== undefined) base.mime = m.mime;

  switch (m.source) {
    case 'url':
    case 'file_id':
      return { ...base, ref: m.value };
    case 'base64': {
      let bytes: Uint8Array;
      try {
        bytes = decodeBase64(m.value);
      } catch {
        throw new Error('base64 media value is not valid base64');
      }
      if (bytes.length === 0) throw new Error('base64 media value decoded to 0 bytes');
      return { ...base, bytes };
    }
    case 'file': {
      if (!ctx.files) {
        throw new Error('source "file" requires a file store (none wired on this instance)');
      }
      const { bytes, mime } = await ctx.files.read(m.value);
      return { ...base, bytes, ...(base.mime === undefined && mime ? { mime } : {}) };
    }
  }
}
