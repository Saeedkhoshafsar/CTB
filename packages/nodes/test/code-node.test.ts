/**
 * P2-T7 contract tests — data.code (the escape hatch).
 *
 * These run REAL user JavaScript through the @ctb/sandbox worker pool (the
 * harness wires true capability proxies), so they exercise genuine isolation,
 * console capture, $http/$kv access, return-normalization and the timeout cap.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { destroyDefaultSandboxPool } from '@ctb/sandbox';
import { CODE_TIMEOUT_CAP_MS, dataCode, normalizeReturn } from '@ctb/nodes';
import { item, makeCtx, params } from './node-harness';

afterAll(async () => {
  // The harness uses the shared default pool; tear its workers down.
  await destroyDefaultSandboxPool();
});

describe('data.code — run_once mode', () => {
  it('returns a single object → one shaped item (happy)', async () => {
    const ctx = makeCtx();
    const p = params(dataCode, { mode: 'run_once', code: 'return { greeting: "hi", n: $items.length };' });
    const res = await dataCode.execute(ctx, p, [item({ a: 1 }), item({ a: 2 })]);
    if (res.kind !== 'items') throw new Error('expected items');
    expect(res.outputs.main).toEqual([{ json: { greeting: 'hi', n: 2 } }]);
  });

  it('sees $json (first item) and $vars (edge)', async () => {
    const ctx = makeCtx();
    ctx.varsBag.name = 'علی';
    const p = params(dataCode, {
      mode: 'run_once',
      code: 'return { who: $vars.name, first: $json.x };',
    });
    const res = await dataCode.execute(ctx, p, [item({ x: 42 })]);
    if (res.kind !== 'items') throw new Error('expected items');
    expect(res.outputs.main).toEqual([{ json: { who: 'علی', first: 42 } }]);
  });

  it('runs once even on empty input ($items = []) — can seed the pipeline (edge)', async () => {
    const ctx = makeCtx();
    const p = params(dataCode, { mode: 'run_once', code: 'return [{ seeded: true }];' });
    const res = await dataCode.execute(ctx, p, []);
    if (res.kind !== 'items') throw new Error('expected items');
    expect(res.outputs.main).toEqual([{ json: { seeded: true } }]);
  });

  it('returning an array of objects → many items, preserving order', async () => {
    const ctx = makeCtx();
    const p = params(dataCode, {
      mode: 'run_once',
      code: 'return $items.map((it, i) => ({ ...it.json, idx: i }));',
    });
    const res = await dataCode.execute(ctx, p, [item({ v: 'a' }), item({ v: 'b' })]);
    if (res.kind !== 'items') throw new Error('expected items');
    expect(res.outputs.main).toEqual([
      { json: { v: 'a', idx: 0 } },
      { json: { v: 'b', idx: 1 } },
    ]);
  });

  it('returning nothing (undefined) passes input items through unchanged (edge)', async () => {
    const ctx = makeCtx();
    const input = [item({ keep: 1 })];
    const p = params(dataCode, { mode: 'run_once', code: 'const x = 1 + 1;' });
    const res = await dataCode.execute(ctx, p, input);
    if (res.kind !== 'items') throw new Error('expected items');
    expect(res.outputs.main).toEqual(input);
  });

  it('captures console.log into the execution log (edge)', async () => {
    const ctx = makeCtx();
    const p = params(dataCode, {
      mode: 'run_once',
      code: 'console.log("hello from sandbox"); return { ok: true };',
    });
    const res = await dataCode.execute(ctx, p, [item({})]);
    if (res.kind !== 'items') throw new Error('expected items');
    expect(ctx.logs.some((l) => l.level === 'debug' && l.message.includes('hello from sandbox'))).toBe(true);
  });

  it('can await $http and $kv capabilities (edge)', async () => {
    const ctx = makeCtx({ httpResponses: [{ status: 200, body: { token: 'abc' } }] });
    const p = params(dataCode, {
      mode: 'run_once',
      code: [
        'const r = await $http.get("https://api.example.com/auth");',
        'await $kv.set("last_token", r.body.token);',
        'const back = await $kv.get("last_token");',
        'return { token: back };',
      ].join('\n'),
    });
    const res = await dataCode.execute(ctx, p, [item({})]);
    if (res.kind !== 'items') throw new Error('expected items');
    expect(res.outputs.main).toEqual([{ json: { token: 'abc' } }]);
    expect(ctx.httpCalls).toHaveLength(1);
    expect(ctx.kvBag.get('user:last_token')).toBe('abc');
  });

  it('a thrown error becomes a loud node error, not a crash (error)', async () => {
    const ctx = makeCtx();
    const p = params(dataCode, { mode: 'run_once', code: 'throw new Error("boom in user code");' });
    const res = await dataCode.execute(ctx, p, [item({})]);
    expect(res.kind).toBe('error');
    if (res.kind !== 'error') throw new Error('expected error');
    expect(res.message).toMatch(/boom in user code/);
  });
});

describe('data.code — per_item mode', () => {
  it('runs once per item; outputs concat in input order (happy)', async () => {
    const ctx = makeCtx();
    const p = params(dataCode, {
      mode: 'per_item',
      code: 'return { doubled: $json.n * 2 };',
    });
    const res = await dataCode.execute(ctx, p, [item({ n: 3 }), item({ n: 5 })]);
    if (res.kind !== 'items') throw new Error('expected items');
    expect(res.outputs.main).toEqual([{ json: { doubled: 6 } }, { json: { doubled: 10 } }]);
  });

  it('empty input → no runs → empty output (edge)', async () => {
    const ctx = makeCtx();
    const p = params(dataCode, { mode: 'per_item', code: 'return { x: 1 };' });
    const res = await dataCode.execute(ctx, p, []);
    if (res.kind !== 'items') throw new Error('expected items');
    expect(res.outputs.main).toEqual([]);
  });

  it('a per-item run returning undefined passes that item through (edge)', async () => {
    const ctx = makeCtx();
    const p = params(dataCode, {
      mode: 'per_item',
      // keep even, drop-shape odd → undefined falls back to the original item
      code: 'if ($json.n % 2 === 0) return { even: $json.n };',
    });
    const res = await dataCode.execute(ctx, p, [item({ n: 2 }), item({ n: 3 })]);
    if (res.kind !== 'items') throw new Error('expected items');
    expect(res.outputs.main).toEqual([{ json: { even: 2 } }, { json: { n: 3 } }]);
  });
});

describe('data.code — params & limits', () => {
  it('schema requires a non-empty code string and defaults mode to run_once', () => {
    expect(() => params(dataCode, { code: '' })).toThrow(/invalid params/);
    expect(() => params(dataCode, {})).toThrow(/invalid params/);
    const p = params(dataCode, { code: 'return 1;' });
    expect(p.mode).toBe('run_once');
  });

  it('lists `code` as a raw param key so the executor never expression-resolves it', () => {
    expect(dataCode.rawParamKeys).toContain('code');
  });

  it('the timeout cap is the documented 10s (NODES.md)', () => {
    expect(CODE_TIMEOUT_CAP_MS).toBe(10_000);
  });
});

describe('normalizeReturn (n8n-style)', () => {
  const input = [item({ original: true })];

  it('undefined / null → input passthrough', () => {
    expect(normalizeReturn(undefined, input)).toBe(input);
    expect(normalizeReturn(null, input)).toBe(input);
  });

  it('plain object → wrapped as { json }', () => {
    expect(normalizeReturn({ a: 1 }, input)).toEqual([{ json: { a: 1 } }]);
  });

  it('already-{json} object is kept (incl. binary)', () => {
    const binary = { f: { kind: 'url' as const, url: 'https://example.com/a.png' } };
    expect(normalizeReturn({ json: { a: 1 }, binary }, input)).toEqual([{ json: { a: 1 }, binary }]);
  });

  it('array → each element normalized & flattened', () => {
    expect(normalizeReturn([{ a: 1 }, { json: { b: 2 } }], input)).toEqual([
      { json: { a: 1 } },
      { json: { b: 2 } },
    ]);
  });

  it('primitive → wrapped under { value }', () => {
    expect(normalizeReturn(42, input)).toEqual([{ json: { value: 42 } }]);
    expect(normalizeReturn('hi', input)).toEqual([{ json: { value: 'hi' } }]);
  });
});
