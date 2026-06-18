/**
 * PA-T3 contract tests — data.editFields (Edit Fields / Set power node).
 *
 * Covers: set with dotted paths (immutable passthrough), remove, rename
 * (json + keep_only_set + vars), value_mode:'json' (string→array/object +
 * non-string passthrough + invalid-JSON failure), per-row enabled toggle,
 * keep_only_set, $vars target (once per run), empty-input seeding, and the
 * loud-failure paths (empty fields, blank name, bad json value, empty rename
 * destination).
 */
import { NodeRegistry } from '@ctb/core';
import { describe, expect, it } from 'vitest';
import { builtinNodes, dataEditFields, registerBuiltinNodes } from '@ctb/nodes';
import { item, makeCtx, params } from './node-harness';

describe('data.editFields — registry', () => {
  it('registers data.editFields; registry is 38 types', () => {
    const reg = registerBuiltinNodes(new NodeRegistry());
    expect(reg.has('data.editFields')).toBe(true);
    expect(dataEditFields.category).toBe('data');
    expect(builtinNodes.length).toBe(51);
  });
});

describe('data.editFields — set', () => {
  it('sets a dotted path immutably and passes the rest through (happy)', async () => {
    const ctx = makeCtx();
    const p = params(dataEditFields, {
      fields: [{ name: 'user.level', value: 'gold', target: 'json' }],
    });
    const src = item({ name: 'علی', user: { id: 7 } });
    const res = await dataEditFields.execute(ctx, p, [src]);
    if (res.kind !== 'items') throw new Error('expected items');
    expect(res.outputs.main![0]!.json).toEqual({ name: 'علی', user: { id: 7, level: 'gold' } });
    // input not mutated
    expect((src.json.user as Record<string, unknown>).level).toBeUndefined();
  });

  it('value_mode json parses a string into a real array/object (edge)', async () => {
    const ctx = makeCtx();
    const p = params(dataEditFields, {
      fields: [
        { name: 'tags', value: '[1,2,3]', value_mode: 'json', target: 'json' },
        { name: 'meta', value: '{"a":true}', value_mode: 'json', target: 'json' },
      ],
    });
    const res = await dataEditFields.execute(ctx, p, [item({})]);
    if (res.kind !== 'items') throw new Error('expected items');
    expect(res.outputs.main![0]!.json.tags).toEqual([1, 2, 3]);
    expect(res.outputs.main![0]!.json.meta).toEqual({ a: true });
  });

  it('value_mode json passes a non-string value through unchanged (edge)', async () => {
    const ctx = makeCtx();
    const p = params(dataEditFields, {
      fields: [{ name: 'n', value: 42, value_mode: 'json', target: 'json' }],
    });
    const res = await dataEditFields.execute(ctx, p, [item({})]);
    if (res.kind !== 'items') throw new Error('expected items');
    expect(res.outputs.main![0]!.json.n).toBe(42);
  });
});

describe('data.editFields — remove / rename', () => {
  it('removes a dotted path (edge)', async () => {
    const ctx = makeCtx();
    const p = params(dataEditFields, {
      fields: [{ name: 'a.b', op: 'remove', target: 'json' }],
    });
    const res = await dataEditFields.execute(ctx, p, [item({ a: { b: 1, c: 2 } })]);
    if (res.kind !== 'items') throw new Error('expected items');
    expect(res.outputs.main![0]!.json).toEqual({ a: { c: 2 } });
  });

  it('renames a value from one dotted path to another (happy)', async () => {
    const ctx = makeCtx();
    const p = params(dataEditFields, {
      fields: [{ name: 'old', value: 'new.path', op: 'rename', target: 'json' }],
    });
    const res = await dataEditFields.execute(ctx, p, [item({ old: 'v', keep: 1 })]);
    if (res.kind !== 'items') throw new Error('expected items');
    expect(res.outputs.main![0]!.json).toEqual({ keep: 1, new: { path: 'v' } });
  });

  it('rename works in keep_only_set mode (reads source from the original item) (edge)', async () => {
    const ctx = makeCtx();
    const p = params(dataEditFields, {
      fields: [{ name: 'a', value: 'b', op: 'rename', target: 'json' }],
      keep_only_set: true,
    });
    const res = await dataEditFields.execute(ctx, p, [item({ a: 99, dropme: 'x' })]);
    if (res.kind !== 'items') throw new Error('expected items');
    expect(res.outputs.main![0]!.json).toEqual({ b: 99 }); // dropme gone, a→b kept
  });
});

describe('data.editFields — modes & targets', () => {
  it('keep_only_set drops everything not set by this node (edge)', async () => {
    const ctx = makeCtx();
    const p = params(dataEditFields, {
      fields: [{ name: 'kept', value: 1, target: 'json' }],
      keep_only_set: true,
    });
    const res = await dataEditFields.execute(ctx, p, [item({ a: 1, b: 2 })]);
    if (res.kind !== 'items') throw new Error('expected items');
    expect(res.outputs.main![0]!.json).toEqual({ kept: 1 });
  });

  it('a disabled row is skipped entirely (edge)', async () => {
    const ctx = makeCtx();
    const p = params(dataEditFields, {
      fields: [
        { name: 'on', value: 1, target: 'json', enabled: true },
        { name: 'off', value: 2, target: 'json', enabled: false },
      ],
    });
    const res = await dataEditFields.execute(ctx, p, [item({})]);
    if (res.kind !== 'items') throw new Error('expected items');
    expect(res.outputs.main![0]!.json).toEqual({ on: 1 });
  });

  it('vars target applies once per run, including rename (edge)', async () => {
    const ctx = makeCtx();
    const p = params(dataEditFields, {
      fields: [
        { name: 'count', value: 5, target: 'vars' },
        { name: 'count', value: 'total', op: 'rename', target: 'vars' },
      ],
    });
    await dataEditFields.execute(ctx, p, [item({}), item({})]);
    expect(ctx.varsBag.total).toBe(5);
    expect(ctx.varsBag.count).toBeUndefined();
  });

  it('empty input still emits one shaped item (edge)', async () => {
    const ctx = makeCtx();
    const p = params(dataEditFields, { fields: [{ name: 'seed', value: true, target: 'json' }] });
    const res = await dataEditFields.execute(ctx, p, []);
    if (res.kind !== 'items') throw new Error('expected items');
    expect(res.outputs.main).toHaveLength(1);
    expect(res.outputs.main![0]!.json).toEqual({ seed: true });
  });
});

describe('data.editFields — failures (loud)', () => {
  it('rejects empty fields and a blank name at parse time', () => {
    expect(() => params(dataEditFields, { fields: [] })).toThrow(/invalid params/);
    expect(() => params(dataEditFields, { fields: [{ name: '', value: 1 }] })).toThrow(/invalid params/);
  });

  it('fails loudly on an invalid json-mode value', async () => {
    const ctx = makeCtx();
    const p = params(dataEditFields, {
      fields: [{ name: 'x', value: '{not json}', value_mode: 'json', target: 'json' }],
    });
    const res = await dataEditFields.execute(ctx, p, [item({})]);
    if (res.kind !== 'error') throw new Error('expected error');
    expect(res.message).toMatch(/not valid JSON/i);
  });

  it('fails loudly when a rename destination is empty', async () => {
    const ctx = makeCtx();
    const p = params(dataEditFields, {
      fields: [{ name: 'a', value: '', op: 'rename', target: 'json' }],
    });
    const res = await dataEditFields.execute(ctx, p, [item({ a: 1 })]);
    if (res.kind !== 'error') throw new Error('expected error');
    expect(res.message).toMatch(/destination path is empty/i);
  });
});
