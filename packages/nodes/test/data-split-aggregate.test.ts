/**
 * PA-T5 contract tests — data.splitOut + data.aggregate.
 *
 * data.splitOut: splits array field into one item per element (n8n Split Out).
 * data.aggregate: merges items back into one (n8n Aggregate).
 * Together they form an inverse pair.
 */
import { NodeRegistry } from '@ctb/core';
import { describe, expect, it } from 'vitest';
import { builtinNodes, dataAggregate, dataSplitOut, registerBuiltinNodes } from '@ctb/nodes';
import { item, makeCtx, params } from './node-harness';

// ── registry ──────────────────────────────────────────────────────────────────

describe('data.splitOut + data.aggregate — registry', () => {
  it('registers both nodes; registry is 38 types', () => {
    const reg = registerBuiltinNodes(new NodeRegistry());
    expect(reg.has('data.splitOut')).toBe(true);
    expect(reg.has('data.aggregate')).toBe(true);
    expect(dataSplitOut.category).toBe('data');
    expect(dataAggregate.category).toBe('data');
    expect(builtinNodes.length).toBe(55);
  });

  it('splitOut ports: inputs=[main], outputs=[main,empty]', () => {
    expect(dataSplitOut.ports.inputs).toEqual(['main']);
    expect(dataSplitOut.ports.outputs).toEqual(['main', 'empty']);
  });

  it('aggregate ports: inputs=[main], outputs=[main]', () => {
    expect(dataAggregate.ports.inputs).toEqual(['main']);
    expect(dataAggregate.ports.outputs).toEqual(['main']);
  });
});

// ── data.splitOut ─────────────────────────────────────────────────────────────

describe('data.splitOut — happy path', () => {
  it('splits an array field into one item per element (happy)', async () => {
    const ctx = makeCtx();
    const p = params(dataSplitOut, { field: 'tags' });
    const src = item({ name: 'Ali', tags: ['a', 'b', 'c'] });
    const res = await dataSplitOut.execute(ctx, p, [src]);
    if (res.kind !== 'items') throw new Error('expected items');
    expect(res.outputs.main).toHaveLength(3);
    expect(res.outputs.empty).toHaveLength(0);
    // all_fields mode: original item with field replaced by element
    expect((res.outputs.main![0]!.json as Record<string, unknown>).tags).toBe('a');
    expect((res.outputs.main![1]!.json as Record<string, unknown>).tags).toBe('b');
    expect((res.outputs.main![2]!.json as Record<string, unknown>).tags).toBe('c');
    // other fields carried through
    expect((res.outputs.main![0]!.json as Record<string, unknown>).name).toBe('Ali');
  });

  it('selected_field_only wraps primitive elements in {value} (edge)', async () => {
    const ctx = makeCtx();
    const p = params(dataSplitOut, { field: 'tags', include: 'selected_field_only' });
    const src = item({ name: 'Ali', tags: [10, 20] });
    const res = await dataSplitOut.execute(ctx, p, [src]);
    if (res.kind !== 'items') throw new Error('expected items');
    expect(res.outputs.main).toHaveLength(2);
    expect(res.outputs.main![0]!.json).toEqual({ value: 10 });
    expect(res.outputs.main![1]!.json).toEqual({ value: 20 });
  });

  it('selected_field_only passes object elements through directly (edge)', async () => {
    const ctx = makeCtx();
    const p = params(dataSplitOut, { field: 'items', include: 'selected_field_only' });
    const src = item({ items: [{ id: 1 }, { id: 2 }] });
    const res = await dataSplitOut.execute(ctx, p, [src]);
    if (res.kind !== 'items') throw new Error('expected items');
    expect(res.outputs.main![0]!.json).toEqual({ id: 1 });
    expect(res.outputs.main![1]!.json).toEqual({ id: 2 });
  });

  it('empty array sends original item to empty port (edge)', async () => {
    const ctx = makeCtx();
    const p = params(dataSplitOut, { field: 'tags' });
    const src = item({ tags: [] });
    const res = await dataSplitOut.execute(ctx, p, [src]);
    if (res.kind !== 'items') throw new Error('expected items');
    expect(res.outputs.main).toHaveLength(0);
    expect(res.outputs.empty).toHaveLength(1);
    expect(res.outputs.empty![0]).toBe(src);
  });

  it('missing field sends item to empty port (edge)', async () => {
    const ctx = makeCtx();
    const p = params(dataSplitOut, { field: 'nonexistent' });
    const src = item({ a: 1 });
    const res = await dataSplitOut.execute(ctx, p, [src]);
    if (res.kind !== 'items') throw new Error('expected items');
    expect(res.outputs.main).toHaveLength(0);
    expect(res.outputs.empty).toHaveLength(1);
  });

  it('non-array value treated as single-element array (edge)', async () => {
    const ctx = makeCtx();
    const p = params(dataSplitOut, { field: 'tag' });
    const src = item({ tag: 'hello' });
    const res = await dataSplitOut.execute(ctx, p, [src]);
    if (res.kind !== 'items') throw new Error('expected items');
    expect(res.outputs.main).toHaveLength(1);
    expect((res.outputs.main![0]!.json as Record<string, unknown>).tag).toBe('hello');
  });

  it('empty input seeds one item and sends it to empty (edge)', async () => {
    const ctx = makeCtx();
    const p = params(dataSplitOut, { field: 'tags' });
    const res = await dataSplitOut.execute(ctx, p, []);
    if (res.kind !== 'items') throw new Error('expected items');
    // Seeded item has no tags → goes to empty
    expect(res.outputs.empty).toHaveLength(1);
    expect(res.outputs.main).toHaveLength(0);
  });

  it('original item is not mutated (edge)', async () => {
    const ctx = makeCtx();
    const p = params(dataSplitOut, { field: 'tags' });
    const src = item({ tags: [1, 2, 3] });
    await dataSplitOut.execute(ctx, p, [src]);
    expect((src.json as Record<string, unknown>).tags).toEqual([1, 2, 3]);
  });

  it('rejects empty field name at parse time (error)', () => {
    expect(() => params(dataSplitOut, { field: '' })).toThrow(/invalid params/);
  });
});

