/**
 * P1-T7 contract tests — flow.if, data.setFields, flow.stopError
 * (≥3 each: happy / edge / error) + registry registration smoke.
 */
import { NodeRegistry } from '@ctb/core';
import { describe, expect, it } from 'vitest';
import { builtinNodes, dataSetFields, flowIf, flowStopError, parseDuration, registerBuiltinNodes } from '@ctb/nodes';
import { item, makeCtx, params } from './node-harness';

describe('flow.if', () => {
  it('routes items per condition with numeric-aware equals/gte (happy)', async () => {
    const ctx = makeCtx();
    const p = params(flowIf, { conditions: [{ value1: '18', operator: 'gte', value2: 18 }] });
    const res = await flowIf.execute(ctx, p, [item({ age: 18 })]);
    if (res.kind !== 'items') throw new Error('expected items');
    expect(res.outputs.true).toHaveLength(1);
    expect(res.outputs.false).toHaveLength(0);
  });

  it('AND vs OR combine (edge)', async () => {
    const ctx = makeCtx();
    const conditions = [
      { value1: 'علی', operator: 'equals', value2: 'علی' },
      { value1: '5', operator: 'lt', value2: '3' },
    ];
    const rAnd = await flowIf.execute(ctx, params(flowIf, { combine: 'and', conditions }), [item({})]);
    if (rAnd.kind !== 'items') throw new Error('expected items');
    expect(rAnd.outputs.false).toHaveLength(1);

    const rOr = await flowIf.execute(ctx, params(flowIf, { combine: 'or', conditions }), [item({})]);
    if (rOr.kind !== 'items') throw new Error('expected items');
    expect(rOr.outputs.true).toHaveLength(1);
  });

  it('operator matrix: contains/regex/exists/is_empty/notEquals (edge)', async () => {
    const ctx = makeCtx();
    const run = async (value1: unknown, operator: string, value2?: unknown) => {
      const p = params(flowIf, { conditions: [{ value1, operator, value2 }] });
      const r = await flowIf.execute(ctx, p, [item({})]);
      if (r.kind !== 'items') throw new Error('expected items');
      return r.outputs.true!.length === 1;
    };
    expect(await run('سلام دنیا', 'contains', 'دنیا')).toBe(true);
    expect(await run(['a', 'b'], 'contains', 'b')).toBe(true);
    expect(await run('user42', 'regex', '^user\\d+$')).toBe(true);
    expect(await run('x', 'regex', '[invalid(')).toBe(false); // bad regex never throws
    expect(await run(0, 'exists')).toBe(true);
    expect(await run(null, 'exists')).toBe(false);
    expect(await run('', 'is_empty')).toBe(true);
    expect(await run([], 'is_empty')).toBe(true);
    expect(await run({}, 'is_empty')).toBe(true);
    expect(await run('x', 'is_empty')).toBe(false);
    expect(await run('a', 'notEquals', 'b')).toBe(true);
    expect(await run('abc', 'gt', '2')).toBe(false); // non-numeric side → false
  });

  it('rejects empty conditions / unknown operator (error)', () => {
    expect(() => params(flowIf, { conditions: [] })).toThrow(/invalid params/);
    expect(() => params(flowIf, { conditions: [{ value1: 1, operator: 'like', value2: 1 }] })).toThrow(/invalid params/);
  });
});

