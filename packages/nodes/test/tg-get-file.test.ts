/**
 * PA-T2 contract tests — tg.getFile (Get a File).
 *
 * Covers: resolving the file_id from an explicit param and from the incoming
 * item ($json.file_id + nested fallbacks), storing the downloaded bytes via
 * ctx.files.write (store:true) vs. URL-only (store:false), the result shape
 * merged under `save_as`, passthrough, and the loud-failure paths (no sender,
 * missing getFile capability, missing file store, no file_id, download error).
 */
import { describe, expect, it } from 'vitest';
import { tgGetFile } from '@ctb/nodes';
import { item, makeCtx, params } from './node-harness';

describe('tg.getFile — resolve', () => {
  it('downloads by explicit file_id, stores it, merges result under save_as (happy)', async () => {
    const ctx = makeCtx();
    const p = params(tgGetFile, { file_id: 'AgACfile123' });
    const res = await tgGetFile.execute(ctx, p, [item({ name: 'علی' })]);

    expect(ctx.getFileCalls).toEqual(['AgACfile123']);
    expect(ctx.storedFiles).toHaveLength(1);
    expect(ctx.storedFiles[0]!.bytes).toEqual(new Uint8Array([1, 2, 3, 4]));

    if (res.kind !== 'items') throw new Error('expected items');
    const f = res.outputs.main![0]!.json.file as Record<string, unknown>;
    expect(f.file_id).toBe('AgACfile123');
    expect(f.stored_file_id).toBe('stored1');
    expect(f.url).toBe('/api/files/stored1');
    expect(f.mime).toBe('image/jpeg');
    expect(f.size).toBe(4);
    expect(f.path).toBe('photos/AgACfile123.jpg');
    expect(res.outputs.main![0]!.json.name).toBe('علی'); // passthrough
  });

  it('auto-resolves file_id from $json.file_id when the param is blank (edge)', async () => {
    const ctx = makeCtx();
    const p = params(tgGetFile, {}); // file_id defaults to ''
    const res = await tgGetFile.execute(ctx, p, [item({ file_id: 'fromJson' })]);
    expect(ctx.getFileCalls).toEqual(['fromJson']);
    if (res.kind !== 'items') throw new Error('expected items');
    const f = res.outputs.main![0]!.json.file as Record<string, unknown>;
    expect(f.file_id).toBe('fromJson');
  });

  it('auto-resolves from a nested shape (voice.file_id) (edge)', async () => {
    const ctx = makeCtx();
    const p = params(tgGetFile, {});
    const res = await tgGetFile.execute(ctx, p, [item({ voice: { file_id: 'voiceXYZ', duration: 3 } })]);
    expect(ctx.getFileCalls).toEqual(['voiceXYZ']);
    if (res.kind !== 'items') throw new Error('expected items');
  });

  it('explicit param wins over the item field (edge)', async () => {
    const ctx = makeCtx();
    const p = params(tgGetFile, { file_id: 'explicit' });
    await tgGetFile.execute(ctx, p, [item({ file_id: 'fromJson' })]);
    expect(ctx.getFileCalls).toEqual(['explicit']);
  });

  it('honors a custom save_as field (edge)', async () => {
    const ctx = makeCtx();
    const p = params(tgGetFile, { file_id: 'f1', save_as: 'voice_clip' });
    const res = await tgGetFile.execute(ctx, p, [item({})]);
    if (res.kind !== 'items') throw new Error('expected items');
    expect(res.outputs.main![0]!.json.voice_clip).toBeDefined();
    expect(res.outputs.main![0]!.json.file).toBeUndefined();
  });
});

describe('tg.getFile — store flag', () => {
  it('store:false returns the Telegram URL + metadata without writing to disk (edge)', async () => {
    const ctx = makeCtx();
    const p = params(tgGetFile, { file_id: 'f1', store: false });
    const res = await tgGetFile.execute(ctx, p, [item({})]);
    expect(ctx.storedFiles).toHaveLength(0); // nothing written
    if (res.kind !== 'items') throw new Error('expected items');
    const f = res.outputs.main![0]!.json.file as Record<string, unknown>;
    expect(f.stored_file_id).toBeUndefined();
    expect(f.url).toBe('https://api.telegram.org/file/photos/f1.jpg');
    expect(f.path).toBe('photos/f1.jpg');
    expect(f.size).toBe(4);
  });

  it('runs once per node run regardless of item count (edge)', async () => {
    const ctx = makeCtx();
    const p = params(tgGetFile, { file_id: 'f1' });
    const res = await tgGetFile.execute(ctx, p, [item({ a: 1 }), item({ a: 2 }), item({ a: 3 })]);
    expect(ctx.getFileCalls).toHaveLength(1); // one download
    expect(ctx.storedFiles).toHaveLength(1); // one store
    if (res.kind !== 'items') throw new Error('expected items');
    expect(res.outputs.main).toHaveLength(3); // result merged onto every item
    expect((res.outputs.main![2]!.json.file as Record<string, unknown>).stored_file_id).toBe('stored1');
  });
});

describe('tg.getFile — failures (loud)', () => {
  it('fails when no Telegram context is injected', async () => {
    const ctx = makeCtx({ tg: null });
    const p = params(tgGetFile, { file_id: 'f1' });
    const res = await tgGetFile.execute(ctx, p, [item({})]);
    expect(res.kind).toBe('error');
  });

  it('fails when the host did not inject getFile', async () => {
    const ctx = makeCtx({ noGetFile: true });
    const p = params(tgGetFile, { file_id: 'f1' });
    const res = await tgGetFile.execute(ctx, p, [item({})]);
    if (res.kind !== 'error') throw new Error('expected error');
    expect(res.message).toMatch(/not available/i);
  });

  it('fails when no file_id can be resolved', async () => {
    const ctx = makeCtx();
    const p = params(tgGetFile, {}); // blank param
    const res = await tgGetFile.execute(ctx, p, [item({ unrelated: 'x' })]);
    if (res.kind !== 'error') throw new Error('expected error');
    expect(res.message).toMatch(/no file_id/i);
    expect(ctx.getFileCalls).toHaveLength(0);
  });

  it('fails when store is on but no file store is wired', async () => {
    const ctx = makeCtx({ files: null });
    const p = params(tgGetFile, { file_id: 'f1' }); // store defaults true
    const res = await tgGetFile.execute(ctx, p, [item({})]);
    if (res.kind !== 'error') throw new Error('expected error');
    expect(res.message).toMatch(/no file store/i);
  });

  it('fails loudly on a download/transport error', async () => {
    const ctx = makeCtx({ getFileError: 'file is too big' });
    const p = params(tgGetFile, { file_id: 'f1' });
    const res = await tgGetFile.execute(ctx, p, [item({})]);
    if (res.kind !== 'error') throw new Error('expected error');
    expect(res.message).toMatch(/download failed/i);
    expect(res.message).toMatch(/file is too big/);
  });
});
