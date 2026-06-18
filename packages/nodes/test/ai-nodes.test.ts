/**
 * ai.llmChat contract tests (P5-T1, NODES.md §AI nodes).
 *
 * ai.llmChat is a generic LLM primitive over the injected ctx.ai capability
 * (invariants I2/I6/I7 — the node never sees the provider key; it passes a
 * credentialId and the HOST resolves it). We drive the node against the fake
 * ai capability from node-harness and assert the NODES.md contract:
 *   - request shape (credentialId/model/messages/temperature/max_tokens),
 *   - result merged onto EVERY output item under save_as,
 *   - runs ONCE per node run (one LLM call for N items),
 *   - system prompt prepended only when non-empty,
 *   - memory=conversation round-trips through KV (load prior turns, persist,
 *     window-trim), scoped per-node, and memory=none touches no KV,
 *   - failure modes: no ai context, and an upstream chat() rejection.
 */
import { NodeRegistry } from '@ctb/core';
import { describe, expect, it } from 'vitest';
import { AI_MEMORY_KEY_PREFIX, aiLlmChat, builtinNodes, registerBuiltinNodes } from '../src/index';
import { item, makeCtx, params } from './node-harness';

describe('registry (P5-T1)', () => {
  it('registers ai.llmChat; registry is 38 types', () => {
    const reg = registerBuiltinNodes(new NodeRegistry());
    expect(reg.has('ai.llmChat')).toBe(true);
    expect(builtinNodes.length).toBe(51);
  });

  it('is an `ai` node with main → main ports', () => {
    expect(aiLlmChat.category).toBe('ai');
    expect(aiLlmChat.ports).toEqual({ inputs: ['main'], outputs: ['main'] });
  });
});

describe('ai.llmChat — request + result (happy path)', () => {
  it('sends one well-formed request and merges the reply onto the item', async () => {
    const ctx = makeCtx({ aiResponses: [{ reply: 'hi there', usage: { totalTokens: 7 }, model: 'gpt-4o-mini' }] });
    const res = await aiLlmChat.execute(
      ctx,
      params(aiLlmChat, {
        credentialId: 'cred1',
        model: 'gpt-4o-mini',
        system_prompt: 'You are helpful.',
        user_prompt: 'hello',
        temperature: 0.5,
        max_tokens: 256,
      }),
      [item({ text: 'hello' })],
    );
    if (res.kind !== 'items') throw new Error('expected items');

    // Exactly one LLM call.
    expect(ctx.aiCalls.length).toBe(1);
    const call = ctx.aiCalls[0]!;
    expect(call.credentialId).toBe('cred1');
    expect(call.model).toBe('gpt-4o-mini');
    expect(call.temperature).toBe(0.5);
    expect(call.maxTokens).toBe(256);
    expect(call.messages).toEqual([
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'hello' },
    ]);

    // Result merged under the default save_as = 'ai'.
    const out = res.outputs.main![0]!.json as { text: string; ai: { reply: string; usage: unknown; model?: string } };
    expect(out.text).toBe('hello'); // original field preserved
    expect(out.ai.reply).toBe('hi there');
    expect(out.ai.usage).toEqual({ totalTokens: 7 });
    expect(out.ai.model).toBe('gpt-4o-mini');
  });

  it('omits the system message when system_prompt is empty', async () => {
    const ctx = makeCtx();
    const res = await aiLlmChat.execute(
      ctx,
      params(aiLlmChat, { credentialId: 'c', model: 'm', user_prompt: 'q' }),
      [item({})],
    );
    if (res.kind !== 'items') throw new Error('expected items');
    expect(ctx.aiCalls[0]!.messages).toEqual([{ role: 'user', content: 'q' }]);
    // temperature/max_tokens are optional → not sent when absent.
    expect(ctx.aiCalls[0]!.temperature).toBeUndefined();
    expect(ctx.aiCalls[0]!.maxTokens).toBeUndefined();
  });

  it('honors a custom save_as key', async () => {
    const ctx = makeCtx({ aiResponses: [{ reply: 'R' }] });
    const res = await aiLlmChat.execute(
      ctx,
      params(aiLlmChat, { credentialId: 'c', model: 'm', user_prompt: 'q', save_as: 'answer' }),
      [item({})],
    );
    if (res.kind !== 'items') throw new Error('expected items');
    expect((res.outputs.main![0]!.json as { answer: { reply: string } }).answer.reply).toBe('R');
  });
});

