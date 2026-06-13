/**
 * P3-T1 contract tests — flow.executeSubFlow + flow.return.
 *
 * Covers the behavioural contract the host depends on: wait-mode item passing
 * (parent → child → parent), fire-and-forget pass-through, flow.return parking
 * its items in the reserved $vars key, and the guards (no self-call, missing
 * capability, child failure surfaced). The recursion-depth cap itself is
 * enforced host-side and is exercised in the server integration test.
 */
import { describe, expect, it } from 'vitest';
import {
  flowExecuteSubFlow,
  flowReturn,
  registerBuiltinNodes,
  SUBFLOW_RETURN_VAR,
} from '@ctb/nodes';
import { NodeRegistry } from '@ctb/core';
import { item, makeCtx, params } from './node-harness';

describe('flow.return', () => {
  it('parks received items in the reserved $vars key and ends (happy)', async () => {
    const ctx = makeCtx();
    const items = [item({ name: 'علی' }), item({ name: 'Sara' })];
    const res = await flowReturn.execute(ctx, params(flowReturn, {}), items);
    expect(res.kind).toBe('end');
    expect(ctx.varsBag[SUBFLOW_RETURN_VAR]).toEqual(items);
  });

  it('parks an independent copy — later mutation does not leak (edge)', async () => {
    const ctx = makeCtx();
    const items = [item({ n: 1 })];
    await flowReturn.execute(ctx, params(flowReturn, {}), items);
    (items[0]!.json as Record<string, unknown>).n = 999;
    expect((ctx.varsBag[SUBFLOW_RETURN_VAR] as typeof items)[0]!.json.n).toBe(1);
  });

  it('returning zero items parks an empty array (edge)', async () => {
    const ctx = makeCtx();
    const res = await flowReturn.execute(ctx, params(flowReturn, {}), []);
    expect(res.kind).toBe('end');
    expect(ctx.varsBag[SUBFLOW_RETURN_VAR]).toEqual([]);
  });
});

describe('flow.executeSubFlow', () => {
  it('wait mode: emits the child’s returned items on main (happy)', async () => {
    const ctx = makeCtx({
      subflowRun: async (_flowId, items) => ({ items: [...items, item({ added: true })] }),
    });
    const p = params(flowExecuteSubFlow, { flow_id: 'child-flow', mode: 'wait' });
    const res = await flowExecuteSubFlow.execute(ctx, p, [item({ x: 1 })]);
    if (res.kind !== 'items') throw new Error('expected items');
    expect(res.outputs.main).toHaveLength(2);
    expect(res.outputs.main![1]!.json).toEqual({ added: true });
    expect(ctx.subflowCalls).toEqual([{ flowId: 'child-flow', items: [item({ x: 1 })] }]);
  });

  it('wait mode default: `mode` omitted behaves as wait (edge)', async () => {
    const ctx = makeCtx({ subflowRun: async () => ({ items: [item({ ok: 1 })] }) });
    const p = params(flowExecuteSubFlow, { flow_id: 'child-flow' });
    expect(p.mode).toBe('wait');
    const res = await flowExecuteSubFlow.execute(ctx, p, [item({})]);
    if (res.kind !== 'items') throw new Error('expected items');
    expect(res.outputs.main![0]!.json).toEqual({ ok: 1 });
  });

  it('fire_and_forget: passes input through unchanged, still calls the child (happy)', async () => {
    let resolveChild!: () => void;
    const childDone = new Promise<void>((r) => (resolveChild = r));
    const ctx = makeCtx({
      subflowRun: async (_flowId, items) => {
        resolveChild();
        return { items: [...items, item({ shouldNotAppear: true })] };
      },
    });
    const p = params(flowExecuteSubFlow, { flow_id: 'child-flow', mode: 'fire_and_forget' });
    const input = [item({ keep: 'me' })];
    const res = await flowExecuteSubFlow.execute(ctx, p, input);
    if (res.kind !== 'items') throw new Error('expected items');
    // Output is the INPUT, not the child's result.
    expect(res.outputs.main).toEqual(input);
    await childDone; // the child was still started
    expect(ctx.subflowCalls).toHaveLength(1);
  });

  it('fire_and_forget: a child rejection is swallowed + logged, not thrown (edge)', async () => {
    const ctx = makeCtx({ subflowRun: async () => { throw new Error('boom'); } });
    const p = params(flowExecuteSubFlow, { flow_id: 'child-flow', mode: 'fire_and_forget' });
    const res = await flowExecuteSubFlow.execute(ctx, p, [item({})]);
    expect(res.kind).toBe('items'); // never surfaces as a node error
    await new Promise((r) => setTimeout(r, 0)); // let the detached .catch run
    expect(ctx.logs.some((l) => l.level === 'warn' && /child flow failed/.test(l.message))).toBe(true);
  });

  it('wait mode: a child failure surfaces as a node error (error)', async () => {
    const ctx = makeCtx({ subflowRun: async () => { throw new Error('child blew up'); } });
    const p = params(flowExecuteSubFlow, { flow_id: 'child-flow', mode: 'wait' });
    const res = await flowExecuteSubFlow.execute(ctx, p, [item({})]);
    if (res.kind !== 'error') throw new Error('expected error');
    expect(res.message).toMatch(/child blew up/);
  });

  it('rejects a direct self-call (error)', async () => {
    const ctx = makeCtx(); // ctx.flowId === 'flow1'
    const p = params(flowExecuteSubFlow, { flow_id: 'flow1', mode: 'wait' });
    const res = await flowExecuteSubFlow.execute(ctx, p, [item({})]);
    if (res.kind !== 'error') throw new Error('expected error');
    expect(res.message).toMatch(/cannot call itself/);
    expect(ctx.subflowCalls).toHaveLength(0);
  });

  it('fails cleanly when sub-flow execution is unavailable (error)', async () => {
    const ctx = makeCtx({ subflowRun: null }); // ctx.subflow === null
    const p = params(flowExecuteSubFlow, { flow_id: 'child-flow', mode: 'wait' });
    const res = await flowExecuteSubFlow.execute(ctx, p, [item({})]);
    if (res.kind !== 'error') throw new Error('expected error');
    expect(res.message).toMatch(/not available/);
  });

  it('rejects empty flow_id at the schema (error)', () => {
    expect(() => params(flowExecuteSubFlow, { flow_id: '', mode: 'wait' })).toThrow(/invalid params/);
  });
});

describe('registry', () => {
  it('registers the P3-T1 nodes (includes the new types)', () => {
    const reg = registerBuiltinNodes(new NodeRegistry());
    const types = reg.list().map((d) => d.type);
    expect(types).toContain('flow.executeSubFlow');
    expect(types).toContain('flow.return');
  });
});
