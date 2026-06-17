/**
 * ai.agent contract tests (P5-T4, NODES.md §AI Agent).
 *
 * ai.agent is a tool-calling LLM loop over the injected ctx.ai capability (now
 * carrying `tools` + returning `toolCalls`), with tools resolved from ctx.mcp
 * (MCP server tools) and ctx.subflow (a flow exposed as one tool). Invariants
 * I2/I6/I7 hold — the node never sees a provider/MCP key; it passes credential
 * ids and the HOST resolves them. We drive it against the fakes from
 * node-harness and assert:
 *   - no tools → behaves like a plain chat (one call, final reply merged),
 *   - a tool-call turn runs the tool (mcp / subflow) and feeds the result back,
 *     looping until a final answer,
 *   - tool specs are passed to the model (mcp expands to advertised tools;
 *     subflow becomes one named tool),
 *   - budget caps: max_steps, max_tool_calls, max_tokens_total each stop the
 *     loop with the right stopReason,
 *   - a failing/unknown tool yields an `error:` result fed back, never a node
 *     failure,
 *   - failure modes: no ai context, missing mcp/subflow capability for a
 *     configured tool, an upstream chat() rejection.
 */
import { NodeRegistry } from '@ctb/core';
import { describe, expect, it } from 'vitest';
import { aiAgent, builtinNodes, parseToolArguments, registerBuiltinNodes } from '../src/index';
import { item, makeCtx, params } from './node-harness';

describe('registry (P5-T4)', () => {
  it('registers ai.agent; registry is 38 types', () => {
    const reg = registerBuiltinNodes(new NodeRegistry());
    expect(reg.has('ai.agent')).toBe(true);
    expect(builtinNodes.length).toBe(46);
  });

  it('is an `ai` node with main → main ports', () => {
    expect(aiAgent.category).toBe('ai');
    expect(aiAgent.ports).toEqual({ inputs: ['main'], outputs: ['main'] });
  });
});

// ── params schema ────────────────────────────────────────────────────────────

describe('AiAgentParamsSchema', () => {
  it('applies defaults (model, system_prompt, caps, save_as)', () => {
    const p = params(aiAgent, { credentialId: 'c1', user_prompt: 'help me' });
    expect(p.model).toBe('gpt-4o-mini');
    expect(p.tools).toEqual([]);
    expect(p.max_steps).toBe(6);
    expect(p.max_tool_calls).toBe(12);
    expect(p.max_tokens_total).toBe(0);
    expect(p.save_as).toBe('agent');
  });

  it('rejects an mcp tool with no credential', () => {
    expect(() =>
      params(aiAgent, { credentialId: 'c1', user_prompt: 'x', tools: [{ type: 'mcp', credentialId: '' }] }),
    ).toThrow();
  });

  it('rejects a subflow tool with no flow', () => {
    expect(() =>
      params(aiAgent, { credentialId: 'c1', user_prompt: 'x', tools: [{ type: 'subflow', flow_id: '' }] }),
    ).toThrow();
  });

  it('rejects a subflow tool with a malformed tool_name', () => {
    expect(() =>
      params(aiAgent, {
        credentialId: 'c1',
        user_prompt: 'x',
        tools: [{ type: 'subflow', flow_id: 'f1', tool_name: 'bad name!' }],
      }),
    ).toThrow();
  });
});

describe('parseToolArguments', () => {
  it('blank → {}', () => expect(parseToolArguments('  ')).toEqual({}));
  it('object passes through', () => expect(parseToolArguments('{"a":1}')).toEqual({ a: 1 }));
  it('non-JSON throws', () => expect(() => parseToolArguments('not json')).toThrow(/valid JSON/));
  it('array throws', () => expect(() => parseToolArguments('[1,2]')).toThrow(/JSON object/));
});

// ── no tools: behaves like a plain chat ──────────────────────────────────────

describe('ai.agent — no tools (plain chat)', () => {
  it('makes one call and merges the final reply onto every item', async () => {
    const ctx = makeCtx({ aiResponses: [{ reply: 'the answer is 42', usage: { totalTokens: 9 } }] });
    const res = await aiAgent.execute(
      ctx,
      params(aiAgent, { credentialId: 'cred1', user_prompt: 'what is the answer?' }),
      [item({ a: 1 }), item({ a: 2 })],
    );
    if (res.kind !== 'items') throw new Error('expected items');

    expect(ctx.aiCalls.length).toBe(1);
    // No tools configured → no tools field sent.
    expect(ctx.aiCalls[0]!.tools).toBeUndefined();
    expect(ctx.aiCalls[0]!.messages).toEqual([
      { role: 'system', content: expect.any(String) },
      { role: 'user', content: 'what is the answer?' },
    ]);

    expect(res.outputs.main).toHaveLength(2);
    for (const out of res.outputs.main!) {
      expect(out.json.agent).toMatchObject({
        reply: 'the answer is 42',
        steps: 1,
        toolCalls: 0,
        stopReason: 'final',
      });
    }
    expect((res.outputs.main![0]!.json.agent as { usage: unknown }).usage).toEqual({ totalTokens: 9 });
  });

  it('seeds one empty item when input is empty', async () => {
    const ctx = makeCtx({ aiResponses: [{ reply: 'hi' }] });
    const res = await aiAgent.execute(ctx, params(aiAgent, { credentialId: 'c1', user_prompt: 'hi' }), []);
    if (res.kind !== 'items') throw new Error('expected items');
    expect(res.outputs.main).toHaveLength(1);
  });
});