describe('ai.llmChat — runs once per node run', () => {
  it('makes a single LLM call but writes the reply onto every item', async () => {
    const ctx = makeCtx({ aiResponses: [{ reply: 'one' }] });
    const res = await aiLlmChat.execute(
      ctx,
      params(aiLlmChat, { credentialId: 'c', model: 'm', user_prompt: 'q' }),
      [item({ id: 1 }), item({ id: 2 }), item({ id: 3 })],
    );
    if (res.kind !== 'items') throw new Error('expected items');
    expect(ctx.aiCalls.length).toBe(1); // not 3
    expect(res.outputs.main!.length).toBe(3);
    for (const it of res.outputs.main!) {
      expect((it.json as { ai: { reply: string } }).ai.reply).toBe('one');
    }
  });

  it('emits a single synthetic item when run with no input items', async () => {
    const ctx = makeCtx({ aiResponses: [{ reply: 'solo' }] });
    const res = await aiLlmChat.execute(
      ctx,
      params(aiLlmChat, { credentialId: 'c', model: 'm', user_prompt: 'q' }),
      [],
    );
    if (res.kind !== 'items') throw new Error('expected items');
    expect(res.outputs.main!.length).toBe(1);
    expect((res.outputs.main![0]!.json as { ai: { reply: string } }).ai.reply).toBe('solo');
  });
});

