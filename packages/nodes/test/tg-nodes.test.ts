/**
 * P1-T7 contract tests — Telegram nodes (tg.trigger, tg.sendMessage,
 * tg.waitForReply). ≥3 per node: happy / edge / error, per PLAN acceptance.
 */
import { describe, expect, it } from 'vitest';
import { tgSendMessage, tgTrigger, tgWaitForReply } from '@ctb/nodes';
import { item, makeCtx, params } from './node-harness';

describe('tg.trigger', () => {
  it('passes the router-built trigger item through "main" (happy)', async () => {
    const ctx = makeCtx();
    const p = params(tgTrigger, { event: 'command', command: '/start' });
    const items = [item({ text: '/start', user: { id: 1 }, chat: { id: 777 } })];
    const res = await tgTrigger.execute(ctx, p, items);
    expect(res).toEqual({ kind: 'items', outputs: { main: items } });
  });

  it('accepts every documented event kind (edge: schema breadth)', () => {
    for (const event of ['command', 'text', 'button_click', 'any_message', 'photo', 'document', 'contact', 'location', 'chat_join']) {
      expect(() => params(tgTrigger, { event })).not.toThrow();
    }
  });

  it('rejects unknown event kinds (error)', () => {
    expect(() => params(tgTrigger, { event: 'voice' })).toThrow(/invalid params/);
  });
});

describe('tg.sendMessage', () => {
  it('sends text per item and appends sent_message_id (happy)', async () => {
    const ctx = makeCtx();
    const p = params(tgSendMessage, { type: 'text', text: 'سلام علی!' });
    const res = await tgSendMessage.execute(ctx, p, [item({ name: 'علی' }), item({ name: 'sara' })]);
    expect(ctx.sent).toHaveLength(2);
    expect(ctx.sent[0]!.opts).toMatchObject({ chat_id: 777, type: 'text', text: 'سلام علی!' });
    if (res.kind !== 'items') throw new Error('expected items');
    expect(res.outputs.main!.map((i) => i.json.sent_message_id)).toEqual([100, 101]);
    expect(res.outputs.main![0]!.json.name).toBe('علی'); // passthrough preserved
  });

  it('builds inline keyboard with btn:<key> callback data + options (edge)', async () => {
    const ctx = makeCtx();
    const p = params(tgSendMessage, {
      type: 'text',
      text: 'menu',
      keyboard: { kind: 'inline', rows: [[{ text: 'خرید', kind: 'callback', value: 'buy' }, { text: 'site', kind: 'url', value: 'https://x.ir' }]] },
      options: { silent: true, disable_preview: true },
    });
    await tgSendMessage.execute(ctx, p, [item({})]);
    expect(ctx.sent[0]!.opts.reply_markup).toEqual({
      inline_keyboard: [[{ text: 'خرید', callback_data: 'btn:buy' }, { text: 'site', url: 'https://x.ir' }]],
    });
    expect(ctx.sent[0]!.opts.disable_notification).toBe(true);
    expect(ctx.sent[0]!.opts.disable_web_page_preview).toBe(true);
  });

  it('media types require media; photo payload carries caption (edge)', async () => {
    expect(() => params(tgSendMessage, { type: 'photo' })).toThrow(/media/);
    const ctx = makeCtx();
    const p = params(tgSendMessage, { type: 'photo', media: 'AgACfileid', caption: 'یک عکس' });
    await tgSendMessage.execute(ctx, p, [item({})]);
    expect(ctx.sent[0]!.opts).toMatchObject({ type: 'photo', media: 'AgACfileid', caption: 'یک عکس' });
  });

  it('explicit chat param overrides execution chat; empty input still sends once (edge)', async () => {
    const ctx = makeCtx();
    const p = params(tgSendMessage, { chat: '-100123', type: 'text', text: 'hi' });
    const res = await tgSendMessage.execute(ctx, p, []);
    expect(ctx.sent[0]!.opts.chat_id).toBe(-100123);
    if (res.kind !== 'items') throw new Error('expected items');
    expect(res.outputs.main).toHaveLength(1);
  });

  it('fails without chat context and without sender (error)', async () => {
    const noChat = makeCtx({ chatId: null });
    const p = params(tgSendMessage, { type: 'text', text: 'hi' });
    const r1 = await tgSendMessage.execute(noChat, p, [item({})]);
    expect(r1).toMatchObject({ kind: 'error', message: expect.stringContaining('no chat') });

    const noTg = makeCtx({ tg: null });
    const r2 = await tgSendMessage.execute(noTg, p, [item({})]);
    expect(r2).toMatchObject({ kind: 'error', message: expect.stringContaining('sender') });

    const badChat = makeCtx();
    const r3 = await tgSendMessage.execute(badChat, params(tgSendMessage, { chat: 'abc', type: 'text', text: 'x' }), [item({})]);
    expect(r3).toMatchObject({ kind: 'error', message: expect.stringContaining('invalid chat') });
  });
});

