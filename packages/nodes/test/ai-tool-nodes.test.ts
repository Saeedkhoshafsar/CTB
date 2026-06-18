/**
 * PB-T6 — AI Agent tool nodes (NODES.md §"AI Agent tool nodes", PLAN2 PB-T6).
 *
 * Four `role:'provider'` sub-nodes fill an agent's `ai:tool` slot:
 *   - tool.httpRequest — the model calls an external API (ctx.http.request).
 *   - tool.code        — the model runs sandboxed JS (ctx.code.run).
 *   - tool.think       — a no-op scratchpad that echoes the model's reasoning.
 *   - tool.subflow     — the model runs another flow of the same bot (ctx.subflow).
 *
 * These tests cover (a) registration + the provider contract (role/provides/
 * ports, fail-loud execute, param schemas) and (b) the END-TO-END runner: drive
 * the real `ai.agent` with a scripted model that calls each tool via its
 * `ai:tool` slot, and assert the tool reached the right capability and fed the
 * result back to the model.
 */
import { NodeRegistry } from '@ctb/core';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  aiAgent,
  aiToolCode,
  aiToolHttpRequest,
  aiToolMcp,
  aiToolSubflow,
  aiToolThink,
  registerBuiltinNodes,
} from '../src/index';
import {
  AiModelOpenaiParamsSchema,
  ToolCodeParamsSchema,
  ToolHttpRequestParamsSchema,
  ToolMcpParamsSchema,
  ToolSubflowParamsSchema,
  ToolThinkParamsSchema,
  type AttachedProvider,
  type NodeDef,
} from '@ctb/shared';
import { item, makeCtx, params } from './node-harness';

/** Build an `ai:model` provider slot the way the executor's resolveSlots would. */
function modelSlot(raw: unknown = { credentialId: 'c1' }): AttachedProvider {
  return { nodeId: 'm1', type: 'ai.modelOpenai', params: AiModelOpenaiParamsSchema.parse(raw) };
}

// ── registration + provider contract ─────────────────────────────────────────

describe('AI Agent tool nodes — registration & contract (PB-T6)', () => {
  it('registers all five tool nodes in the builtins', () => {
    const reg = registerBuiltinNodes(new NodeRegistry());
    for (const type of ['tool.httpRequest', 'tool.code', 'tool.think', 'tool.subflow', 'tool.mcp']) {
      expect(reg.has(type)).toBe(true);
    }
  });

  it.each([
    ['tool.httpRequest', aiToolHttpRequest as NodeDef<never>],
    ['tool.code', aiToolCode as NodeDef<never>],
    ['tool.think', aiToolThink as NodeDef<never>],
    ['tool.subflow', aiToolSubflow as NodeDef<never>],
    ['tool.mcp', aiToolMcp as NodeDef<never>],
  ])('%s is an ai:tool provider with no data ports', (type, def) => {
    expect(def.type).toBe(type);
    expect(def.category).toBe('ai');
    expect(def.role).toBe('provider');
    expect(def.provides).toBe('ai:tool');
    expect(def.ports.inputs).toEqual([]);
    expect(def.ports.outputs).toEqual(['provider']);
  });

  it.each([
    ['tool.httpRequest', aiToolHttpRequest as NodeDef<never>],
    ['tool.code', aiToolCode as NodeDef<never>],
    ['tool.think', aiToolThink as NodeDef<never>],
    ['tool.subflow', aiToolSubflow as NodeDef<never>],
    ['tool.mcp', aiToolMcp as NodeDef<never>],
  ])('%s fails loudly if ever executed as a data step', async (_t, def) => {
    const ctx = makeCtx({});
    const res = await def.execute(ctx, {} as never, [item({})]);
    expect(res.kind).toBe('error');
  });

  it('tool.code keeps `code` raw (rawParamKeys) so {{ }} reaches the sandbox', () => {
    expect(aiToolCode.rawParamKeys).toEqual(['code']);
  });
});