describe('ai.llmChat — memory=conversation', () => {
  it('persists the turn pair to KV scoped by node id', async () => {
    const ctx = makeCtx({ nodeId: 'nodeA', aiResponses: [{ reply: 'a1' }] });
    await aiLlmChat.execute(
      ctx,
      params(aiLlmChat, { credentialId: 'c', model: 'm', user_prompt: 'u1', memory: 'conversation' }),
      [item({})],
    );
    const stored = ctx.kvBag.get(`user:${AI_MEMORY_KEY_PREFIX}nodeA`);
    expect(stored).toEqual([
      { role: 'user', content: 'u1' },
      { role: 'assistant', content: 'a1' },
    ]);
  });

  it('loads prior turns into the request and appends the new turn', async () => {
    const ctx = makeCtx({ nodeId: 'nodeA', aiResponses: [{ reply: 'a2' }] });
    // Seed a prior turn pair.
    ctx.kvBag.set(`user:${AI_MEMORY_KEY_PREFIX}nodeA`, [
      { role: 'user', content: 'u1' },
      { role: 'assistant', content: 'a1' },
    ]);
    await aiLlmChat.execute(
      ctx,
      params(aiLlmChat, {
        credentialId: 'c',
        model: 'm',
        system_prompt: 'sys',
        user_prompt: 'u2',
        memory: 'conversation',
      }),
      [item({})],
    );
    // Request = system → history → new user turn.
    expect(ctx.aiCalls[0]!.messages).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'u1' },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'u2' },
    ]);
    // Stored memory grows to two turn pairs.
    expect(ctx.kvBag.get(`user:${AI_MEMORY_KEY_PREFIX}nodeA`)).toEqual([
      { role: 'user', content: 'u1' },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'u2' },
      { role: 'assistant', content: 'a2' },
    ]);
  });

  it('trims persisted memory to the window (window×2 messages)', async () => {
    const ctx = makeCtx({ nodeId: 'nodeA', aiResponses: [{ reply: 'a3' }] });
    // Two prior pairs already stored; window=1 should keep only the latest pair.
    ctx.kvBag.set(`user:${AI_MEMORY_KEY_PREFIX}nodeA`, [
      { role: 'user', content: 'u1' },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'u2' },
      { role: 'assistant', content: 'a2' },
    ]);
    await aiLlmChat.execute(
      ctx,
      params(aiLlmChat, {
        credentialId: 'c',
        model: 'm',
        user_prompt: 'u3',
        memory: 'conversation',
        memory_window: 1,
      }),
      [item({})],
    );
    expect(ctx.kvBag.get(`user:${AI_MEMORY_KEY_PREFIX}nodeA`)).toEqual([
      { role: 'user', content: 'u3' },
      { role: 'assistant', content: 'a3' },
    ]);
  });

  it('ignores malformed KV history defensively (never crashes)', async () => {
    const ctx = makeCtx({ nodeId: 'nodeA', aiResponses: [{ reply: 'ok' }] });
    ctx.kvBag.set(`user:${AI_MEMORY_KEY_PREFIX}nodeA`, [
      { role: 'user', content: 'good' },
      { role: 'system' }, // missing content → dropped
      'not-an-object', // junk → dropped
      { role: 'bogus', content: 'x' }, // bad role → dropped
    ]);
    const res = await aiLlmChat.execute(
      ctx,
      params(aiLlmChat, { credentialId: 'c', model: 'm', user_prompt: 'next', memory: 'conversation' }),
      [item({})],
    );
    if (res.kind !== 'items') throw new Error('expected items');
    expect(ctx.aiCalls[0]!.messages).toEqual([
      { role: 'user', content: 'good' },
      { role: 'user', content: 'next' },
    ]);
  });

  it('two nodes keep independent memories', async () => {
    const a = makeCtx({ nodeId: 'A', aiResponses: [{ reply: 'ra' }] });
    const b = makeCtx({ nodeId: 'B', aiResponses: [{ reply: 'rb' }] });
    const p = params(aiLlmChat, { credentialId: 'c', model: 'm', user_prompt: 'q', memory: 'conversation' });
    await aiLlmChat.execute(a, p, [item({})]);
    await aiLlmChat.execute(b, p, [item({})]);
    expect(a.kvBag.has(`user:${AI_MEMORY_KEY_PREFIX}A`)).toBe(true);
    expect(a.kvBag.has(`user:${AI_MEMORY_KEY_PREFIX}B`)).toBe(false);
    expect(b.kvBag.has(`user:${AI_MEMORY_KEY_PREFIX}B`)).toBe(true);
  });

  it('memory=none touches no KV', async () => {
    const ctx = makeCtx({ nodeId: 'nodeA', aiResponses: [{ reply: 'x' }] });
    await aiLlmChat.execute(
      ctx,
      params(aiLlmChat, { credentialId: 'c', model: 'm', user_prompt: 'q', memory: 'none' }),
      [item({})],
    );
    expect(ctx.kvBag.size).toBe(0);
  });
});

describe('ai.llmChat — failure modes', () => {
  it('fails loudly when no AI service is wired (ctx.ai === null)', async () => {
    const ctx = makeCtx({ aiResponses: null });
    const res = await aiLlmChat.execute(
      ctx,
      params(aiLlmChat, { credentialId: 'c', model: 'm', user_prompt: 'q' }),
      [item({})],
    );
    expect(res.kind).toBe('error');
    if (res.kind === 'error') expect(res.message).toContain('AI service is not available');
  });

  it('surfaces an upstream chat() rejection as a node error', async () => {
    const ctx = makeCtx();
    // Replace the fake chat with one that throws.
    ctx.ai = {
      async chat() {
        throw new Error('boom: 429 rate limited');
      },
    };
    const res = await aiLlmChat.execute(
      ctx,
      params(aiLlmChat, { credentialId: 'c', model: 'm', user_prompt: 'q' }),
      [item({})],
    );
    expect(res.kind).toBe('error');
    if (res.kind === 'error') expect(res.message).toContain('boom: 429 rate limited');
  });

  it('rejects params with an empty user_prompt (schema gate)', () => {
    expect(() => params(aiLlmChat, { credentialId: 'c', model: 'm', user_prompt: '' })).toThrow();
  });
});
