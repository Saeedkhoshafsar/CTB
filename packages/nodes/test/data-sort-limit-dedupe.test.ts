/**
 * PA-T6 contract tests — data.sort + data.limit + data.removeDuplicates.
 *
 * Small, pure, high-value item-list ops:
 *   data.sort             — order items by one or more keys.
 *   data.limit            — keep first/last N items.
 *   data.removeDuplicates — drop repeats (keep first), all-fields or by key.
 */
import { NodeRegistry } from '@ctb/core';
import { describe, expect, it } from 'vitest';
import {
  builtinNodes,
  dataLimit,
  dataRemoveDuplicates,
  dataSort,
  registerBuiltinNodes,
} from '@ctb/nodes';
import { item, makeCtx, params } from './node-harness';

type J = Record<string, unknown>;
const j = (it: { json: unknown }) => it.json as J;

// ── registry ──────────────────────────────────────────────────────────────────

describe('data.sort + data.limit + data.removeDuplicates — registry', () => {
  it('registers all three nodes; registry is 42 types', () => {
    const reg = registerBuiltinNodes(new NodeRegistry());
    expect(reg.has('data.sort')).toBe(true);
    expect(reg.has('data.limit')).toBe(true);
    expect(reg.has('data.removeDuplicates')).toBe(true);
    expect(dataSort.category).toBe('data');
    expect(dataLimit.category).toBe('data');
    expect(dataRemoveDuplicates.category).toBe('data');
    expect(builtinNodes.length).toBe(53);
  });

  it('all three have main→main ports', () => {
    for (const def of [dataSort, dataLimit, dataRemoveDuplicates]) {
      expect(def.ports.inputs).toEqual(['main']);
      expect(def.ports.outputs).toEqual(['main']);
    }
  });
});

// ── data.sort ───────────────────────────────────────────────────────────────

describe('data.sort', () => {
  it('sorts numerically ascending by default (happy)', async () => {
    const ctx = makeCtx();
    const p = params(dataSort, { fields: [{ field: 'age' }] });
    const src = [item({ age: 30 }), item({ age: 5 }), item({ age: 12 })];
    const res = await dataSort.execute(ctx, p, src);
    if (res.kind !== 'items') throw new Error('expected items');
    expect(res.outputs.main!.map((i) => j(i).age)).toEqual([5, 12, 30]);
  });

  it('numeric strings compare numerically, not lexically', async () => {
    const ctx = makeCtx();
    const p = params(dataSort, { fields: [{ field: 'n' }] });
    const src = [item({ n: '100' }), item({ n: '9' }), item({ n: '21' })];
    const res = await dataSort.execute(ctx, p, src);
    if (res.kind !== 'items') throw new Error('expected items');
    expect(res.outputs.main!.map((i) => j(i).n)).toEqual(['9', '21', '100']);
  });

  it('descending order', async () => {
    const ctx = makeCtx();
    const p = params(dataSort, { fields: [{ field: 'age', order: 'desc' }] });
    const src = [item({ age: 5 }), item({ age: 30 }), item({ age: 12 })];
    const res = await dataSort.execute(ctx, p, src);
    if (res.kind !== 'items') throw new Error('expected items');
    expect(res.outputs.main!.map((i) => j(i).age)).toEqual([30, 12, 5]);
  });

  it('multi-key: primary then tie-breaker', async () => {
    const ctx = makeCtx();
    const p = params(dataSort, {
      fields: [{ field: 'group' }, { field: 'score', order: 'desc' }],
    });
    const src = [
      item({ group: 'b', score: 1 }),
      item({ group: 'a', score: 2 }),
      item({ group: 'a', score: 9 }),
    ];
    const res = await dataSort.execute(ctx, p, src);
    if (res.kind !== 'items') throw new Error('expected items');
    const got = res.outputs.main!.map((i) => [j(i).group, j(i).score]);
    expect(got).toEqual([
      ['a', 9],
      ['a', 2],
      ['b', 1],
    ]);
  });

  it('string values compare locale-aware', async () => {
    const ctx = makeCtx();
    const p = params(dataSort, { fields: [{ field: 'name' }] });
    const src = [item({ name: 'Charlie' }), item({ name: 'Alice' }), item({ name: 'Bob' })];
    const res = await dataSort.execute(ctx, p, src);
    if (res.kind !== 'items') throw new Error('expected items');
    expect(res.outputs.main!.map((i) => j(i).name)).toEqual(['Alice', 'Bob', 'Charlie']);
  });

  it('missing/empty values sort LAST regardless of direction', async () => {
    const ctx = makeCtx();
    // ascending
    let res = await dataSort.execute(ctx, params(dataSort, { fields: [{ field: 'age' }] }), [
      item({ age: 10 }),
      item({ name: 'no-age' }),
      item({ age: 3 }),
    ]);
    if (res.kind !== 'items') throw new Error('expected items');
    expect(res.outputs.main!.map((i) => j(i).age)).toEqual([3, 10, undefined]);
    // descending — missing STILL last
    res = await dataSort.execute(
      ctx,
      params(dataSort, { fields: [{ field: 'age', order: 'desc' }] }),
      [item({ age: 10 }), item({ name: 'no-age' }), item({ age: 3 })],
    );
    if (res.kind !== 'items') throw new Error('expected items');
    expect(res.outputs.main!.map((i) => j(i).age)).toEqual([10, 3, undefined]);
  });

  it('is stable for equal keys (preserves input order)', async () => {
    const ctx = makeCtx();
    const p = params(dataSort, { fields: [{ field: 'k' }] });
    const src = [item({ k: 1, id: 'a' }), item({ k: 1, id: 'b' }), item({ k: 1, id: 'c' })];
    const res = await dataSort.execute(ctx, p, src);
    if (res.kind !== 'items') throw new Error('expected items');
    expect(res.outputs.main!.map((i) => j(i).id)).toEqual(['a', 'b', 'c']);
  });

  it('does not mutate the input array order', async () => {
    const ctx = makeCtx();
    const p = params(dataSort, { fields: [{ field: 'age' }] });
    const src = [item({ age: 30 }), item({ age: 5 })];
    await dataSort.execute(ctx, p, src);
    expect(src.map((i) => j(i).age)).toEqual([30, 5]); // original untouched
  });

  it('empty input → empty output', async () => {
    const ctx = makeCtx();
    const res = await dataSort.execute(ctx, params(dataSort, { fields: [{ field: 'x' }] }), []);
    if (res.kind !== 'items') throw new Error('expected items');
    expect(res.outputs.main).toEqual([]);
  });

  it('rejects empty fields list (schema)', () => {
    expect(() => params(dataSort, { fields: [] })).toThrow();
  });
});