describe('data.setFields', () => {
  it('sets json fields per item without mutating input (happy)', async () => {
    const ctx = makeCtx();
    const p = params(dataSetFields, {
      fields: [
        { name: 'greeting', value: 'سلام', target: 'json' },
        { name: 'user.level', value: 3, target: 'json' },
      ],
    });
    const input = [item({ name: 'علی', user: { id: 9 } })];
    const res = await dataSetFields.execute(ctx, p, input);
    if (res.kind !== 'items') throw new Error('expected items');
    expect(res.outputs.main![0]!.json).toEqual({
      name: 'علی',
      greeting: 'سلام',
      user: { id: 9, level: 3 },
    });
    expect(input[0]!.json).toEqual({ name: 'علی', user: { id: 9 } }); // untouched
  });

  it('vars target writes $vars; remove + keep_only_set shape json (edge)', async () => {
    const ctx = makeCtx();
    const p = params(dataSetFields, {
      fields: [
        { name: 'step', value: 'done', target: 'vars' },
        { name: 'keepme', value: 1, target: 'json' },
      ],
      keep_only_set: true,
    });
    const res = await dataSetFields.execute(ctx, p, [item({ junk: 'x', other: 'y' })]);
    if (res.kind !== 'items') throw new Error('expected items');
    expect(res.outputs.main![0]!.json).toEqual({ keepme: 1 }); // keep_only_set dropped the rest
    expect(ctx.varsBag.step).toBe('done');

    const rm = params(dataSetFields, { fields: [{ name: 'a.b', op: 'remove', target: 'json' }] });
    const r2 = await dataSetFields.execute(ctx, rm, [item({ a: { b: 1, c: 2 } })]);
    if (r2.kind !== 'items') throw new Error('expected items');
    expect(r2.outputs.main![0]!.json).toEqual({ a: { c: 2 } });
  });

  it('empty input still emits one shaped item (edge)', async () => {
    const ctx = makeCtx();
    const p = params(dataSetFields, { fields: [{ name: 'x', value: 1, target: 'json' }] });
    const res = await dataSetFields.execute(ctx, p, []);
    if (res.kind !== 'items') throw new Error('expected items');
    expect(res.outputs.main).toEqual([{ json: { x: 1 } }]);
  });

  it('rejects empty rows / empty name (error)', () => {
    expect(() => params(dataSetFields, { fields: [] })).toThrow(/invalid params/);
    expect(() => params(dataSetFields, { fields: [{ name: '', value: 1 }] })).toThrow(/invalid params/);
  });
});

describe('flow.stopError', () => {
  it('returns error result with the message (happy)', async () => {
    const ctx = makeCtx();
    const res = await flowStopError.execute(ctx, params(flowStopError, { message: 'سن نامعتبر' }), []);
    expect(res).toEqual({ kind: 'error', message: 'سن نامعتبر' });
    expect(ctx.sent).toHaveLength(0); // notify_user defaults false
  });

  it('notify_user sends the message to the chat first (edge)', async () => {
    const ctx = makeCtx();
    const res = await flowStopError.execute(ctx, params(flowStopError, { message: 'خطا!', notify_user: true }), []);
    expect(ctx.sent[0]!.opts).toMatchObject({ chat_id: 777, text: 'خطا!' });
    expect(res).toMatchObject({ kind: 'error' });
  });

  it('sender failure / missing chat never masks the error (error)', async () => {
    const noTg = makeCtx({ tg: null });
    const r1 = await flowStopError.execute(noTg, params(flowStopError, { message: 'boom', notify_user: true }), []);
    expect(r1).toEqual({ kind: 'error', message: 'boom' });

    const ctx = makeCtx();
    ctx.tg = { sendMessage: async () => { throw new Error('network down'); } };
    const r2 = await flowStopError.execute(ctx, params(flowStopError, { message: 'boom', notify_user: true }), []);
    expect(r2).toEqual({ kind: 'error', message: 'boom' });
    expect(ctx.logs.some((l) => l.level === 'warn')).toBe(true);

    expect(() => params(flowStopError, { message: '' })).toThrow(/invalid params/);
  });
});

describe('registry + helpers', () => {
  it('registerBuiltinNodes registers all six wave-1 types', () => {
    const reg = registerBuiltinNodes(new NodeRegistry());
    for (const t of ['tg.trigger', 'tg.sendMessage', 'tg.waitForReply', 'flow.if', 'data.setFields', 'flow.stopError']) {
      expect(reg.has(t)).toBe(true);
    }
    expect(builtinNodes).toHaveLength(6);
  });

  it('parseDuration handles every documented unit and rejects garbage', () => {
    expect(parseDuration('500ms')).toBe(500);
    expect(parseDuration('30s')).toBe(30_000);
    expect(parseDuration('15m')).toBe(900_000);
    expect(parseDuration('2h')).toBe(7_200_000);
    expect(parseDuration('7d')).toBe(604_800_000);
    expect(() => parseDuration('soon')).toThrow(/invalid duration/);
  });
});
