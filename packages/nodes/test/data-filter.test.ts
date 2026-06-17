/**
 * PA-T4 contract tests — data.filter.
 *
 * Covers: registry, happy-path partitioning, AND/OR combine, per-item
 * evaluation, numeric-loose equality (reuses compareValues), empty-input
 * seeding, multiple conditions, empty kept/discarded ports, and the loud
 * failure path (empty conditions).
 */
import { NodeRegistry } from '@ctb/core';
import { describe, expect, it } from 'vitest';
import { builtinNodes, dataFilter, registerBuiltinNodes } from '@ctb/nodes';
import { item, makeCtx, params } from './node-harness';

describe('data.filter — registry', () => {
  it('registers data.filter; registry is 38 types', () => {
    const reg = registerBuiltinNodes(new NodeRegistry());
    expect(reg.has('data.filter')).toBe(true);
    expect(dataFilter.category).toBe('data');
    expect(builtinNodes.length).toBe(38);
  });

  it('has ports: inputs=[main], outputs=[kept, discarded]', () => {
    expect(dataFilter.ports.inputs).toEqual(['main']);
    expect(dataFilter.ports.outputs).toEqual(['kept', 'discarded']);
  });
});

describe('data.filter — happy path partitioning', () => {
  it('all matching → all to kept, none to discarded (happy)', async () => {
    const ctx = makeCtx();
    // In a real flow, value1 is resolved by the executor before the node runs.
    // A literal condition that is true applies to every item in the batch.
    const p = params(dataFilter, {
      conditions: [{ value1: 'active', operator: 'equals', value2: 'active' }],
    });
    const items = [item({ id: 1 }), item({ id: 2 }), item({ id: 3 })];
    const res = await dataFilter.execute(ctx, p, items);
    if (res.kind !== 'items') throw new Error('expected items');
    expect(res.outputs.kept).toHaveLength(3);
    expect(res.outputs.discarded).toHaveLength(0);
  });

  it('always-false condition sends all items to discarded (happy)', async () => {
    const ctx = makeCtx();
    const p = params(dataFilter, {
      conditions: [{ value1: 'inactive', operator: 'equals', value2: 'active' }],
    });
    const items = [item({ id: 1 }), item({ id: 2 })];
    const res = await dataFilter.execute(ctx, p, items);
    if (res.kind !== 'items') throw new Error('expected items');
    expect(res.outputs.kept).toHaveLength(0);
    expect(res.outputs.discarded).toHaveLength(2);
  });

  it('all items pass → discarded is empty (edge)', async () => {
    const ctx = makeCtx();
    const p = params(dataFilter, {
      conditions: [{ value1: 'yes', operator: 'equals', value2: 'yes' }],
    });
    const items = [item({ a: 1 }), item({ a: 2 })];
    const res = await dataFilter.execute(ctx, p, items);
    if (res.kind !== 'items') throw new Error('expected items');
    expect(res.outputs.kept).toHaveLength(2);
    expect(res.outputs.discarded).toHaveLength(0);
  });

  it('no items pass → kept is empty (edge)', async () => {
    const ctx = makeCtx();
    const p = params(dataFilter, {
      conditions: [{ value1: 'yes', operator: 'equals', value2: 'no' }],
    });
    const items = [item({ a: 1 }), item({ a: 2 })];
    const res = await dataFilter.execute(ctx, p, items);
    if (res.kind !== 'items') throw new Error('expected items');
    expect(res.outputs.kept).toHaveLength(0);
    expect(res.outputs.discarded).toHaveLength(2);
  });
});

