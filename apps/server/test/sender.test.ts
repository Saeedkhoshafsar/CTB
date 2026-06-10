/**
 * P1-T5 — TgSender unit tests: token bucket, 429 retry, parse-mode safety,
 * >4096 splitting. No network: transport is a recording fake.
 */
import { describe, expect, it } from 'vitest';
import { TG_TEXT_LIMIT, TgSender, splitText } from '../src/telegram/sender';

/** Fake clock + sleep that advances the clock instantly. */
function fakeTime(): { now: () => number; sleep: (ms: number) => Promise<void>; slept: number[] } {
  let t = 0;
  const slept: number[] = [];
  return {
    now: () => t,
    sleep: (ms: number) => {
      slept.push(ms);
      t += ms;
      return Promise.resolve();
    },
    slept,
  };
}

interface Call {
  method: string;
  payload: Record<string, unknown>;
}

function recordingApi(script?: (call: Call, n: number) => unknown) {
  const calls: Call[] = [];
  const callApi = (method: string, payload: Record<string, unknown>): Promise<unknown> => {
    const call = { method, payload };
    calls.push(call);
    const result = script ? script(call, calls.length) : { message_id: calls.length };
    if (result instanceof Error) return Promise.reject(result);
    return Promise.resolve(result ?? { message_id: calls.length });
  };
  return { calls, callApi };
}

function err429(retryAfter: number): Error {
  return Object.assign(new Error('429'), {
    error_code: 429,
    description: 'Too Many Requests',
    parameters: { retry_after: retryAfter },
  });
}

describe('splitText', () => {
  it('short text untouched', () => {
    expect(splitText('سلام')).toEqual(['سلام']);
  });

  it('splits at newline boundaries, no empty chunks, content preserved', () => {
    const line = 'x'.repeat(1000);
    const text = Array(5).fill(line).join('\n'); // 5004 chars
    const chunks = splitText(text);
    expect(chunks.length).toBe(2);
    expect(chunks.every((c) => c.length <= TG_TEXT_LIMIT)).toBe(true);
    expect(chunks.every((c) => c.length > 0)).toBe(true);
    expect(chunks.join('\n')).toBe(text); // newline cut → rejoinable
  });

  it('hard-cuts when there is no boundary', () => {
    const text = 'a'.repeat(TG_TEXT_LIMIT + 10);
    const chunks = splitText(text);
    expect(chunks).toEqual(['a'.repeat(TG_TEXT_LIMIT), 'a'.repeat(10)]);
  });
});

describe('TgSender', () => {
  it('sends a simple message through the transport', async () => {
    const { calls, callApi } = recordingApi(() => ({ message_id: 99 }));
    const time = fakeTime();
    const sender = new TgSender(callApi, { now: time.now, sleep: time.sleep });
    const res = await sender.sendMessage({ chat_id: 1, text: 'سلام' });
    expect(res).toEqual({ messageId: 99 });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: 'sendMessage', payload: { chat_id: 1, text: 'سلام' } });
  });

  it('retries on 429 honoring retry_after, then succeeds', async () => {
    const time = fakeTime();
    const { calls, callApi } = recordingApi((_c, n) => (n <= 2 ? err429(3) : { message_id: 5 }));
    const sender = new TgSender(callApi, { now: time.now, sleep: time.sleep });
    const res = await sender.sendMessage({ chat_id: 1, text: 'hi' });
    expect(res).toEqual({ messageId: 5 });
    expect(calls).toHaveLength(3);
    expect(time.slept).toContain(3000); // retry_after respected (seconds → ms)
  });

  it('gives up after maxRetries on persistent 429', async () => {
    const time = fakeTime();
    const { calls, callApi } = recordingApi(() => err429(1));
    const sender = new TgSender(callApi, { now: time.now, sleep: time.sleep, maxRetries: 2 });
    await expect(sender.sendMessage({ chat_id: 1, text: 'x' })).rejects.toMatchObject({
      error_code: 429,
    });
    expect(calls).toHaveLength(3); // initial + 2 retries
  });

  it('parse-entity 400 → retried once WITHOUT parse_mode', async () => {
    const time = fakeTime();
    const { calls, callApi } = recordingApi((call) => {
      if ('parse_mode' in call.payload) {
        return Object.assign(new Error('400'), {
          error_code: 400,
          description: "Bad Request: can't parse entities: unmatched '*'",
        });
      }
      return { message_id: 1 };
    });
    const sender = new TgSender(callApi, { now: time.now, sleep: time.sleep });
    const res = await sender.sendMessage({ chat_id: 1, text: '*broken', parse_mode: 'MarkdownV2' });
    expect(res).toEqual({ messageId: 1 });
    expect(calls).toHaveLength(2);
    expect(calls[1]!.payload).not.toHaveProperty('parse_mode');
  });

  it('non-429 errors propagate untouched', async () => {
    const time = fakeTime();
    const { callApi } = recordingApi(() =>
      Object.assign(new Error('403'), { error_code: 403, description: 'bot was blocked by the user' }),
    );
    const sender = new TgSender(callApi, { now: time.now, sleep: time.sleep });
    await expect(sender.call('sendMessage', { chat_id: 1, text: 'x' })).rejects.toMatchObject({
      error_code: 403,
    });
  });

  it('long text is split; keyboard rides only the LAST chunk', async () => {
    const time = fakeTime();
    const { calls, callApi } = recordingApi((_c, n) => ({ message_id: n }));
    const sender = new TgSender(callApi, { now: time.now, sleep: time.sleep });
    const text = 'پ'.repeat(TG_TEXT_LIMIT + 100);
    const kb = { inline_keyboard: [[{ text: 'ok', callback_data: 'k' }]] };
    const res = await sender.sendMessage({ chat_id: 1, text, reply_markup: kb });
    expect(calls).toHaveLength(2);
    expect(calls[0]!.payload).not.toHaveProperty('reply_markup');
    expect(calls[1]!.payload).toMatchObject({ reply_markup: kb });
    expect(res.messageId).toBe(2); // last chunk's id
  });

  it('token bucket throttles a burst beyond capacity', async () => {
    const time = fakeTime();
    const { calls, callApi } = recordingApi();
    const sender = new TgSender(callApi, {
      now: time.now,
      sleep: time.sleep,
      ratePerSec: 10,
      burst: 2,
    });
    await Promise.all(
      Array.from({ length: 5 }, (_, i) => sender.call('sendMessage', { chat_id: 1, text: String(i) })),
    );
    expect(calls).toHaveLength(5);
    // burst=2 free, the remaining 3 each wait ~100ms (1 token at 10/s)
    expect(time.slept.length).toBeGreaterThanOrEqual(3);
    expect(time.now()).toBeGreaterThanOrEqual(300);
  });

  it('FIFO ordering preserved under throttling', async () => {
    const time = fakeTime();
    const { calls, callApi } = recordingApi();
    const sender = new TgSender(callApi, { now: time.now, sleep: time.sleep, ratePerSec: 5, burst: 1 });
    await Promise.all([
      sender.call('sendMessage', { text: 'a' }),
      sender.call('sendMessage', { text: 'b' }),
      sender.call('sendMessage', { text: 'c' }),
    ]);
    expect(calls.map((c) => c.payload['text'])).toEqual(['a', 'b', 'c']);
  });
});
