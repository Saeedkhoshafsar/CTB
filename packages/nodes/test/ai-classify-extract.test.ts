/**
 * ai.classify + ai.extract contract tests (P5-T2, NODES.md §AI nodes).
 *
 * Both are generic LLM primitives over the injected ctx.ai capability
 * (invariants I2/I6/I7 — the node never sees the provider key; it passes a
 * credentialId and the HOST resolves it). We drive them against the fake ai
 * capability from node-harness and assert the NODES.md contract:
 *
 *   ai.classify — one LLM call routes the whole batch to the chosen category's
 *     port (dynamic ports = one per category + `other`); unrecognized/empty
 *     reply → `other`; tolerant matching (case / punctuation / token);
 *     result merged under save_as; runs once per node run; no-ai fails loudly.
 *
 *   ai.extract — returns a JSON object matching the configured fields; coerces
 *     types; drops unknown keys; missing optional → null; retries on bad JSON /
 *     missing required field and succeeds on a later attempt; fails after
 *     max_retries+1 attempts; result merged under save_as; no-ai fails loudly.
 */
import { NodeRegistry } from '@ctb/core';
import { classifyOutputs, dynamicOutputPorts } from '@ctb/shared';
import { describe, expect, it } from 'vitest';
import { aiClassify, aiExtract, builtinNodes, registerBuiltinNodes } from '../src/index';
import { item, makeCtx, params } from './node-harness';

describe('registry (P5-T2)', () => {
  it('registers ai.classify + ai.extract; registry is 38 types', () => {
    const reg = registerBuiltinNodes(new NodeRegistry());
    expect(reg.has('ai.classify')).toBe(true);
    expect(reg.has('ai.extract')).toBe(true);
    expect(builtinNodes.length).toBe(42);
  });

  it('ai.classify is an `ai` node with dynamic ports; ai.extract main → main', () => {
    expect(aiClassify.category).toBe('ai');
    expect(aiClassify.ports.inputs).toEqual(['main']);
    expect(aiExtract.category).toBe('ai');
    expect(aiExtract.ports).toEqual({ inputs: ['main'], outputs: ['main'] });
  });
});

// ── ai.classify ──────────────────────────────────────────────────────────────

const classifyParams = {
  credentialId: 'cred1',
  model: 'gpt-4o-mini',
  input: 'I want my money back',
  categories: [
    { key: 'order', description: 'placing or asking about an order' },
    { key: 'refund', description: 'wants a refund or money back' },
    { key: 'support', description: 'technical help' },
  ],
};

describe('ai.classify — dynamic output ports', () => {
  it('exposes one port per category plus `other` (shared classifyOutputs)', () => {
    const p = params(aiClassify, classifyParams);
    expect(classifyOutputs(p)).toEqual(['order', 'refund', 'support', 'other']);
    expect(aiClassify.dynamicOutputs!(p)).toEqual(['order', 'refund', 'support', 'other']);
  });

  it('the editor-side dynamicOutputPorts mirror agrees (draft-tolerant)', () => {
    expect(dynamicOutputPorts('ai.classify', classifyParams)).toEqual([
      'order',
      'refund',
      'support',
      'other',
    ]);
    // Draft-tolerant: a half-typed category row is skipped, ports still grow.
    expect(dynamicOutputPorts('ai.classify', { categories: [{ key: 'a' }, { key: '' }, {}] })).toEqual([
      'a',
      'other',
    ]);
  });
});

describe('ai.classify — routing (happy path)', () => {
  it('routes the batch to the category the model returns', async () => {
    const ctx = makeCtx({ aiResponses: [{ reply: 'refund' }] });
    const res = await aiClassify.execute(ctx, params(aiClassify, classifyParams), [item({ a: 1 }), item({ a: 2 })]);
    if (res.kind !== 'items') throw new Error('expected items');

    // One LLM call for the whole batch.
    expect(ctx.aiCalls.length).toBe(1);
    // The chosen port carries both items; every other port is present + empty.
    expect(res.outputs.refund!.length).toBe(2);
    expect(res.outputs.order).toEqual([]);
    expect(res.outputs.support).toEqual([]);
    expect(res.outputs.other).toEqual([]);
    // Result merged under save_as (default `classification`).
    expect((res.outputs.refund![0]!.json as { classification: { category: string } }).classification).toEqual({
      category: 'refund',
    });
  });

  it('sends the categories + input to the model as system + user messages', async () => {
    const ctx = makeCtx({ aiResponses: [{ reply: 'order' }] });
    await aiClassify.execute(ctx, params(aiClassify, classifyParams), [item({})]);
    const call = ctx.aiCalls[0]!;
    expect(call.credentialId).toBe('cred1');
    expect(call.messages[0]!.role).toBe('system');
    expect(call.messages[0]!.content).toContain('refund');
    expect(call.messages[0]!.content).toContain('wants a refund or money back');
    expect(call.messages[1]).toEqual({ role: 'user', content: 'I want my money back' });
  });

  it('honors a custom save_as and prepends the optional system_prompt', async () => {
    const ctx = makeCtx({ aiResponses: [{ reply: 'support' }] });
    const res = await aiClassify.execute(
      ctx,
      params(aiClassify, { ...classifyParams, system_prompt: 'You triage tickets.', save_as: 'intent' }),
      [item({})],
    );
    if (res.kind !== 'items') throw new Error('expected items');
    expect(ctx.aiCalls[0]!.messages[0]!.content.startsWith('You triage tickets.')).toBe(true);
    expect((res.outputs.support![0]!.json as { intent: { category: string } }).intent.category).toBe('support');
  });
});

