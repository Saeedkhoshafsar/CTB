/**
 * P1-T6 — pure matcher unit tests: reply validation (expect types, regex,
 * min/max, fa digits), callback key matching, trigger priority predicates.
 */
import type { WaitSpec } from '@ctb/shared';
import type { Update } from 'grammy/types';
import { describe, expect, it } from 'vitest';
import { matchCallbackKey, triggerMatches, validateReply } from '../src/engine/match';
import { normalizeUpdate, type TgEvent } from '../src/telegram/normalize';

function textEv(text: string): TgEvent {
  const e = normalizeUpdate('b1', {
    update_id: 1,
    message: {
      message_id: 1,
      date: 0,
      from: { id: 1, is_bot: false, first_name: 'x' },
      chat: { id: 1, type: 'private', first_name: 'x' },
      text,
    },
  } as unknown as Update);
  if (!e) throw new Error('bad fixture');
  return e;
}

function photoEv(): TgEvent {
  const e = normalizeUpdate('b1', {
    update_id: 1,
    message: {
      message_id: 1,
      date: 0,
      from: { id: 1, is_bot: false, first_name: 'x' },
      chat: { id: 1, type: 'private', first_name: 'x' },
      photo: [{ file_id: 'F', file_unique_id: 'U', width: 1, height: 1 }],
    },
  } as unknown as Update);
  if (!e) throw new Error('bad fixture');
  return e;
}

function callbackEv(data: string): Extract<TgEvent, { kind: 'callback' }> {
  const e = normalizeUpdate('b1', {
    update_id: 1,
    callback_query: {
      id: 'q1',
      from: { id: 1, is_bot: false, first_name: 'x' },
      chat_instance: 'ci',
      data,
      message: { message_id: 5, date: 0, chat: { id: 1, type: 'private', first_name: 'x' } },
    },
  } as unknown as Update);
  if (!e || e.kind !== 'callback') throw new Error('bad fixture');
  return e;
}

const replyWait = (
  over: Partial<Extract<WaitSpec, { kind: 'reply' }>> = {},
): Extract<WaitSpec, { kind: 'reply' }> => ({
  kind: 'reply',
  nodeId: 'n1',
  expect: 'text',
  retriesLeft: 0,
  timeoutAt: null,
  ...over,
});

describe('validateReply', () => {
  it('expect=text: plain text ok; photo invalid', () => {
    expect(validateReply(replyWait(), textEv('سلام'))).toEqual({ outcome: 'ok', value: 'سلام' });
    expect(validateReply(replyWait(), photoEv())).toEqual({ outcome: 'invalid' });
  });

  it('expect=text with regex + length bounds', () => {
    const w = replyWait({ validation: { regex: '^[a-z]+$', min: 2, max: 4 } });
    expect(validateReply(w, textEv('abc'))).toEqual({ outcome: 'ok', value: 'abc' });
    expect(validateReply(w, textEv('ABC'))).toEqual({ outcome: 'invalid' }); // regex
    expect(validateReply(w, textEv('a'))).toEqual({ outcome: 'invalid' }); // min
    expect(validateReply(w, textEv('abcde'))).toEqual({ outcome: 'invalid' }); // max
  });

  it('bad regex in flow → invalid, never throws', () => {
    const w = replyWait({ validation: { regex: '(' } });
    expect(validateReply(w, textEv('x'))).toEqual({ outcome: 'invalid' });
  });

  it('expect=number: parses fa/ar digits, enforces range', () => {
    const w = replyWait({ expect: 'number', validation: { min: 1, max: 120 } });
    expect(validateReply(w, textEv('۳۵'))).toEqual({ outcome: 'ok', value: 35 });
    expect(validateReply(w, textEv('٤٢'))).toEqual({ outcome: 'ok', value: 42 });
    expect(validateReply(w, textEv('35'))).toEqual({ outcome: 'ok', value: 35 });
    expect(validateReply(w, textEv('صد و بیست'))).toEqual({ outcome: 'invalid' });
    expect(validateReply(w, textEv('0'))).toEqual({ outcome: 'invalid' });
    expect(validateReply(w, textEv('999'))).toEqual({ outcome: 'invalid' });
    expect(validateReply(w, textEv(''))).toEqual({ outcome: 'invalid' });
  });

  it('expect=photo / any', () => {
    expect(validateReply(replyWait({ expect: 'photo' }), photoEv())).toEqual({
      outcome: 'ok',
      value: 'F',
    });
    expect(validateReply(replyWait({ expect: 'photo' }), textEv('نه'))).toEqual({
      outcome: 'invalid',
    });
    expect(validateReply(replyWait({ expect: 'any' }), photoEv())).toEqual({
      outcome: 'ok',
      value: 'F',
    });
  });
});