describe('tg.waitForReply', () => {
  it('sends the prompt then WAITs with a full reply WaitSpec (happy)', async () => {
    const ctx = makeCtx();
    const p = params(tgWaitForReply, {
      prompt: { text: 'چند سالته؟' },
      expect: 'number',
      validation: { min: 1, max: 120 },
      invalid_message: 'عدد بین ۱ تا ۱۲۰',
      max_retries: 2,
      save_to: 'age',
      timeout: '15m',
    });
    const res = await tgWaitForReply.execute(ctx, p, [item({})]);
    expect(ctx.sent[0]!.opts).toMatchObject({ chat_id: 777, text: 'چند سالته؟' });
    expect(res).toEqual({
      kind: 'wait',
      wait: {
        kind: 'reply',
        nodeId: 'UNSET', // executor stamps the real id
        expect: 'number',
        validation: { min: 1, max: 120 },
        invalidMessage: 'عدد بین ۱ تا ۱۲۰',
        saveTo: 'age',
        retriesLeft: 2,
        timeoutAt: '2026-06-11T10:15:00.000Z', // ctx.now + 15m
      },
    });
  });

  it('string prompt + defaults: expect=text, no retries, no timeout (edge)', async () => {
    const ctx = makeCtx();
    const res = await tgWaitForReply.execute(ctx, params(tgWaitForReply, { prompt: 'اسمت چیه؟' }), [item({})]);
    expect(ctx.sent).toHaveLength(1);
    expect(res).toMatchObject({
      kind: 'wait',
      wait: { kind: 'reply', expect: 'text', retriesLeft: 0, timeoutAt: null },
    });
    const w = (res as Extract<typeof res, { kind: 'wait' }>).wait as Record<string, unknown>;
    expect('saveTo' in w).toBe(false);
    expect('validation' in w).toBe(false);
  });

  it('promptless wait sends nothing and still pauses (edge)', async () => {
    const ctx = makeCtx();
    const res = await tgWaitForReply.execute(ctx, params(tgWaitForReply, { expect: 'photo' }), [item({})]);
    expect(ctx.sent).toHaveLength(0);
    expect(res).toMatchObject({ kind: 'wait', wait: { expect: 'photo' } });
  });

  it('errors: no chat context / prompt without sender / bad timeout & save_to rejected (error)', async () => {
    const noChat = makeCtx({ chatId: null });
    const r1 = await tgWaitForReply.execute(noChat, params(tgWaitForReply, { expect: 'text' }), []);
    expect(r1).toMatchObject({ kind: 'error', message: expect.stringContaining('chat context') });

    const noTg = makeCtx({ tg: null });
    const r2 = await tgWaitForReply.execute(noTg, params(tgWaitForReply, { prompt: 'hi', expect: 'text' }), []);
    expect(r2).toMatchObject({ kind: 'error', message: expect.stringContaining('sender') });

    expect(() => params(tgWaitForReply, { expect: 'text', timeout: 'tomorrow' })).toThrow(/duration/);
    expect(() => params(tgWaitForReply, { expect: 'text', save_to: '۲bad-name' })).toThrow(/invalid params/);
  });
});