// ── tool loop over an MCP tool ───────────────────────────────────────────────

describe('ai.agent — MCP tool loop', () => {
  it('exposes the advertised MCP tools, runs the requested one, feeds it back, then answers', async () => {
    const ctx = makeCtx({
      mcp: {
        tools: [{ name: 'getWeather', description: 'weather by city', inputSchema: { type: 'object' } }],
        callResult: { content: [{ type: 'text', text: 'sunny, 25°C' }], text: 'sunny, 25°C', isError: false },
      },
      aiResponses: [
        // Turn 1: model calls the tool.
        { reply: '', toolCalls: [{ id: 'call_1', name: 'getWeather', argumentsJson: '{"city":"Tehran"}' }] },
        // Turn 2: model gives a final answer.
        { reply: 'It is sunny and 25°C in Tehran.', usage: { totalTokens: 12 } },
      ],
    });
    const res = await aiAgent.execute(
      ctx,
      params(aiAgent, {
        credentialId: 'cred1',
        user_prompt: 'weather in Tehran?',
        tools: [{ type: 'mcp', credentialId: 'mcp1' }],
      }),
      [item({})],
    );
    if (res.kind !== 'items') throw new Error('expected items');

    // listTools called once for resolution; callTool called once for the request.
    expect(ctx.mcpListCalls).toHaveLength(1);
    expect(ctx.mcpListCalls[0]!.credentialId).toBe('mcp1');
    expect(ctx.mcpCallCalls).toHaveLength(1);
    expect(ctx.mcpCallCalls[0]).toMatchObject({ credentialId: 'mcp1', name: 'getWeather', arguments: { city: 'Tehran' } });

    // Two LLM turns; first carried the tool spec.
    expect(ctx.aiCalls).toHaveLength(2);
    expect(ctx.aiCalls[0]!.tools).toEqual([
      { name: 'getWeather', description: 'weather by city', parameters: { type: 'object' } },
    ]);
    // Turn 2's messages include the assistant tool-call turn + the tool result.
    const t2 = ctx.aiCalls[1]!.messages;
    expect(t2.some((m) => m.role === 'assistant' && (m.toolCalls?.length ?? 0) > 0)).toBe(true);
    expect(t2.some((m) => m.role === 'tool' && m.toolCallId === 'call_1' && m.content === 'sunny, 25°C')).toBe(true);

    expect(res.outputs.main![0]!.json.agent).toMatchObject({
      reply: 'It is sunny and 25°C in Tehran.',
      steps: 2,
      toolCalls: 1,
      stopReason: 'final',
    });
  });

  it('surfaces a tool isError result as an `error:` message fed back to the model', async () => {
    const ctx = makeCtx({
      mcp: {
        tools: [{ name: 'boom' }],
        callResult: { content: [], text: 'kaboom', isError: true },
      },
      aiResponses: [
        { reply: '', toolCalls: [{ id: 'c1', name: 'boom', argumentsJson: '{}' }] },
        { reply: 'recovered' },
      ],
    });
    const res = await aiAgent.execute(
      ctx,
      params(aiAgent, { credentialId: 'cred1', user_prompt: 'go', tools: [{ type: 'mcp', credentialId: 'm' }] }),
      [item({})],
    );
    if (res.kind !== 'items') throw new Error('expected items');
    const toolMsg = ctx.aiCalls[1]!.messages.find((m) => m.role === 'tool');
    expect(toolMsg?.content).toMatch(/^error: kaboom/);
    expect(res.outputs.main![0]!.json.agent).toMatchObject({ reply: 'recovered', stopReason: 'final' });
  });

  it('an unknown tool name yields an `error: unknown tool` result, not a node failure', async () => {
    const ctx = makeCtx({
      mcp: { tools: [{ name: 'realTool' }] },
      aiResponses: [
        { reply: '', toolCalls: [{ id: 'c1', name: 'ghostTool', argumentsJson: '{}' }] },
        { reply: 'ok' },
      ],
    });
    const res = await aiAgent.execute(
      ctx,
      params(aiAgent, { credentialId: 'cred1', user_prompt: 'go', tools: [{ type: 'mcp', credentialId: 'm' }] }),
      [item({})],
    );
    if (res.kind !== 'items') throw new Error('expected items');
    const toolMsg = ctx.aiCalls[1]!.messages.find((m) => m.role === 'tool');
    expect(toolMsg?.content).toMatch(/unknown tool "ghostTool"/);
    // The unknown tool was NOT routed to the MCP server.
    expect(ctx.mcpCallCalls).toHaveLength(0);
  });
});

