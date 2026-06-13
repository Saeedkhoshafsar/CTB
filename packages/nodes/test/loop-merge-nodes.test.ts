/**
 * P3-T2 contract tests — flow.loop + flow.merge (n8n semantics).
 *
 * flow.loop mirrors n8n `splitInBatches`: a fresh entry stashes all items and
 * emits the first batch on `loop`; each loop-back emits the next batch; once the
 * batches run out it emits ALL originals on `done` and clears its per-node state.
 * The incoming items on a loop-back are the processed batch and are ignored.
 *
 * flow.merge combines two input branches read from `ctx.inputsByPort`:
 *   append → pass each branch straight through; wait_both → buffer the first
 *   side until the other arrives then emit together (input1 first); choose_first
 *   → emit the first branch and latch, ignoring later activations.
 */
import { describe, expect, it } from 'vitest';
import {
  flowLoop,
  flowMerge,
  LOOP_STATE_PREFIX,
  MERGE_STATE_PREFIX,
  registerBuiltinNodes,
} from '@ctb/nodes';
import { NodeRegistry } from '@ctb/core';
import type { FlowItem } from '@ctb/shared';
import { item, makeCtx, params } from './node-harness';

/** Pull a port's items out of an `items` result, asserting the kind. */
function port(res: Awaited<ReturnType<typeof flowLoop.execute>>, name: string): FlowItem[] | undefined {
  if (res.kind !== 'items') throw new Error(`expected items, got ${res.kind}`);
  return res.outputs[name];
}

describe('flow.loop (splitInBatches)', () => {
  it('batch_size 1: emits one item at a time, then done with all (happy)', async () => {
    const ctx = makeCtx({ nodeId: 'loopA' });
    const all = [item({ n: 1 }), item({ n: 2 }), item({ n: 3 })];
    const p = params(flowLoop, { batch_size: 1 });

    // fresh entry → first batch on loop
    let res = await flowLoop.execute(ctx, p, all);
    expect(port(res, 'loop')).toEqual([item({ n: 1 })]);
    expect(port(res, 'done')).toBeUndefined();

    // loop-back (incoming items are the processed batch — ignored) → batch 2
    res = await flowLoop.execute(ctx, p, [item({ processed: 1 })]);
    expect(port(res, 'loop')).toEqual([item({ n: 2 })]);

    // batch 3
    res = await flowLoop.execute(ctx, p, [item({ processed: 2 })]);
    expect(port(res, 'loop')).toEqual([item({ n: 3 })]);

    // no batches left → done with ALL originals, state cleared
    res = await flowLoop.execute(ctx, p, [item({ processed: 3 })]);
    expect(port(res, 'done')).toEqual(all);
    expect(port(res, 'loop')).toBeUndefined();
    expect(ctx.varsBag[`${LOOP_STATE_PREFIX}loopA`]).toBeUndefined();
  });

  it('batch_size 2: slices in twos, last batch is the remainder (happy)', async () => {
    const ctx = makeCtx({ nodeId: 'loopB' });
    const all = [item({ n: 1 }), item({ n: 2 }), item({ n: 3 })];
    const p = params(flowLoop, { batch_size: 2 });

    let res = await flowLoop.execute(ctx, p, all);
    expect(port(res, 'loop')).toEqual([item({ n: 1 }), item({ n: 2 })]);

    res = await flowLoop.execute(ctx, p, [item({ x: 1 })]);
    expect(port(res, 'loop')).toEqual([item({ n: 3 })]);

    res = await flowLoop.execute(ctx, p, [item({ x: 1 })]);
    expect(port(res, 'done')).toEqual(all);
  });

  it('empty input goes straight to done with [] (edge)', async () => {
    const ctx = makeCtx({ nodeId: 'loopC' });
    const res = await flowLoop.execute(ctx, params(flowLoop, { batch_size: 1 }), []);
    expect(port(res, 'done')).toEqual([]);
    expect(port(res, 'loop')).toBeUndefined();
    expect(ctx.varsBag[`${LOOP_STATE_PREFIX}loopC`]).toBeUndefined();
  });

  it('reset discards leftover state and starts fresh (edge)', async () => {
    const ctx = makeCtx({ nodeId: 'loopD' });
    // leave abandoned state behind from a prior loop
    ctx.varsBag[`${LOOP_STATE_PREFIX}loopD`] = { all: [item({ stale: 1 })], cursor: 0 };
    const res = await flowLoop.execute(ctx, params(flowLoop, { batch_size: 1, reset: true }), [item({ fresh: 1 })]);
    expect(port(res, 'loop')).toEqual([item({ fresh: 1 })]);
  });

  it('two loop nodes keep independent state (per-node key, edge)', async () => {
    const ctxA = makeCtx({ nodeId: 'loopA' });
    const ctxB = makeCtx({ nodeId: 'loopB' });
    const p = params(flowLoop, { batch_size: 1 });
    await flowLoop.execute(ctxA, p, [item({ a: 1 }), item({ a: 2 })]);
    await flowLoop.execute(ctxB, p, [item({ b: 1 })]);
    expect(ctxA.varsBag[`${LOOP_STATE_PREFIX}loopA`]).toBeDefined();
    expect(ctxA.varsBag[`${LOOP_STATE_PREFIX}loopB`]).toBeUndefined();
    expect(ctxB.varsBag[`${LOOP_STATE_PREFIX}loopB`]).toBeDefined();
  });
});