describe('ai.classify — tolerant matching + fallback', () => {
  it('matches case-insensitively and strips surrounding punctuation/quotes', async () => {
    const ctx = makeCtx({ aiResponses: [{ reply: '"Refund".' }] });
    const res = await aiClassify.execute(ctx, params(aiClassify, classifyParams), [item({})]);
    if (res.kind !== 'items') throw new Error('expected items');
    expect(res.outputs.refund!.length).toBe(1);
  });

  it('matches a key that appears as a whole token in a wordier reply', async () => {
    const ctx = makeCtx({ aiResponses: [{ reply: 'Category: support' }] });
    const res = await aiClassify.execute(ctx, params(aiClassify, classifyParams), [item({})]);
    if (res.kind !== 'items') throw new Error('expected items');
    expect(res.outputs.support!.length).toBe(1);
  });

  it('falls through to `other` on an unrecognized/empty reply', async () => {
    const ctx = makeCtx({ aiResponses: [{ reply: 'no idea honestly' }] });
    const res = await aiClassify.execute(ctx, params(aiClassify, classifyParams), [item({})]);
    if (res.kind !== 'items') throw new Error('expected items');
    expect(res.outputs.other!.length).toBe(1);
    expect((res.outputs.other![0]!.json as { classification: { category: string } }).classification.category).toBe(
      'other',
    );
  });

  it('runs once per node run (one call for N items)', async () => {
    const ctx = makeCtx({ aiResponses: [{ reply: 'order' }] });
    const res = await aiClassify.execute(ctx, params(aiClassify, classifyParams), [item({}), item({}), item({})]);
    if (res.kind !== 'items') throw new Error('expected items');
    expect(ctx.aiCalls.length).toBe(1);
    expect(res.outputs.order!.length).toBe(3);
  });
});

describe('ai.classify — failure modes', () => {
  it('fails loudly when no AI service is wired', async () => {
    const ctx = makeCtx({ aiResponses: null });
    const res = await aiClassify.execute(ctx, params(aiClassify, classifyParams), [item({})]);
    expect(res.kind).toBe('error');
  });

  it('surfaces an upstream chat() rejection as a node error', async () => {
    const ctx = makeCtx({ aiResponses: [{ reply: 'order' }] });
    // Make chat throw.
    ctx.ai = {
      async chat() {
        throw new Error('provider 500');
      },
    };
    const res = await aiClassify.execute(ctx, params(aiClassify, classifyParams), [item({})]);
    expect(res.kind).toBe('error');
    if (res.kind !== 'error') throw new Error('expected error');
    expect(res.message).toContain('provider 500');
  });
});

// ── ai.extract ───────────────────────────────────────────────────────────────

const extractParams = {
  credentialId: 'cred1',
  model: 'gpt-4o-mini',
  input: 'My name is Sara and I am 30, premium: yes',
  fields: [
    { name: 'name', type: 'string', description: 'the person name', required: true },
    { name: 'age', type: 'number', description: 'their age' },
    { name: 'premium', type: 'boolean', description: 'premium customer?' },
  ],
};