describe('matchCallbackKey', () => {
  const wait: Extract<WaitSpec, { kind: 'callback' }> = {
    kind: 'callback',
    nodeId: 'menu1',
    keys: ['buy', 'btn:help'],
    timeoutAt: null,
  };

  it('matches bare key, prefixed data, and pre-prefixed keys → port form', () => {
    expect(matchCallbackKey(wait, 'buy')).toBe('btn:buy');
    expect(matchCallbackKey(wait, 'btn:buy')).toBe('btn:buy');
    expect(matchCallbackKey(wait, 'btn:help')).toBe('btn:help');
    expect(matchCallbackKey(wait, 'other')).toBeNull();
  });
});

describe('triggerMatches', () => {
  it('command: with/without leading slash, case-insensitive', () => {
    const ev = textEv('/Start go');
    expect(triggerMatches({ event: 'command', command: '/start' }, ev)).toBe(true);
    expect(triggerMatches({ event: 'command', command: 'start' }, ev)).toBe(true);
    expect(triggerMatches({ event: 'command', command: 'help' }, ev)).toBe(false);
    expect(triggerMatches({ event: 'command', command: 'start' }, textEv('سلام'))).toBe(false);
  });

  it('text patterns: exact / contains / regex', () => {
    const ev = textEv('سلام دنیا');
    expect(triggerMatches({ event: 'text', pattern: 'سلام دنیا' }, ev)).toBe(true);
    expect(triggerMatches({ event: 'text', pattern: 'دنیا', patternType: 'contains' }, ev)).toBe(true);
    expect(triggerMatches({ event: 'text', pattern: '^سلام', patternType: 'regex' }, ev)).toBe(true);
    expect(triggerMatches({ event: 'text', pattern: 'خداحافظ', patternType: 'contains' }, ev)).toBe(false);
    expect(triggerMatches({ event: 'text' }, ev)).toBe(true); // no pattern = any text
  });

  it('button_click matches callback data with/without btn: prefix', () => {
    expect(triggerMatches({ event: 'button_click', button_key: 'buy' }, callbackEv('buy'))).toBe(true);
    expect(triggerMatches({ event: 'button_click', button_key: 'buy' }, callbackEv('btn:buy'))).toBe(true);
    expect(triggerMatches({ event: 'button_click', button_key: 'buy' }, callbackEv('x'))).toBe(false);
    expect(triggerMatches({ event: 'button_click' }, callbackEv('buy'))).toBe(false); // key required
  });

  it('any_message matches messages but never callbacks; kind events match exactly', () => {
    expect(triggerMatches({ event: 'any_message' }, textEv('x'))).toBe(true);
    expect(triggerMatches({ event: 'any_message' }, photoEv())).toBe(true);
    expect(triggerMatches({ event: 'any_message' }, callbackEv('k'))).toBe(false);
    expect(triggerMatches({ event: 'photo' }, photoEv())).toBe(true);
    expect(triggerMatches({ event: 'photo' }, textEv('x'))).toBe(false);
    expect(triggerMatches({}, textEv('x'))).toBe(false); // no event configured
  });
});