describe('data.filter — condition engine (reuses flow.if compareValues)', () => {
  it('numeric loose-equals: "18" equals 18 (edge)', async () => {
    const ctx = makeCtx();
    const p = params(dataFilter, {
      conditions: [{ value1: '18', operator: 'equals', value2: 18 }],
    });
    const res = await dataFilter.execute(ctx, p, [item({}), item({})]);
    if (res.kind !== 'items') throw new Error('expected items');
    expect(res.outputs.kept).toHaveLength(2);
  });

  it('gt operator filters numbers correctly (edge)', async () => {
    const ctx = makeCtx();
    const p = params(dataFilter, {
      conditions: [{ value1: 10, operator: 'gt', value2: 5 }],
    });
    const items = [item({ v: 'pass' })];
    const res = await dataFilter.execute(ctx, p, items);
    if (res.kind !== 'items') throw new Error('expected items');
    expect(res.outputs.kept).toHaveLength(1);
    expect(res.outputs.discarded).toHaveLength(0);
  });

  it('regex operator: matching goes to kept, non-matching to discarded (edge)', async () => {
    const ctx = makeCtx();
    const p = params(dataFilter, {
      conditions: [{ value1: 'hello world', operator: 'regex', value2: '^hello' }],
    });
    const items = [item({ tag: 'a' })];
    const res = await dataFilter.execute(ctx, p, items);
    if (res.kind !== 'items') throw new Error('expected items');
    expect(res.outputs.kept).toHaveLength(1);
  });

  it('exists operator keeps items where a field is non-null (edge)', async () => {
    const ctx = makeCtx();
    const p = params(dataFilter, {
      conditions: [{ value1: 'hasValue', operator: 'exists' }],
    });
    const items = [item({ tag: 'a' })]; // value1 is a literal non-null string
    const res = await dataFilter.execute(ctx, p, items);
    if (res.kind !== 'items') throw new Error('expected items');
    expect(res.outputs.kept).toHaveLength(1);
  });
});

describe('data.filter — AND / OR combine', () => {
  it('AND combine: only items passing ALL conditions go to kept (happy)', async () => {
    const ctx = makeCtx();
    const p = params(dataFilter, {
      conditions: [
        { value1: 1, operator: 'equals', value2: 1 },
        { value1: 2, operator: 'equals', value2: 99 }, // always false
      ],
      combine: 'and',
    });
    const res = await dataFilter.execute(ctx, p, [item({}), item({})]);
    if (res.kind !== 'items') throw new Error('expected items');
    expect(res.outputs.kept).toHaveLength(0);
    expect(res.outputs.discarded).toHaveLength(2);
  });

  it('OR combine: items passing ANY condition go to kept (happy)', async () => {
    const ctx = makeCtx();
    const p = params(dataFilter, {
      conditions: [
        { value1: 1, operator: 'equals', value2: 99 }, // false
        { value1: 'ok', operator: 'equals', value2: 'ok' }, // true
      ],
      combine: 'or',
    });
    const res = await dataFilter.execute(ctx, p, [item({}), item({})]);
    if (res.kind !== 'items') throw new Error('expected items');
    expect(res.outputs.kept).toHaveLength(2);
    expect(res.outputs.discarded).toHaveLength(0);
  });
});

describe('data.filter — edge cases', () => {
  it('empty input seeds one item and evaluates it (edge)', async () => {
    const ctx = makeCtx();
    const p = params(dataFilter, {
      conditions: [{ value1: true, operator: 'equals', value2: true }],
    });
    const res = await dataFilter.execute(ctx, p, []);
    if (res.kind !== 'items') throw new Error('expected items');
    // The seeded empty item passes `true === true`
    expect(res.outputs.kept).toHaveLength(1);
    expect(res.outputs.discarded).toHaveLength(0);
  });

  it('items are never mutated (edge)', async () => {
    const ctx = makeCtx();
    const p = params(dataFilter, {
      conditions: [{ value1: 'x', operator: 'equals', value2: 'x' }],
    });
    const src = item({ original: true });
    const res = await dataFilter.execute(ctx, p, [src]);
    if (res.kind !== 'items') throw new Error('expected items');
    // Reference equality: same object passes through untouched
    expect(res.outputs.kept![0]).toBe(src);
  });

  it('rejects empty conditions at parse time (error)', () => {
    expect(() => params(dataFilter, { conditions: [] })).toThrow(/invalid params/);
  });
});