describe('tool node param schemas (PB-T6)', () => {
  it('tool.httpRequest requires a url and defaults a sensible name', () => {
    expect(ToolHttpRequestParamsSchema.safeParse({}).success).toBe(false);
    const p = ToolHttpRequestParamsSchema.parse({ url: 'https://api.example.com' });
    expect(p.tool_name).toBe('http_request');
    expect(p.method).toBe('GET');
    expect(p.params).toEqual([]);
  });

  it('tool.code requires code and defaults a name', () => {
    expect(ToolCodeParamsSchema.safeParse({}).success).toBe(false);
    const p = ToolCodeParamsSchema.parse({ code: 'return 1' });
    expect(p.tool_name).toBe('run_code');
  });

  it('tool.think needs nothing and defaults name "think"', () => {
    const p = ToolThinkParamsSchema.parse({});
    expect(p.tool_name).toBe('think');
    expect(p.description.length).toBeGreaterThan(0);
  });

  it('tool.subflow requires a flow_id and rejects a bad tool_name', () => {
    expect(ToolSubflowParamsSchema.safeParse({}).success).toBe(false);
    expect(ToolSubflowParamsSchema.safeParse({ flow_id: 'f1', tool_name: 'bad name!' }).success).toBe(false);
    expect(ToolSubflowParamsSchema.parse({ flow_id: 'f1' }).tool_name).toBe('');
  });

  it('tool.mcp requires a credentialId (PC-T4)', () => {
    expect(ToolMcpParamsSchema.safeParse({}).success).toBe(false);
    expect(ToolMcpParamsSchema.safeParse({ credentialId: '' }).success).toBe(false);
    expect(ToolMcpParamsSchema.parse({ credentialId: 'mcp1' }).credentialId).toBe('mcp1');
  });

  it('rejects a tool param row with a non-identifier name', () => {
    expect(
      ToolHttpRequestParamsSchema.safeParse({ url: 'x', params: [{ name: '1bad' }] }).success,
    ).toBe(false);
  });
});

// ── end-to-end runners through the real ai.agent ─────────────────────────────

/** Build an `ai:tool` provider slot validated by the matching tool schema. */
function httpToolSlot(raw: unknown): AttachedProvider {
  return { nodeId: 'tool1', type: 'tool.httpRequest', params: ToolHttpRequestParamsSchema.parse(raw) };
}
function codeToolSlot(raw: unknown): AttachedProvider {
  return { nodeId: 'tool1', type: 'tool.code', params: ToolCodeParamsSchema.parse(raw) };
}
function thinkToolSlot(raw: unknown = {}): AttachedProvider {
  return { nodeId: 'tool1', type: 'tool.think', params: ToolThinkParamsSchema.parse(raw) };
}
function subflowToolSlot(raw: unknown): AttachedProvider {
  return { nodeId: 'tool1', type: 'tool.subflow', params: ToolSubflowParamsSchema.parse(raw) };
}
function mcpToolSlot(raw: unknown): AttachedProvider {
  return { nodeId: 'tool1', type: 'tool.mcp', params: ToolMcpParamsSchema.parse(raw) };
}

describe('tool.httpRequest runner (PB-T6)', () => {
  it('calls the API with model args as query params (GET) and feeds the response back', async () => {
    const ctx = makeCtx({
      httpResponses: [{ status: 200, body: { temp: 21 } }],
      aiResponses: [
        { reply: '', toolCalls: [{ id: 'c1', name: 'weather', argumentsJson: '{"city":"berlin"}' }] },
        { reply: 'it is 21°' },
      ],
      slots: {
        'ai:model': [modelSlot()],
        'ai:tool': [
          httpToolSlot({
            tool_name: 'weather',
            description: 'get weather',
            method: 'GET',
            url: 'https://api.example.com/weather',
            params: [{ name: 'city', type: 'string', required: true }],
          }),
        ],
      },
    });
    const res = await aiAgent.execute(ctx, params(aiAgent, { user_prompt: 'weather in berlin?' }), [item({})]);
    if (res.kind !== 'items') throw new Error('expected items');

    // The tool spec was advertised with the declared parameter schema.
    const spec = ctx.aiCalls[0]!.tools?.find((t) => t.name === 'weather');
    expect(spec).toBeDefined();
    expect(spec!.parameters).toMatchObject({ properties: { city: { type: 'string' } }, required: ['city'] });

    // The HTTP call carried the model's arg as a query param.
    expect(ctx.httpCalls).toHaveLength(1);
    expect(ctx.httpCalls[0]!.url).toBe('https://api.example.com/weather?city=berlin');
    expect(ctx.httpCalls[0]!.method).toBe('GET');

    // The response body was fed back to the model as the tool result.
    const toolMsg = ctx.aiCalls[1]!.messages.find((m) => m.role === 'tool');
    expect(toolMsg?.content).toContain('21');
    expect(res.outputs.main![0]!.json.agent).toMatchObject({ reply: 'it is 21°' });
  });

  it('sends model args as a JSON body for POST and injects credential headers', async () => {
    const ctx = makeCtx({
      httpResponses: [{ status: 201, body: { ok: true } }],
      credentialHeaders: { cred1: { authorization: 'Bearer xyz' } },
      aiResponses: [
        { reply: '', toolCalls: [{ id: 'c1', name: 'create', argumentsJson: '{"name":"Sam"}' }] },
        { reply: 'created' },
      ],
      slots: {
        'ai:model': [modelSlot()],
        'ai:tool': [
          httpToolSlot({
            tool_name: 'create',
            method: 'POST',
            url: 'https://api.example.com/users',
            credentialId: 'cred1',
            params: [{ name: 'name', type: 'string', required: true }],
          }),
        ],
      },
    });
    const res = await aiAgent.execute(ctx, params(aiAgent, { user_prompt: 'create Sam' }), [item({})]);
    if (res.kind !== 'items') throw new Error('expected items');
    expect(ctx.httpCalls[0]!.method).toBe('POST');
    expect(ctx.httpCalls[0]!.headers?.authorization).toBe('Bearer xyz');
    expect(JSON.parse(ctx.httpCalls[0]!.body as string)).toEqual({ name: 'Sam' });
  });
});

