/**
 * Centralized outbound sender (ARCHITECTURE §9, PLAN P1-T5).
 *
 * Every message CTB sends to Telegram goes through ONE TgSender per bot:
 *  - token-bucket rate limiting (Telegram: ~30 msg/s per bot globally)
 *  - 429 handling: respect `retry_after`, bounded retries
 *  - parse-mode safety: a 400 "can't parse entities" retries once without
 *    parse_mode instead of failing the whole flow
 *  - text splitting: messages over 4096 chars are split (newline-aware)
 *
 * Transport is injected (`CallApi`) so unit tests run without any network —
 * in production it is bound to grammY's `bot.api.raw`.
 */

import { InputFile } from 'grammy';
import type { TgInputMedia } from '@ctb/shared';

export const TG_TEXT_LIMIT = 4096;

/** The transport: grammY `api.raw`-shaped — method name + flat payload. */
export type CallApi = (method: string, payload: Record<string, unknown>) => Promise<unknown>;

/** Bot-API send-method per media kind (single-item send). */
const SINGLE_METHOD: Record<TgInputMedia['kind'], string> = {
  photo: 'sendPhoto',
  video: 'sendVideo',
  document: 'sendDocument',
  audio: 'sendAudio',
};
/** The payload key the file rides on per kind. */
const FILE_FIELD: Record<TgInputMedia['kind'], string> = {
  photo: 'photo',
  video: 'video',
  document: 'document',
  audio: 'audio',
};