// ── data.aggregate ────────────────────────────────────────────────────────────

describe('data.aggregate — aggregate_all_items', () => {
  it('wraps all items $json into array under dest_field (happy)', async () => {
    const ctx = makeCtx();
    const p = params(dataAggregate, { mode: 'aggregate_all_items' });
    const items = [item({ a: 1 }), item({ b: 2 }), item({ c: 3 })];
    const res = await dataAggregate.execute(ctx, p, items);
    if (res.kind !== 'items') throw new Error('expected items');
    expect(res.outputs.main).toHaveLength(1);
    const json = res.outputs.main![0]!.json as Record<string, unknown>;
    expect(json.data).toEqual([{ a: 1 }, { b: 2 }, { c: 3 }]);
  });

  it('custom dest_field name (edge)', async () => {
    const ctx = makeCtx();
    const p = params(dataAggregate, { mode: 'aggregate_all_items', dest_field: 'results' });
    const items = [item({ x: 1 })];
    const res = await dataAggregate.execute(ctx, p, items);
    if (res.kind !== 'items') throw new Error('expected items');
    expect((res.outputs.main![0]!.json as Record<string, unknown>).results).toEqual([{ x: 1 }]);
  });

  it('empty input → single item with empty array (edge)', async () => {
    const ctx = makeCtx();
    const p = params(dataAggregate, { mode: 'aggregate_all_items' });
    const res = await dataAggregate.execute(ctx, p, []);
    if (res.kind !== 'items') throw new Error('expected items');
    expect(res.outputs.main).toHaveLength(1);
    expect((res.outputs.main![0]!.json as Record<string, unknown>).data).toEqual([]);
  });
});

describe('data.aggregate — aggregate_individual_fields', () => {
  it('collects one named field across all items (happy)', async () => {
    const ctx = makeCtx();
    const p = params(dataAggregate, {
      mode: 'aggregate_individual_fields',
      fields: [{ field: 'score' }],
    });
    const items = [item({ score: 10, name: 'a' }), item({ score: 20, name: 'b' })];
    const res = await dataAggregate.execute(ctx, p, items);
    if (res.kind !== 'items') throw new Error('expected items');
    const json = res.outputs.main![0]!.json as Record<string, unknown>;
    expect(json.score).toEqual([10, 20]);
    // first item's other fields carried through
    expect(json.name).toBe('a');
  });

  it('dest writes collected values under the new key (edge)', async () => {
    const ctx = makeCtx();
    const p = params(dataAggregate, {
      mode: 'aggregate_individual_fields',
      fields: [{ field: 'score', dest: 'scores' }],
    });
    const items = [item({ score: 5 }), item({ score: 8 })];
    const res = await dataAggregate.execute(ctx, p, items);
    if (res.kind !== 'items') throw new Error('expected items');
    const json = res.outputs.main![0]!.json as Record<string, unknown>;
    // `scores` gets the collected array; `score` is still present from the first item (n8n-compatible)
    expect(json.scores).toEqual([5, 8]);
    expect(json.score).toBe(5); // carried through from first item
  });

  it('missing field collected as undefined (edge)', async () => {
    const ctx = makeCtx();
    const p = params(dataAggregate, {
      mode: 'aggregate_individual_fields',
      fields: [{ field: 'missing' }],
    });
    const items = [item({ a: 1 }), item({ b: 2 })];
    const res = await dataAggregate.execute(ctx, p, items);
    if (res.kind !== 'items') throw new Error('expected items');
    const json = res.outputs.main![0]!.json as Record<string, unknown>;
    expect(json.missing).toEqual([undefined, undefined]);
  });
});

// ── splitOut ↔ aggregate inverse pair ────────────────────────────────────────

describe('data.splitOut + data.aggregate — inverse pair', () => {
  it('splitOut then aggregate_all_items round-trips (happy)', async () => {
    const ctx = makeCtx();
    const original = [item({ id: 1, tags: ['x', 'y', 'z'] })];

    // Split
    const splitP = params(dataSplitOut, { field: 'tags', include: 'selected_field_only' });
    const splitRes = await dataSplitOut.execute(ctx, splitP, original);
    if (splitRes.kind !== 'items') throw new Error('expected items');
    const split = splitRes.outputs.main!;
    expect(split).toHaveLength(3);

    // Aggregate back
    const aggP = params(dataAggregate, { mode: 'aggregate_all_items', dest_field: 'values' });
    const aggRes = await dataAggregate.execute(ctx, aggP, split);
    if (aggRes.kind !== 'items') throw new Error('expected items');
    const agg = aggRes.outputs.main![0]!.json as Record<string, unknown>;
    // Each split element was wrapped in {value: ...}
    expect(agg.values).toEqual([{ value: 'x' }, { value: 'y' }, { value: 'z' }]);
  });
});