// ── flows-as-tools ───────────────────────────────────────────────────────────

describe('ai.agent — sub-flow as a tool', () => {
  it('exposes the flow as one named tool and runs it with the model args as $json', async () => {
    const ctx = makeCtx({
      subflowRun: async (_flowId, items) => ({ items: [{ json: { doubled: (items[0]!.json.n as number) * 2 } }] }),
      aiResponses: [
        { reply: '', toolCalls: [{ id: 'c1', name: 'double', argumentsJson: '{"n":21}' }] },
        { reply: 'The result is 42.' },
      ],
    });
    const res = await aiAgent.execute(
      ctx,
      params(aiAgent, {
        credentialId: 'cred1',
        user_prompt: 'double 21',
        tools: [{ type: 'subflow', flow_id: 'flowX', tool_name: 'double', description: 'doubles n' }],
      }),
      [item({})],
    );
    if (res.kind !== 'items') throw new Error('expected items');

    // The sub-flow ran once with the model's arguments as the entry json.
    expect(ctx.subflowCalls).toHaveLength(1);
    expect(ctx.subflowCalls[0]).toMatchObject({ flowId: 'flowX', items: [{ json: { n: 21 } }] });

    // The tool spec carried the chosen name + description.
    expect(ctx.aiCalls[0]!.tools).toEqual([
      { name: 'double', description: 'doubles n', parameters: { type: 'object', additionalProperties: true } },
    ]);
    // The tool result (the sub-flow's returned json) was fed back.
    const toolMsg = ctx.aiCalls[1]!.messages.find((m) => m.role === 'tool');
    expect(toolMsg?.content).toBe(JSON.stringify({ doubled: 42 }));
    expect(res.outputs.main![0]!.json.agent).toMatchObject({ reply: 'The result is 42.', toolCalls: 1 });
  });

  it('derives a tool name from the flow id when tool_name is blank', async () => {
    const ctx = makeCtx({
      subflowRun: async () => ({ items: [] }),
      aiResponses: [{ reply: 'done' }],
    });
    await aiAgent.execute(
      ctx,
      params(aiAgent, {
        credentialId: 'cred1',
        user_prompt: 'go',
        tools: [{ type: 'subflow', flow_id: 'abc-123' }],
      }),
      [item({})],
    );
    expect(ctx.aiCalls[0]!.tools?.[0]?.name).toBe('flow_abc-123');
  });
});

// ── budget caps ──────────────────────────────────────────────────────────────