export interface SenderOptions {
  /** Sustained rate (tokens/second). Telegram global bot limit ≈ 30/s. */
  ratePerSec?: number;
  /** Bucket capacity (burst size). */
  burst?: number;
  /** Max retries on 429 before giving up. */
  maxRetries?: number;
  /** Injectable clock + sleep for deterministic tests. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** Duck-typed view of grammY's GrammyError (no instanceof — tests use plain objects). */
interface TgApiErrorLike {
  error_code?: number;
  description?: string;
  parameters?: { retry_after?: number };
}

function asApiError(err: unknown): TgApiErrorLike | null {
  if (typeof err === 'object' && err !== null && 'error_code' in err) {
    return err as TgApiErrorLike;
  }
  return null;
}

function isParseEntityError(e: TgApiErrorLike): boolean {
  return e.error_code === 400 && /parse entities/i.test(e.description ?? '');
}

/**
 * Split text into ≤ limit chunks, preferring newline boundaries, then spaces,
 * then hard cuts. Never returns empty chunks.
 */
export function splitText(text: string, limit = TG_TEXT_LIMIT): string[] {
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    const window = rest.slice(0, limit);
    let cut = window.lastIndexOf('\n');
    if (cut < limit * 0.5) cut = window.lastIndexOf(' ');
    if (cut < limit * 0.5) cut = limit; // no good boundary → hard cut
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^[\n ]/, '');
  }
  if (rest.length > 0) chunks.push(rest);
  return chunks;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export class TgSender {
  private readonly callApi: CallApi;
  private readonly ratePerSec: number;
  private readonly burst: number;
  private readonly maxRetries: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  private tokens: number;
  private lastRefill: number;
  /** Serializes token acquisition so concurrent sends queue fairly (FIFO). */
  private queue: Promise<void> = Promise.resolve();

  constructor(callApi: CallApi, opts: SenderOptions = {}) {
    this.callApi = callApi;
    this.ratePerSec = opts.ratePerSec ?? 25;
    this.burst = opts.burst ?? 5;
    this.maxRetries = opts.maxRetries ?? 3;
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? defaultSleep;
    this.tokens = this.burst;
    this.lastRefill = this.now();
  }

  private refill(): void {
    const t = this.now();
    const elapsed = (t - this.lastRefill) / 1000;
    if (elapsed > 0) {
      this.tokens = Math.min(this.burst, this.tokens + elapsed * this.ratePerSec);
      this.lastRefill = t;
    }
  }

  /** Take one token, waiting if the bucket is empty. FIFO via promise chain. */
  private acquire(): Promise<void> {
    const turn = this.queue.then(async () => {
      this.refill();
      if (this.tokens < 1) {
        const deficitMs = ((1 - this.tokens) / this.ratePerSec) * 1000;
        await this.sleep(Math.ceil(deficitMs));
        this.refill();
      }
      this.tokens = Math.max(0, this.tokens - 1);
    });
    // Keep the chain alive even if a caller's call later rejects.
    this.queue = turn.catch(() => undefined);
    return turn;
  }

  /**
   * Rate-limited, retrying raw API call. All higher-level helpers route here.
   */
  async call<T = unknown>(method: string, payload: Record<string, unknown>): Promise<T> {
    let attempt = 0;
    let body = payload;
    for (;;) {
      await this.acquire();
      try {
        return (await this.callApi(method, body)) as T;
      } catch (err) {
        const apiErr = asApiError(err);
        if (apiErr && apiErr.error_code === 429 && attempt < this.maxRetries) {
          attempt += 1;
          const retryAfterSec = apiErr.parameters?.retry_after ?? 1;
          await this.sleep(retryAfterSec * 1000);
          continue;
        }
        // Parse-mode safety: drop parse_mode once and retry (does not count
        // against the 429 retry budget — it is a different failure class).
        if (apiErr && isParseEntityError(apiErr) && 'parse_mode' in body) {
          const { parse_mode: _dropped, ...rest } = body;
          body = rest;
          continue;
        }
        throw err;
      }
    }
  }

  /**
   * Send a text message; auto-splits >4096 chars (keyboard goes on the LAST
   * chunk so buttons land under the final message). Returns the last message id.
   */
  async sendMessage(opts: {
    chat_id: number | string;
    text: string;
    parse_mode?: 'HTML' | 'MarkdownV2';
    reply_markup?: unknown;
    [key: string]: unknown;
  }): Promise<{ messageId: number }> {
    const { text, reply_markup, ...rest } = opts;
    const chunks = splitText(text);
    let last: { message_id: number } | undefined;
    for (let i = 0; i < chunks.length; i++) {
      const isLast = i === chunks.length - 1;
      last = await this.call<{ message_id: number }>('sendMessage', {
        ...rest,
        text: chunks[i],
        ...(isLast && reply_markup !== undefined ? { reply_markup } : {}),
      });
    }
    // splitText never returns [], so last is always set.
    return { messageId: (last as { message_id: number }).message_id };
  }

  /**
   * Send one media message OR an album (media group) of 2–10 photos/videos
   * (tg.sendMedia, PA-T1). A single item routes to sendPhoto/Video/Document/
   * Audio (keyboard + caption allowed); 2+ items route to sendMediaGroup (no
   * keyboard — Telegram forbids it on a group). Each item's bytes become a
   * grammY InputFile upload; a `ref` (URL/file_id) is passed through as-is.
   * Returns the id of every created message (one per item for an album).
   */
  async sendMedia(opts: {
    chat_id: number | string;
    media: TgInputMedia[];
    caption?: string;
    parse_mode?: string;
    reply_markup?: unknown;
    protect_content?: boolean;
    reply_to_message_id?: number;
    disable_notification?: boolean;
  }): Promise<{ messageIds: number[] }> {
    const { chat_id, media, caption, parse_mode, reply_markup, ...rest } = opts;
    if (media.length === 0) throw new Error('sendMedia: no media items');

    const toFile = (m: TgInputMedia): InputFile | string => {
      if (m.bytes !== undefined) {
        return new InputFile(m.bytes, m.filename ?? `upload.${defaultExt(m)}`);
      }
      if (m.ref !== undefined) return m.ref;
      throw new Error('sendMedia: media item has neither bytes nor ref');
    };

    // ── Single item → sendPhoto/sendVideo/sendDocument/sendAudio ──────────────
    if (media.length === 1) {
      const m = media[0]!;
      const payload: Record<string, unknown> = {
        chat_id,
        [FILE_FIELD[m.kind]]: toFile(m),
        ...rest,
      };
      const cap = m.caption ?? caption;
      if (cap !== undefined) payload.caption = cap;
      if (parse_mode !== undefined) payload.parse_mode = parse_mode;
      if (reply_markup !== undefined) payload.reply_markup = reply_markup;
      const res = await this.call<{ message_id: number }>(SINGLE_METHOD[m.kind], payload);
      return { messageIds: [res.message_id] };
    }

    // ── Album → sendMediaGroup (photos/videos only; caption on first item) ────
    const inputMedia = media.map((m, i) => {
      const entry: Record<string, unknown> = { type: m.kind, media: toFile(m) };
      const cap = m.caption ?? (i === 0 ? caption : undefined);
      if (cap !== undefined) entry.caption = cap;
      if (cap !== undefined && parse_mode !== undefined) entry.parse_mode = parse_mode;
      return entry;
    });
    const res = await this.call<{ message_id: number }[]>('sendMediaGroup', {
      chat_id,
      media: inputMedia,
      ...rest,
    });
    return { messageIds: res.map((r) => r.message_id) };
  }
}

/** A best-effort default upload extension per media kind / mime. */
function defaultExt(m: TgInputMedia): string {
  if (m.mime) {
    const sub = m.mime.split('/')[1];
    if (sub) return sub.replace(/[^a-z0-9]/gi, '') || fallbackExt(m.kind);
  }
  return fallbackExt(m.kind);
}
function fallbackExt(kind: TgInputMedia['kind']): string {
  switch (kind) {
    case 'photo':
      return 'jpg';
    case 'video':
      return 'mp4';
    case 'audio':
      return 'mp3';
    default:
      return 'bin';
  }
}