// ── data.limit ──────────────────────────────────────────────────────────────

describe('data.limit', () => {
  const five = [item({ i: 1 }), item({ i: 2 }), item({ i: 3 }), item({ i: 4 }), item({ i: 5 })];

  it('keeps the first N by default (happy)', async () => {
    const ctx = makeCtx();
    const res = await dataLimit.execute(ctx, params(dataLimit, { max_items: 2 }), five);
    if (res.kind !== 'items') throw new Error('expected items');
    expect(res.outputs.main!.map((i) => j(i).i)).toEqual([1, 2]);
  });

  it('keeps the last N when keep=last', async () => {
    const ctx = makeCtx();
    const res = await dataLimit.execute(
      ctx,
      params(dataLimit, { max_items: 2, keep: 'last' }),
      five,
    );
    if (res.kind !== 'items') throw new Error('expected items');
    expect(res.outputs.main!.map((i) => j(i).i)).toEqual([4, 5]);
  });

  it('max_items=0 lets everything through (no limit)', async () => {
    const ctx = makeCtx();
    const res = await dataLimit.execute(ctx, params(dataLimit, { max_items: 0 }), five);
    if (res.kind !== 'items') throw new Error('expected items');
    expect(res.outputs.main).toHaveLength(5);
  });

  it('limit >= length passes all through unchanged', async () => {
    const ctx = makeCtx();
    const res = await dataLimit.execute(ctx, params(dataLimit, { max_items: 99 }), five);
    if (res.kind !== 'items') throw new Error('expected items');
    expect(res.outputs.main).toHaveLength(5);
  });

  it('coerces a string max_items (z.coerce)', async () => {
    const ctx = makeCtx();
    const res = await dataLimit.execute(
      ctx,
      params(dataLimit, { max_items: '3' as unknown as number }),
      five,
    );
    if (res.kind !== 'items') throw new Error('expected items');
    expect(res.outputs.main).toHaveLength(3);
  });

  it('empty input → empty output', async () => {
    const ctx = makeCtx();
    const res = await dataLimit.execute(ctx, params(dataLimit, { max_items: 3 }), []);
    if (res.kind !== 'items') throw new Error('expected items');
    expect(res.outputs.main).toEqual([]);
  });

  it('rejects negative max_items (schema)', () => {
    expect(() => params(dataLimit, { max_items: -1 })).toThrow();
  });
});

