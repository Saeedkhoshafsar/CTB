/**
 * Pure matching/validation helpers for the update router (P1-T6).
 * Separated from router.ts so they unit-test without any store/executor.
 */
import type { FlowItem, WaitSpec } from '@ctb/shared';
import type { TgEvent } from '../telegram/normalize';

// ── wait matching ────────────────────────────────────────────────────────────

/** Callback data → output port ("btn:<key>" convention, flow.ts PortName). */
export function matchCallbackKey(
  wait: Extract<WaitSpec, { kind: 'callback' }>,
  data: string,
): string | null {
  const key = wait.keys.find((k) => k === data || `btn:${k}` === data || k === `btn:${data}`);
  if (key === undefined) return null;
  return key.startsWith('btn:') ? key : `btn:${key}`;
}

export type ReplyVerdict =
  | { outcome: 'ok'; value: unknown }
  | { outcome: 'invalid' }
  | { outcome: 'no_match' };

/**
 * Does this event satisfy the reply WaitSpec?
 *  - ok       → resume via "reply"
 *  - invalid  → wrong type or failed validation (re-prompt / "invalid" port)
 *  - no_match → event is irrelevant to this wait (falls through)
 */
export function validateReply(
  wait: Extract<WaitSpec, { kind: 'reply' }>,
  event: TgEvent,
): ReplyVerdict {
  const v = wait.validation;
  switch (wait.expect) {
    case 'any':
      return { outcome: 'ok', value: extractValue(event) };
    case 'text': {
      if (event.kind !== 'text') return { outcome: 'invalid' };
      const text = event.text;
      if (v?.regex !== undefined && !safeRegexTest(v.regex, text)) return { outcome: 'invalid' };
      if (v?.min !== undefined && text.length < v.min) return { outcome: 'invalid' };
      if (v?.max !== undefined && text.length > v.max) return { outcome: 'invalid' };
      return { outcome: 'ok', value: text };
    }
    case 'number': {
      if (event.kind !== 'text') return { outcome: 'invalid' };
      const normalized = event.text.trim().replace(/[٠-٩۰-۹]/g, faDigitToEn);
      const num = normalized === '' ? NaN : Number(normalized);
      if (!Number.isFinite(num)) return { outcome: 'invalid' };
      if (v?.min !== undefined && num < v.min) return { outcome: 'invalid' };
      if (v?.max !== undefined && num > v.max) return { outcome: 'invalid' };
      return { outcome: 'ok', value: num };
    }
    case 'photo':
      return event.kind === 'photo' ? { outcome: 'ok', value: event.fileId } : { outcome: 'invalid' };
    case 'document':
      return event.kind === 'document'
        ? { outcome: 'ok', value: event.fileId }
        : { outcome: 'invalid' };
    case 'contact':
      return event.kind === 'contact'
        ? { outcome: 'ok', value: event.contact }
        : { outcome: 'invalid' };
    case 'location':
      return event.kind === 'location'
        ? { outcome: 'ok', value: event.location }
        : { outcome: 'invalid' };
  }
}

function extractValue(event: TgEvent): unknown {
  switch (event.kind) {
    case 'text':
      return event.text;
    case 'photo':
    case 'document':
      return event.fileId;
    case 'contact':
      return event.contact;
    case 'location':
      return event.location;
    default:
      return null;
  }
}

/** Arabic-Indic + Persian digits → ASCII so `expect: number` is fa-friendly. */
function faDigitToEn(d: string): string {
  const fa = '۰۱۲۳۴۵۶۷۸۹';
  const ar = '٠١٢٣٤٥٦٧٨٩';
  const i = fa.indexOf(d);
  if (i >= 0) return String(i);
  const j = ar.indexOf(d);
  return j >= 0 ? String(j) : d;
}

function safeRegexTest(pattern: string, text: string): boolean {
  try {
    return new RegExp(pattern, 'u').test(text);
  } catch {
    return false; // bad regex in a flow must not crash the router
  }
}

// ── trigger matching ─────────────────────────────────────────────────────────

export interface TriggerParams {
  event?: string;
  command?: string;
  pattern?: string;
  patternType?: 'exact' | 'contains' | 'regex';
  button_key?: string;
}

export function triggerMatches(params: TriggerParams, event: TgEvent): boolean {
  switch (params.event) {
    case 'command':
      return event.kind === 'command' && event.command === normalizeCommand(params.command);
    case 'button_click':
      return event.kind === 'callback' && params.button_key !== undefined
        ? event.data === params.button_key || event.data === `btn:${params.button_key}`
        : false;
    case 'text': {
      if (event.kind !== 'text') return false;
      if (params.pattern === undefined) return true;
      switch (params.patternType ?? 'exact') {
        case 'exact':
          return event.text === params.pattern;
        case 'contains':
          return event.text.includes(params.pattern);
        case 'regex':
          return safeRegexTest(params.pattern, event.text);
      }
      return false;
    }
    case 'photo':
    case 'document':
    case 'contact':
    case 'location':
    case 'chat_join':
      return event.kind === params.event;
    case 'any_message':
      return event.kind !== 'callback';
    default:
      return false;
  }
}

function normalizeCommand(cmd: string | undefined): string {
  return (cmd ?? '').replace(/^\//, '').toLowerCase();
}

// ── item builders (what the resumed/started node receives) ──────────────────

/** Telegram Trigger emission per NODES.md. */
export function triggerItem(event: TgEvent): FlowItem {
  const json: Record<string, unknown> = {
    user: { ...event.user },
    chat: { ...event.chat },
    message_id: event.messageId,
    raw: event.raw as unknown as Record<string, unknown>,
  };
  if (event.kind === 'text' || event.kind === 'command') json['text'] = event.text;
  if (event.kind === 'command') {
    json['command'] = event.command;
    json['payload'] = event.payload;
  }
  return { json };
}

/** Wait-for-Reply emission per NODES.md: `{ json: { reply: {...} } }`. */
export function replyItem(event: TgEvent, value: unknown): FlowItem {
  const reply: Record<string, unknown> = { value };
  if (event.kind === 'text') reply['text'] = event.text;
  if (event.kind === 'photo' || event.kind === 'document') reply['file_id'] = event.fileId;
  if (event.kind === 'contact') reply['contact'] = event.contact;
  if (event.kind === 'location') reply['location'] = event.location;
  return {
    json: {
      reply,
      user: { ...event.user },
      chat: { ...event.chat },
      raw: event.raw as unknown as Record<string, unknown>,
    },
  };
}

/**
 * Menu resume emission per NODES.md: `{ json: { clicked: {...} } }`.
 * `meta` is the per-key button info the menu node persisted in its WaitSpec
 * (label/value — the node never re-executes on resume, DL #13); message_id
 * lets a downstream edit_in_place menu edit THIS message.
 */
export function callbackItem(
  event: Extract<TgEvent, { kind: 'callback' }>,
  meta?: { label?: string | undefined; value?: string | undefined },
): FlowItem {
  const key = event.data.startsWith('btn:') ? event.data.slice(4) : event.data;
  const clicked: Record<string, unknown> = { key, data: event.data, message_id: event.messageId };
  if (meta?.label !== undefined) clicked['label'] = meta.label;
  if (meta?.value !== undefined) clicked['value'] = meta.value;
  return {
    json: {
      clicked,
      user: { ...event.user },
      chat: { ...event.chat },
      callback_query_id: event.callbackQueryId,
    },
  };
}