describe('ai.agent — budget caps', () => {
  it('max_steps stops the loop (model keeps calling tools forever)', async () => {
    const ctx = makeCtx({
      mcp: { tools: [{ name: 'loop' }] },
      // EVERY turn requests a tool → only the step cap can end it.
      aiResponses: [{ reply: 'thinking', toolCalls: [{ id: 'c', name: 'loop', argumentsJson: '{}' }] }],
    });
    const res = await aiAgent.execute(
      ctx,
      params(aiAgent, {
        credentialId: 'cred1',
        user_prompt: 'spin',
        tools: [{ type: 'mcp', credentialId: 'm' }],
        max_steps: 3,
      }),
      [item({})],
    );
    if (res.kind !== 'items') throw new Error('expected items');
    expect(ctx.aiCalls).toHaveLength(3);
    expect(res.outputs.main![0]!.json.agent).toMatchObject({ steps: 3, stopReason: 'max_steps' });
  });

  it('max_tool_calls stops the loop after N invocations', async () => {
    const ctx = makeCtx({
      mcp: { tools: [{ name: 'loop' }] },
      aiResponses: [
        { reply: '', toolCalls: [{ id: 'a', name: 'loop', argumentsJson: '{}' }, { id: 'b', name: 'loop', argumentsJson: '{}' }] },
        { reply: '', toolCalls: [{ id: 'c', name: 'loop', argumentsJson: '{}' }] },
        { reply: 'never reached' },
      ],
    });
    const res = await aiAgent.execute(
      ctx,
      params(aiAgent, {
        credentialId: 'cred1',
        user_prompt: 'spin',
        tools: [{ type: 'mcp', credentialId: 'm' }],
        max_tool_calls: 2,
        max_steps: 20,
      }),
      [item({})],
    );
    if (res.kind !== 'items') throw new Error('expected items');
    // Two tool calls executed (a + b); the second turn's call hits the cap.
    expect(ctx.mcpCallCalls).toHaveLength(2);
    expect(res.outputs.main![0]!.json.agent).toMatchObject({ toolCalls: 2, stopReason: 'max_tool_calls' });
  });

  it('max_tokens_total stops the loop once cumulative usage exceeds the cap', async () => {
    const ctx = makeCtx({
      mcp: { tools: [{ name: 'loop' }] },
      aiResponses: [
        { reply: '', usage: { totalTokens: 600 }, toolCalls: [{ id: 'c', name: 'loop', argumentsJson: '{}' }] },
        { reply: 'unused' },
      ],
    });
    const res = await aiAgent.execute(
      ctx,
      params(aiAgent, {
        credentialId: 'cred1',
        user_prompt: 'spin',
        tools: [{ type: 'mcp', credentialId: 'm' }],
        max_tokens_total: 500,
        max_steps: 20,
      }),
      [item({})],
    );
    if (res.kind !== 'items') throw new Error('expected items');
    expect(res.outputs.main![0]!.json.agent).toMatchObject({ stopReason: 'max_tokens', steps: 1 });
    expect((res.outputs.main![0]!.json.agent as { usage: { totalTokens: number } }).usage.totalTokens).toBe(600);
  });

  it('max_tool_calls = 0 forbids invocations (tools still advertised, calls answered with an error)', async () => {
    const ctx = makeCtx({
      mcp: { tools: [{ name: 'loop' }] },
      aiResponses: [
        { reply: '', toolCalls: [{ id: 'c', name: 'loop', argumentsJson: '{}' }] },
        { reply: 'final' },
      ],
    });
    const res = await aiAgent.execute(
      ctx,
      params(aiAgent, {
        credentialId: 'cred1',
        user_prompt: 'go',
        tools: [{ type: 'mcp', credentialId: 'm' }],
        max_tool_calls: 0,
      }),
      [item({})],
    );
    if (res.kind !== 'items') throw new Error('expected items');
    expect(ctx.mcpCallCalls).toHaveLength(0);
    const toolMsg = ctx.aiCalls[1]!.messages.find((m) => m.role === 'tool');
    expect(toolMsg?.content).toMatch(/disabled/);
    expect(res.outputs.main![0]!.json.agent).toMatchObject({ reply: 'final', toolCalls: 0 });
  });
});

// ── failure modes ────────────────────────────────────────────────────────────

describe('ai.agent — failure modes', () => {
  it('fails loudly when ctx.ai is null', async () => {
    const ctx = makeCtx({ aiResponses: null });
    const res = await aiAgent.execute(ctx, params(aiAgent, { credentialId: 'c1', user_prompt: 'x' }), [item({})]);
    expect(res.kind).toBe('error');
    if (res.kind === 'error') expect(res.message).toMatch(/AI service is not available/);
  });

  it('fails loudly when an mcp tool is configured but ctx.mcp is null', async () => {
    const ctx = makeCtx({ aiResponses: [{ reply: 'x' }], mcp: null });
    const res = await aiAgent.execute(
      ctx,
      params(aiAgent, { credentialId: 'c1', user_prompt: 'x', tools: [{ type: 'mcp', credentialId: 'm' }] }),
      [item({})],
    );
    expect(res.kind).toBe('error');
    if (res.kind === 'error') expect(res.message).toMatch(/MCP service is not available/);
  });

  it('fails loudly when a subflow tool is configured but ctx.subflow is null', async () => {
    const ctx = makeCtx({ aiResponses: [{ reply: 'x' }], subflowRun: null });
    const res = await aiAgent.execute(
      ctx,
      params(aiAgent, { credentialId: 'c1', user_prompt: 'x', tools: [{ type: 'subflow', flow_id: 'f1' }] }),
      [item({})],
    );
    expect(res.kind).toBe('error');
    if (res.kind === 'error') expect(res.message).toMatch(/sub-flow execution is not available/);
  });

  it('fails loudly when the LLM call rejects', async () => {
    const ctx = makeCtx({ aiResponses: [{ reply: 'x' }] });
    // Monkeypatch ctx.ai.chat to reject.
    ctx.ai = { chat: async () => { throw new Error('provider down'); } };
    const res = await aiAgent.execute(ctx, params(aiAgent, { credentialId: 'c1', user_prompt: 'x' }), [item({})]);
    expect(res.kind).toBe('error');
    if (res.kind === 'error') expect(res.message).toMatch(/provider down/);
  });
});