// ── data.removeDuplicates ─────────────────────────────────────────────────────

describe('data.removeDuplicates', () => {
  it('all_fields: drops exact-$json duplicates, keeps first (happy)', async () => {
    const ctx = makeCtx();
    const src = [item({ a: 1, b: 2 }), item({ a: 1, b: 2 }), item({ a: 3 })];
    const res = await dataRemoveDuplicates.execute(ctx, params(dataRemoveDuplicates, {}), src);
    if (res.kind !== 'items') throw new Error('expected items');
    expect(res.outputs.main).toHaveLength(2);
    expect(res.outputs.main!.map((i) => j(i).a)).toEqual([1, 3]);
  });

  it('all_fields: key order does not matter (stable stringify)', async () => {
    const ctx = makeCtx();
    const src = [item({ a: 1, b: 2 }), item({ b: 2, a: 1 })];
    const res = await dataRemoveDuplicates.execute(ctx, params(dataRemoveDuplicates, {}), src);
    if (res.kind !== 'items') throw new Error('expected items');
    expect(res.outputs.main).toHaveLength(1);
  });

  it('selected_fields: dedupe by chosen key only', async () => {
    const ctx = makeCtx();
    const src = [
      item({ id: 1, ts: 100 }),
      item({ id: 1, ts: 200 }), // same id → duplicate
      item({ id: 2, ts: 300 }),
    ];
    const res = await dataRemoveDuplicates.execute(
      ctx,
      params(dataRemoveDuplicates, { compare: 'selected_fields', fields: ['id'] }),
      src,
    );
    if (res.kind !== 'items') throw new Error('expected items');
    expect(res.outputs.main!.map((i) => j(i).id)).toEqual([1, 2]);
    // first occurrence kept (ts=100, not 200)
    expect(j(res.outputs.main![0]!).ts).toBe(100);
  });

  it('selected_fields: combined multi-field key', async () => {
    const ctx = makeCtx();
    const src = [
      item({ a: 1, b: 'x' }),
      item({ a: 1, b: 'y' }), // a same but b differs → kept
      item({ a: 1, b: 'x' }), // full dup → dropped
    ];
    const res = await dataRemoveDuplicates.execute(
      ctx,
      params(dataRemoveDuplicates, { compare: 'selected_fields', fields: ['a', 'b'] }),
      src,
    );
    if (res.kind !== 'items') throw new Error('expected items');
    expect(res.outputs.main).toHaveLength(2);
  });

  it('missing selected field does not collide with literal null', async () => {
    const ctx = makeCtx();
    const src = [item({ k: null }), item({ other: 1 })]; // one has k=null, one is missing k
    const res = await dataRemoveDuplicates.execute(
      ctx,
      params(dataRemoveDuplicates, { compare: 'selected_fields', fields: ['k'] }),
      src,
    );
    if (res.kind !== 'items') throw new Error('expected items');
    expect(res.outputs.main).toHaveLength(2);
  });

  it('preserves order of survivors', async () => {
    const ctx = makeCtx();
    const src = [item({ v: 'a' }), item({ v: 'b' }), item({ v: 'a' }), item({ v: 'c' })];
    const res = await dataRemoveDuplicates.execute(ctx, params(dataRemoveDuplicates, {}), src);
    if (res.kind !== 'items') throw new Error('expected items');
    expect(res.outputs.main!.map((i) => j(i).v)).toEqual(['a', 'b', 'c']);
  });

  it('empty input → empty output', async () => {
    const ctx = makeCtx();
    const res = await dataRemoveDuplicates.execute(ctx, params(dataRemoveDuplicates, {}), []);
    if (res.kind !== 'items') throw new Error('expected items');
    expect(res.outputs.main).toEqual([]);
  });

  it('fails loudly when selected_fields has no fields', async () => {
    const ctx = makeCtx();
    const res = await dataRemoveDuplicates.execute(
      ctx,
      params(dataRemoveDuplicates, { compare: 'selected_fields', fields: [] }),
      [item({ a: 1 })],
    );
    expect(res.kind).toBe('error');
  });
});