describe('tool.code runner (PB-T6)', () => {
  it('runs sandboxed JS with the model args as $json and returns its result', async () => {
    const ctx = makeCtx({
      aiResponses: [
        { reply: '', toolCalls: [{ id: 'c1', name: 'add', argumentsJson: '{"a":2,"b":3}' }] },
        { reply: 'the sum is 5' },
      ],
      slots: {
        'ai:model': [modelSlot()],
        'ai:tool': [
          codeToolSlot({
            tool_name: 'add',
            description: 'add two numbers',
            code: 'return { sum: $json.a + $json.b }',
            params: [
              { name: 'a', type: 'number', required: true },
              { name: 'b', type: 'number', required: true },
            ],
          }),
        ],
      },
    });
    const res = await aiAgent.execute(ctx, params(aiAgent, { user_prompt: '2 plus 3' }), [item({})]);
    if (res.kind !== 'items') throw new Error('expected items');
    const toolMsg = ctx.aiCalls[1]!.messages.find((m) => m.role === 'tool');
    expect(toolMsg?.content).toContain('5');
    expect(res.outputs.main![0]!.json.agent).toMatchObject({ reply: 'the sum is 5', toolCalls: 1 });
  });
});

describe('tool.think runner (PB-T6)', () => {
  it('echoes the model thought back unchanged and touches no capability', async () => {
    const ctx = makeCtx({
      aiResponses: [
        { reply: '', toolCalls: [{ id: 'c1', name: 'think', argumentsJson: '{"thought":"step 1: plan"}' }] },
        { reply: 'final' },
      ],
      slots: {
        'ai:model': [modelSlot()],
        'ai:tool': [thinkToolSlot()],
      },
    });
    const res = await aiAgent.execute(ctx, params(aiAgent, { user_prompt: 'solve it' }), [item({})]);
    if (res.kind !== 'items') throw new Error('expected items');
    const toolMsg = ctx.aiCalls[1]!.messages.find((m) => m.role === 'tool');
    expect(toolMsg?.content).toBe('step 1: plan');
    expect(ctx.httpCalls).toHaveLength(0);
    expect(ctx.subflowCalls).toHaveLength(0);
  });
});

describe('tool.subflow runner (PB-T6)', () => {
  it('runs the child flow with model args and derives a name when blank', async () => {
    const ctx = makeCtx({
      subflowRun: async (_flowId, items) => ({ items: [{ json: { doubled: (items[0]!.json.n as number) * 2 } }] }),
      aiResponses: [
        { reply: '', toolCalls: [{ id: 'c1', name: 'flow_abc-123', argumentsJson: '{"n":21}' }] },
        { reply: '42' },
      ],
      slots: {
        'ai:model': [modelSlot()],
        'ai:tool': [subflowToolSlot({ flow_id: 'abc-123' })],
      },
    });
    const res = await aiAgent.execute(ctx, params(aiAgent, { user_prompt: 'double 21' }), [item({})]);
    if (res.kind !== 'items') throw new Error('expected items');
    expect(ctx.aiCalls[0]!.tools?.[0]?.name).toBe('flow_abc-123');
    expect(ctx.subflowCalls).toHaveLength(1);
    expect(ctx.subflowCalls[0]).toMatchObject({ flowId: 'abc-123', items: [{ json: { n: 21 } }] });
    const toolMsg = ctx.aiCalls[1]!.messages.find((m) => m.role === 'tool');
    expect(toolMsg?.content).toContain('42');
  });
});