describe('flow.merge', () => {
  it('append: passes input1 straight through (happy)', async () => {
    const ctx = makeCtx({ nodeId: 'm1', inputsByPort: { input1: [item({ a: 1 })] } });
    const res = await flowMerge.execute(ctx, params(flowMerge, { mode: 'append' }), []);
    expect(port(res, 'main')).toEqual([item({ a: 1 })]);
  });

  it('append: passes input2 straight through (happy)', async () => {
    const ctx = makeCtx({ nodeId: 'm2', inputsByPort: { input2: [item({ b: 1 })] } });
    const res = await flowMerge.execute(ctx, params(flowMerge, { mode: 'append' }), []);
    expect(port(res, 'main')).toEqual([item({ b: 1 })]);
  });

  it('append: both ports in one activation → input1 first (edge)', async () => {
    const ctx = makeCtx({ nodeId: 'm3', inputsByPort: { input1: [item({ a: 1 })], input2: [item({ b: 1 })] } });
    const res = await flowMerge.execute(ctx, params(flowMerge, { mode: 'append' }), []);
    expect(port(res, 'main')).toEqual([item({ a: 1 }), item({ b: 1 })]);
  });

  it('wait_both: first branch buffers (emits nothing), second releases both (happy)', async () => {
    const varsBag: Record<string, unknown> = {};
    // input1 arrives first
    const ctx1 = makeCtx({ nodeId: 'mw', inputsByPort: { input1: [item({ a: 1 })] } });
    Object.assign(ctx1.varsBag, varsBag);
    let res = await flowMerge.execute(ctx1, params(flowMerge, { mode: 'wait_both' }), []);
    expect(port(res, 'main')).toBeUndefined(); // nothing yet
    expect(ctx1.varsBag[`${MERGE_STATE_PREFIX}mw`]).toBeDefined();

    // input2 arrives on a later activation, sharing the SAME vars bag
    const ctx2 = makeCtx({ nodeId: 'mw', inputsByPort: { input2: [item({ b: 1 })] } });
    Object.assign(ctx2.varsBag, ctx1.varsBag);
    res = await flowMerge.execute(ctx2, params(flowMerge, { mode: 'wait_both' }), []);
    expect(port(res, 'main')).toEqual([item({ a: 1 }), item({ b: 1 })]); // input1 first
    expect(ctx2.varsBag[`${MERGE_STATE_PREFIX}mw`]).toBeUndefined(); // state cleared
  });

  it('wait_both: only one branch ever fires → never emits (edge)', async () => {
    const ctx = makeCtx({ nodeId: 'mw2', inputsByPort: { input1: [item({ a: 1 })] } });
    const res = await flowMerge.execute(ctx, params(flowMerge, { mode: 'wait_both' }), []);
    expect(res.kind === 'items' ? res.outputs.main : 'x').toBeUndefined();
  });

  it('choose_first: emits the first branch and latches against the second (happy)', async () => {
    // first activation: input1 wins
    const ctx1 = makeCtx({ nodeId: 'mc', inputsByPort: { input1: [item({ a: 1 })] } });
    let res = await flowMerge.execute(ctx1, params(flowMerge, { mode: 'choose_first' }), []);
    expect(port(res, 'main')).toEqual([item({ a: 1 })]);
    expect(ctx1.varsBag[`${MERGE_STATE_PREFIX}mc`]).toEqual({ fired: true });

    // second activation (input2): latched → emits nothing
    const ctx2 = makeCtx({ nodeId: 'mc', inputsByPort: { input2: [item({ b: 1 })] } });
    Object.assign(ctx2.varsBag, ctx1.varsBag);
    res = await flowMerge.execute(ctx2, params(flowMerge, { mode: 'choose_first' }), []);
    expect(res.kind === 'items' ? res.outputs.main : 'x').toBeUndefined();
  });

  it('choose_first: input2-first activation wins when input1 is absent (edge)', async () => {
    const ctx = makeCtx({ nodeId: 'mc2', inputsByPort: { input2: [item({ b: 1 })] } });
    const res = await flowMerge.execute(ctx, params(flowMerge, { mode: 'choose_first' }), []);
    expect(port(res, 'main')).toEqual([item({ b: 1 })]);
  });

  it('default mode is append (edge)', () => {
    expect(params(flowMerge, {}).mode).toBe('append');
  });
});

describe('registry', () => {
  it('registers both P3-T2 nodes (includes the new types)', () => {
    const reg = registerBuiltinNodes(new NodeRegistry());
    const types = reg.list().map((d) => d.type);
    expect(types).toContain('flow.loop');
    expect(types).toContain('flow.merge');
  });
});
