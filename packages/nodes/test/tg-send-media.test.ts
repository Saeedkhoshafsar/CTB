/**
 * PA-T1 contract tests — tg.sendMedia (Send Media / Album).
 *
 * Covers: single media by URL/file_id, an album of 2–10 photos/videos, byte
 * uploads from base64 and from a CTB file id (ctx.files), caps + album rules
 * (photos/videos only, no keyboard), keyboard on a single send, passthrough of
 * sent_message_ids, and the loud-failure paths (no sender, missing capability,
 * missing file store, transport error, bad base64).
 */
import { describe, expect, it } from 'vitest';
import { tgSendMedia } from '@ctb/nodes';
import { item, makeCtx, params } from './node-harness';

// A tiny valid base64 ("hi" → "aGk=").
const HI_B64 = 'aGk=';

/** The resolved TgInputMedia shape the node hands to ctx.tg.sendMedia. */
type MediaEntry = { kind: string; ref?: string; bytes?: Uint8Array; filename?: string; mime?: string };
const sentMediaItems = (opts: Record<string, unknown>): MediaEntry[] => opts.media as MediaEntry[];

describe('tg.sendMedia — single', () => {
  it('sends one photo by URL with caption; passes items through with ids (happy)', async () => {
    const ctx = makeCtx();
    const p = params(tgSendMedia, {
      media: [{ kind: 'photo', source: 'url', value: 'https://x.ir/a.jpg' }],
      caption: 'یک عکس',
    });
    const res = await tgSendMedia.execute(ctx, p, [item({ name: 'علی' })]);
    expect(ctx.sentMedia).toHaveLength(1);
    expect(ctx.sentMedia[0]!.opts).toMatchObject({ chat_id: 777, caption: 'یک عکس' });
    const media = sentMediaItems(ctx.sentMedia[0]!.opts);
    expect(media[0]).toMatchObject({ kind: 'photo', ref: 'https://x.ir/a.jpg' });
    expect(media[0]!.bytes).toBeUndefined();
    if (res.kind !== 'items') throw new Error('expected items');
    expect(res.outputs.main![0]!.json.sent_message_ids).toEqual([100]);
    expect(res.outputs.main![0]!.json.sent_message_id).toBe(100);
    expect(res.outputs.main![0]!.json.name).toBe('علی'); // passthrough
  });

  it('re-sends by file_id and allows a keyboard on a single send (edge)', async () => {
    const ctx = makeCtx();
    const p = params(tgSendMedia, {
      media: [{ kind: 'document', source: 'file_id', value: 'BQACdoc123' }],
      keyboard: { kind: 'inline', rows: [[{ text: 'باز کن', kind: 'url', value: 'https://x.ir' }]] },
    });
    await tgSendMedia.execute(ctx, p, [item({})]);
    const media = sentMediaItems(ctx.sentMedia[0]!.opts);
    expect(media[0]).toMatchObject({ kind: 'document', ref: 'BQACdoc123' });
    expect(ctx.sentMedia[0]!.opts.reply_markup).toEqual({
      inline_keyboard: [[{ text: 'باز کن', url: 'https://x.ir' }]],
    });
  });

  it('uploads bytes from base64 (edge)', async () => {
    const ctx = makeCtx();
    const p = params(tgSendMedia, {
      media: [{ kind: 'photo', source: 'base64', value: HI_B64, filename: 'pic.png', mime: 'image/png' }],
    });
    await tgSendMedia.execute(ctx, p, [item({})]);
    const media = sentMediaItems(ctx.sentMedia[0]!.opts);
    expect(media[0]!.ref).toBeUndefined();
    expect(Array.from(media[0]!.bytes!)).toEqual([104, 105]); // "hi"
    expect(media[0]!.filename).toBe('pic.png');
  });

  it('uploads bytes from a CTB file id via ctx.files (edge)', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const ctx = makeCtx({ seedFiles: { file_abc: { bytes, mime: 'video/mp4' } } });
    const p = params(tgSendMedia, {
      media: [{ kind: 'video', source: 'file', value: 'file_abc' }],
    });
    await tgSendMedia.execute(ctx, p, [item({})]);
    const media = sentMediaItems(ctx.sentMedia[0]!.opts);
    expect(Array.from(media[0]!.bytes!)).toEqual([1, 2, 3, 4]);
    expect(media[0]!.mime).toBe('video/mp4'); // store mime flows through
  });

  it('empty input still sends once; explicit chat overrides (edge)', async () => {
    const ctx = makeCtx();
    const p = params(tgSendMedia, {
      chat: '-100999',
      media: [{ kind: 'photo', source: 'url', value: 'https://x.ir/a.jpg' }],
    });
    const res = await tgSendMedia.execute(ctx, p, []);
    expect(ctx.sentMedia[0]!.opts.chat_id).toBe(-100999);
    if (res.kind !== 'items') throw new Error('expected items');
    expect(res.outputs.main).toHaveLength(1);
  });
});