describe('multiple tools + dedupe (PB-T6)', () => {
  beforeEach(() => {});
  it('advertises several slot tools and drops a duplicate tool name', async () => {
    const ctx = makeCtx({
      aiResponses: [{ reply: 'ok' }],
      slots: {
        'ai:model': [modelSlot()],
        'ai:tool': [
          thinkToolSlot({ tool_name: 'think' }),
          codeToolSlot({ tool_name: 'work', code: 'return 1' }),
          // duplicate name → dropped (first wins) with a warning.
          { nodeId: 'tool3', type: 'tool.code', params: ToolCodeParamsSchema.parse({ tool_name: 'work', code: 'return 2' }) },
        ],
      },
    });
    const res = await aiAgent.execute(ctx, params(aiAgent, { user_prompt: 'hi' }), [item({})]);
    if (res.kind !== 'items') throw new Error('expected items');
    const names = (ctx.aiCalls[0]!.tools ?? []).map((t) => t.name).sort();
    expect(names).toEqual(['think', 'work']);
    expect(ctx.logs.some((l) => l.level === 'warn' && /duplicate tool name/.test(l.message))).toBe(true);
  });
});

// ── tool.mcp runner through the real ai.agent (PC-T4) ──────────────────────────

describe('tool.mcp runner (PC-T4)', () => {
  it('expands a wired tool.mcp provider into the server\'s tools and the model calls one', async () => {
    const ctx = makeCtx({
      mcp: {
        tools: [{ name: 'getWeather', description: 'weather by city', inputSchema: { type: 'object' } }],
        callResult: { content: [{ type: 'text', text: 'sunny, 25°C' }], text: 'sunny, 25°C', isError: false },
      },
      aiResponses: [
        { reply: '', toolCalls: [{ id: 'call_1', name: 'getWeather', argumentsJson: '{"city":"Tehran"}' }] },
        { reply: 'It is sunny and 25°C in Tehran.', usage: { totalTokens: 12 } },
      ],
      slots: {
        'ai:model': [modelSlot()],
        'ai:tool': [mcpToolSlot({ credentialId: 'mcp1' })],
      },
    });
    const res = await aiAgent.execute(ctx, params(aiAgent, { user_prompt: 'weather in Tehran?' }), [item({})]);
    if (res.kind !== 'items') throw new Error('expected items');

    // The provider was mapped to an mcp source by NODE TYPE → listTools once,
    // callTool once, using the node's credential (never a leaked key).
    expect(ctx.mcpListCalls).toHaveLength(1);
    expect(ctx.mcpListCalls[0]!.credentialId).toBe('mcp1');
    expect(ctx.mcpCallCalls).toHaveLength(1);
    expect(ctx.mcpCallCalls[0]).toMatchObject({ credentialId: 'mcp1', name: 'getWeather', arguments: { city: 'Tehran' } });

    // First LLM turn carried the advertised tool spec.
    expect(ctx.aiCalls[0]!.tools).toEqual([
      { name: 'getWeather', description: 'weather by city', parameters: { type: 'object' } },
    ]);
    expect(res.outputs.main![0]!.json.agent).toMatchObject({
      reply: 'It is sunny and 25°C in Tehran.',
      toolCalls: 1,
      stopReason: 'final',
    });
  });

  it('fails loudly when no MCP service is available in the run context', async () => {
    const ctx = makeCtx({
      mcp: null, // ctx.mcp === null
      aiResponses: [{ reply: 'unused' }],
      slots: {
        'ai:model': [modelSlot()],
        'ai:tool': [mcpToolSlot({ credentialId: 'mcp1' })],
      },
    });
    const res = await aiAgent.execute(ctx, params(aiAgent, { user_prompt: 'hi' }), [item({})]);
    expect(res.kind).toBe('error');
  });
});
