/**
 * Update normalization — raw Telegram Update → TgEvent (ARCHITECTURE §9).
 *
 * Nodes and the router NEVER parse raw updates; everything downstream consumes
 * this normalized, discriminated shape. The `raw` field keeps the original
 * update available for `$json.raw` per NODES.md (Telegram Trigger emits raw).
 *
 * TgEvent is transient (never stored), so it lives here as plain TS types —
 * invariant I5 applies to stored documents / API bodies / node params only.
 */
import type { Message, Update, User } from 'grammy/types';

export interface TgUser {
  id: number;
  firstName: string;
  lastName?: string;
  username?: string;
  lang?: string;
  isBot: boolean;
}

export interface TgChatRef {
  id: number;
  type: 'private' | 'group' | 'supergroup' | 'channel';
}

interface TgEventBase {
  botId: string;
  updateId: number;
  user: TgUser;
  chat: TgChatRef;
  /** Message id of the triggering message (callback → the message the button is on). */
  messageId?: number;
  /** The raw Telegram update, untouched. */
  raw: Update;
}

/**
 * TgEvent — the normalized envelope (kinds per PLAN P1-T5:
 * command/text/photo/document/contact/location/callback, plus chat_join
 * from the Telegram Trigger spec in NODES.md).
 */
export type TgEvent = TgEventBase &
  (
    | { kind: 'command'; command: string; payload: string; text: string }
    | { kind: 'text'; text: string }
    | { kind: 'photo'; fileId: string; fileUniqueId: string; caption?: string }
    | {
        kind: 'document';
        fileId: string;
        fileUniqueId: string;
        fileName?: string;
        mime?: string;
        size?: number;
        caption?: string;
      }
    | {
        kind: 'contact';
        contact: { phoneNumber: string; firstName: string; lastName?: string; userId?: number };
      }
    | { kind: 'location'; location: { latitude: number; longitude: number } }
    | { kind: 'callback'; callbackQueryId: string; data: string }
    | { kind: 'chat_join'; joined: TgUser[] }
  );

export type TgEventKind = TgEvent['kind'];

function normUser(u: User): TgUser {
  return {
    id: u.id,
    firstName: u.first_name,
    ...(u.last_name !== undefined ? { lastName: u.last_name } : {}),
    ...(u.username !== undefined ? { username: u.username } : {}),
    ...(u.language_code !== undefined ? { lang: u.language_code } : {}),
    isBot: u.is_bot,
  };
}

function normChat(c: Message['chat']): TgChatRef {
  return { id: c.id, type: c.type };
}

/** `/start abc` → { command: 'start', payload: 'abc' }. Handles `/cmd@BotName`. */
const COMMAND_RE = /^\/([A-Za-z0-9_]+)(?:@(\S+))?(?:\s+([\s\S]*))?$/;

export function parseCommand(text: string): { command: string; payload: string } | null {
  const m = COMMAND_RE.exec(text);
  if (!m?.[1]) return null;
  return { command: m[1].toLowerCase(), payload: m[3]?.trim() ?? '' };
}

/**
 * Normalize one raw update for one bot. Returns null for update types CTB
 * does not (yet) handle — the gateway logs and drops those.
 */
export function normalizeUpdate(botId: string, update: Update): TgEvent | null {
  // ---- callback queries (inline button clicks) ----------------------------
  if (update.callback_query) {
    const cb = update.callback_query;
    const msg = cb.message;
    if (!msg) return null; // inline-mode callbacks without message: unsupported in v1
    return {
      kind: 'callback',
      botId,
      updateId: update.update_id,
      user: normUser(cb.from),
      chat: normChat(msg.chat),
      messageId: msg.message_id,
      callbackQueryId: cb.id,
      data: cb.data ?? '',
      raw: update,
    };
  }

  // ---- messages ------------------------------------------------------------
  const msg = update.message;
  if (!msg || !msg.from) return null; // channel posts / edits / service-only: v1 drops

  const base: TgEventBase = {
    botId,
    updateId: update.update_id,
    user: normUser(msg.from),
    chat: normChat(msg.chat),
    messageId: msg.message_id,
    raw: update,
  };

  if (msg.new_chat_members && msg.new_chat_members.length > 0) {
    return { kind: 'chat_join', ...base, joined: msg.new_chat_members.map(normUser) };
  }

  if (typeof msg.text === 'string') {
    const cmd = parseCommand(msg.text);
    if (cmd) {
      return { kind: 'command', ...base, command: cmd.command, payload: cmd.payload, text: msg.text };
    }
    return { kind: 'text', ...base, text: msg.text };
  }

  if (msg.photo && msg.photo.length > 0) {
    // Telegram sends multiple sizes; the last entry is the largest.
    const largest = msg.photo[msg.photo.length - 1]!;
    return {
      kind: 'photo',
      ...base,
      fileId: largest.file_id,
      fileUniqueId: largest.file_unique_id,
      ...(msg.caption !== undefined ? { caption: msg.caption } : {}),
    };
  }

  if (msg.document) {
    const d = msg.document;
    return {
      kind: 'document',
      ...base,
      fileId: d.file_id,
      fileUniqueId: d.file_unique_id,
      ...(d.file_name !== undefined ? { fileName: d.file_name } : {}),
      ...(d.mime_type !== undefined ? { mime: d.mime_type } : {}),
      ...(d.file_size !== undefined ? { size: d.file_size } : {}),
      ...(msg.caption !== undefined ? { caption: msg.caption } : {}),
    };
  }

  if (msg.contact) {
    const c = msg.contact;
    return {
      kind: 'contact',
      ...base,
      contact: {
        phoneNumber: c.phone_number,
        firstName: c.first_name,
        ...(c.last_name !== undefined ? { lastName: c.last_name } : {}),
        ...(c.user_id !== undefined ? { userId: c.user_id } : {}),
      },
    };
  }

  if (msg.location) {
    return {
      kind: 'location',
      ...base,
      location: { latitude: msg.location.latitude, longitude: msg.location.longitude },
    };
  }

  return null; // stickers, voice, video… → post-MVP kinds
}