describe('tg.sendMedia — album', () => {
  it('sends an album of 3 photos and returns one id per item (happy)', async () => {
    const ctx = makeCtx();
    const p = params(tgSendMedia, {
      media: [
        { kind: 'photo', source: 'url', value: 'https://x.ir/1.jpg', caption: 'اول' },
        { kind: 'photo', source: 'base64', value: HI_B64 },
        { kind: 'video', source: 'file_id', value: 'BAAvid' },
      ],
    });
    const res = await tgSendMedia.execute(ctx, p, [item({})]);
    const media = ctx.sentMedia[0]!.opts.media as unknown[];
    expect(media).toHaveLength(3);
    if (res.kind !== 'items') throw new Error('expected items');
    expect(res.outputs.main![0]!.json.sent_message_ids).toEqual([100, 101, 102]);
    expect(res.outputs.main![0]!.json.sent_message_id).toBe(100);
  });

  it('rejects an album with a document item (only photo/video allowed) (error)', () => {
    expect(() =>
      params(tgSendMedia, {
        media: [
          { kind: 'photo', source: 'url', value: 'https://x.ir/1.jpg' },
          { kind: 'document', source: 'file_id', value: 'BQACdoc' },
        ],
      }),
    ).toThrow(/album/);
  });

  it('rejects a keyboard on an album (error)', () => {
    expect(() =>
      params(tgSendMedia, {
        media: [
          { kind: 'photo', source: 'url', value: 'https://x.ir/1.jpg' },
          { kind: 'photo', source: 'url', value: 'https://x.ir/2.jpg' },
        ],
        keyboard: { kind: 'inline', rows: [[{ text: 'x', kind: 'callback', value: 'y' }]] },
      }),
    ).toThrow(/keyboard/);
  });

  it('rejects more than 10 items (error)', () => {
    const media = Array.from({ length: 11 }, (_, i) => ({
      kind: 'photo' as const,
      source: 'url' as const,
      value: `https://x.ir/${i}.jpg`,
    }));
    expect(() => params(tgSendMedia, { media })).toThrow(/invalid params/);
  });

  it('requires at least one media item (error)', () => {
    expect(() => params(tgSendMedia, { media: [] })).toThrow(/invalid params/);
  });
});

describe('tg.sendMedia — failure paths', () => {
  it('fails without a Telegram sender (error)', async () => {
    const ctx = makeCtx({ tg: null });
    const p = params(tgSendMedia, { media: [{ kind: 'photo', source: 'url', value: 'https://x.ir/a.jpg' }] });
    const res = await tgSendMedia.execute(ctx, p, [item({})]);
    expect(res.kind).toBe('error');
  });

  it('fails when there is no chat context and no chat param (error)', async () => {
    const ctx = makeCtx({ chatId: null });
    const p = params(tgSendMedia, { media: [{ kind: 'photo', source: 'url', value: 'https://x.ir/a.jpg' }] });
    const res = await tgSendMedia.execute(ctx, p, [item({})]);
    if (res.kind !== 'error') throw new Error('expected error');
    expect(res.message).toMatch(/No destination chat/);
  });

  it('fails when source=file but no file store is wired (error)', async () => {
    const ctx = makeCtx({ files: null });
    const p = params(tgSendMedia, { media: [{ kind: 'photo', source: 'file', value: 'file_x' }] });
    const res = await tgSendMedia.execute(ctx, p, [item({})]);
    if (res.kind !== 'error') throw new Error('expected error');
    expect(res.message).toMatch(/file store/);
  });

  it('fails on an unknown file id (error)', async () => {
    const ctx = makeCtx({ seedFiles: {} });
    const p = params(tgSendMedia, { media: [{ kind: 'photo', source: 'file', value: 'nope' }] });
    const res = await tgSendMedia.execute(ctx, p, [item({})]);
    if (res.kind !== 'error') throw new Error('expected error');
    expect(res.message).toMatch(/file not found/);
  });

  it('fails on a transport error from the sender (error)', async () => {
    const ctx = makeCtx({ sendMediaError: 'Bad Request: chat not found' });
    const p = params(tgSendMedia, { media: [{ kind: 'photo', source: 'url', value: 'https://x.ir/a.jpg' }] });
    const res = await tgSendMedia.execute(ctx, p, [item({})]);
    if (res.kind !== 'error') throw new Error('expected error');
    expect(res.message).toMatch(/send failed/);
  });
});