describe('ai.extract — happy path', () => {
  it('parses the JSON, coerces types and lands it under save_as', async () => {
    const ctx = makeCtx({
      aiResponses: [{ reply: '{"name":"Sara","age":"30","premium":"yes","extra":"drop me"}' }],
    });
    const res = await aiExtract.execute(ctx, params(aiExtract, extractParams), [item({ x: 1 })]);
    if (res.kind !== 'items') throw new Error('expected items');
    expect(ctx.aiCalls.length).toBe(1);
    expect(res.outputs.main!.length).toBe(1);
    const extracted = (res.outputs.main![0]!.json as { extracted: Record<string, unknown> }).extracted;
    // "30" → 30 (number), "yes" → true (boolean), unknown key dropped, passthrough kept.
    expect(extracted).toEqual({ name: 'Sara', age: 30, premium: true });
    expect((res.outputs.main![0]!.json as { x: number }).x).toBe(1);
  });

  it('strips a ```json code fence and surrounding prose', async () => {
    const ctx = makeCtx({
      aiResponses: [{ reply: 'Sure! Here you go:\n```json\n{"name":"Bo","age":5}\n```\nHope that helps.' }],
    });
    const res = await aiExtract.execute(ctx, params(aiExtract, extractParams), [item({})]);
    if (res.kind !== 'items') throw new Error('expected items');
    const extracted = (res.outputs.main![0]!.json as { extracted: Record<string, unknown> }).extracted;
    expect(extracted.name).toBe('Bo');
    expect(extracted.age).toBe(5);
  });

  it('fills a missing optional field with null', async () => {
    const ctx = makeCtx({ aiResponses: [{ reply: '{"name":"Sara"}' }] });
    const res = await aiExtract.execute(ctx, params(aiExtract, extractParams), [item({})]);
    if (res.kind !== 'items') throw new Error('expected items');
    const extracted = (res.outputs.main![0]!.json as { extracted: Record<string, unknown> }).extracted;
    expect(extracted).toEqual({ name: 'Sara', age: null, premium: null });
  });

  it('writes the extracted object onto every output item but calls once', async () => {
    const ctx = makeCtx({ aiResponses: [{ reply: '{"name":"X"}' }] });
    const res = await aiExtract.execute(ctx, params(aiExtract, extractParams), [item({ i: 1 }), item({ i: 2 })]);
    if (res.kind !== 'items') throw new Error('expected items');
    expect(ctx.aiCalls.length).toBe(1);
    expect(res.outputs.main!.length).toBe(2);
    for (const it of res.outputs.main!) {
      expect((it.json as { extracted: { name: string } }).extracted.name).toBe('X');
    }
  });
});

describe('ai.extract — retries', () => {
  it('re-asks on invalid JSON and succeeds on a later attempt', async () => {
    const ctx = makeCtx({
      aiResponses: [{ reply: 'not json at all' }, { reply: '{"name":"Sara","age":30}' }],
    });
    const res = await aiExtract.execute(ctx, params(aiExtract, extractParams), [item({})]);
    if (res.kind !== 'items') throw new Error('expected items');
    expect(ctx.aiCalls.length).toBe(2); // first failed, second succeeded
    const extracted = (res.outputs.main![0]!.json as { extracted: Record<string, unknown> }).extracted;
    expect(extracted.name).toBe('Sara');
    // The retry message tells the model what went wrong.
    expect(ctx.aiCalls[1]!.messages.some((m) => m.content.includes('rejected'))).toBe(true);
  });

  it('re-asks when a required field is missing, then accepts', async () => {
    const ctx = makeCtx({
      aiResponses: [{ reply: '{"age":30}' }, { reply: '{"name":"Sara","age":30}' }],
    });
    const res = await aiExtract.execute(ctx, params(aiExtract, extractParams), [item({})]);
    if (res.kind !== 'items') throw new Error('expected items');
    expect(ctx.aiCalls.length).toBe(2);
    expect((res.outputs.main![0]!.json as { extracted: { name: string } }).extracted.name).toBe('Sara');
  });

  it('fails after max_retries+1 attempts of invalid JSON', async () => {
    const ctx = makeCtx({ aiResponses: [{ reply: 'nope' }] }); // last response repeats
    const res = await aiExtract.execute(
      ctx,
      params(aiExtract, { ...extractParams, max_retries: 2 }),
      [item({})],
    );
    expect(res.kind).toBe('error');
    expect(ctx.aiCalls.length).toBe(3); // 1 + 2 retries
  });
});

describe('ai.extract — failure modes', () => {
  it('fails loudly when no AI service is wired', async () => {
    const ctx = makeCtx({ aiResponses: null });
    const res = await aiExtract.execute(ctx, params(aiExtract, extractParams), [item({})]);
    expect(res.kind).toBe('error');
  });

  it('surfaces an upstream chat() rejection as a node error (no retry on transport error)', async () => {
    const ctx = makeCtx({ aiResponses: [{ reply: '{}' }] });
    ctx.ai = {
      async chat() {
        throw new Error('network down');
      },
    };
    const res = await aiExtract.execute(ctx, params(aiExtract, extractParams), [item({})]);
    expect(res.kind).toBe('error');
    if (res.kind !== 'error') throw new Error('expected error');
    expect(res.message).toContain('network down');
  });
});
