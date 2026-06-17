/**
 * ai.mcpClient contract tests (P5-T3, NODES.md §MCP Client).
 *
 * A generic MCP primitive over the injected ctx.mcp capability (invariants
 * I2/I6/I7 — the node never sees the MCP server's URL/key; it passes a
 * credentialId and the HOST resolves it). We drive it against the fake mcp
 * capability from node-harness and assert the NODES.md contract:
 *
 *   list_tools → ctx.mcp.listTools(credentialId), result `{ tools }` merged
 *     under save_as on every output item.
 *   call_tool  → ctx.mcp.callTool(credentialId, name, arguments), result
 *     `{ result: { content, text, isError } }` merged under save_as.
 *     arguments_json is parsed (object only); blank → {}; bad JSON / non-object
 *     fail loudly. Runs once per node run. no-mcp + transport error fail loudly.
 */
import { NodeRegistry } from '@ctb/core';
import { describe, expect, it } from 'vitest';
import { aiMcpClient, builtinNodes, registerBuiltinNodes } from '../src/index';
import { item, makeCtx, params } from './node-harness';

describe('registry (P5-T3)', () => {
  it('registers ai.mcpClient; registry is 38 types', () => {
    const reg = registerBuiltinNodes(new NodeRegistry());
    expect(reg.has('ai.mcpClient')).toBe(true);
    expect(builtinNodes.length).toBe(38);
  });

  it('ai.mcpClient is an `ai` node, main → main', () => {
    expect(aiMcpClient.category).toBe('ai');
    expect(aiMcpClient.ports).toEqual({ inputs: ['main'], outputs: ['main'] });
  });
});

// ── params schema ──────────────────────────────────────────────────────────

describe('AiMcpClientParamsSchema', () => {
  it('defaults action=call_tool, arguments_json={}, save_as=mcp', () => {
    const p = params(aiMcpClient, { credentialId: 'c1', tool_name: 'getWeather' });
    expect(p.action).toBe('call_tool');
    expect(p.arguments_json).toBe('{}');
    expect(p.save_as).toBe('mcp');
  });

  it('rejects call_tool without a tool_name', () => {
    expect(() => params(aiMcpClient, { credentialId: 'c1', action: 'call_tool' })).toThrow();
  });

  it('allows list_tools without a tool_name', () => {
    const p = params(aiMcpClient, { credentialId: 'c1', action: 'list_tools' });
    expect(p.action).toBe('list_tools');
  });

  it('rejects an invalid save_as identifier', () => {
    expect(() =>
      params(aiMcpClient, { credentialId: 'c1', action: 'list_tools', save_as: '1bad' }),
    ).toThrow();
  });
});

// ── list_tools ───────────────────────────────────────────────────────────────

describe('ai.mcpClient — list_tools', () => {
  it('calls listTools and merges { tools } under save_as on every item', async () => {
    const tools = [
      { name: 'getWeather', description: 'weather by city' },
      { name: 'search', description: 'web search' },
    ];
    const ctx = makeCtx({ mcp: { tools } });
    const p = params(aiMcpClient, { credentialId: 'cred1', action: 'list_tools' });
    const res = await aiMcpClient.execute(ctx, p, [item({ a: 1 }), item({ a: 2 })]);

    expect(ctx.mcpListCalls).toEqual([{ credentialId: 'cred1' }]);
    expect(ctx.mcpCallCalls).toHaveLength(0);
    expect(res.kind).toBe('items');
    if (res.kind !== 'items') throw new Error('expected items');
    const out = res.outputs.main!;
    expect(out).toHaveLength(2);
    expect(out[0]!.json).toEqual({ a: 1, mcp: { tools } });
    expect(out[1]!.json).toEqual({ a: 2, mcp: { tools } });
  });

  it('runs once per node run (one listTools call regardless of item count)', async () => {
    const ctx = makeCtx({ mcp: { tools: [{ name: 'x' }] } });
    const p = params(aiMcpClient, { credentialId: 'cred1', action: 'list_tools' });
    await aiMcpClient.execute(ctx, p, [item({ a: 1 }), item({ a: 2 }), item({ a: 3 })]);
    expect(ctx.mcpListCalls).toHaveLength(1);
  });

  it('still emits one item when input is empty (can seed)', async () => {
    const ctx = makeCtx({ mcp: { tools: [] } });
    const p = params(aiMcpClient, { credentialId: 'cred1', action: 'list_tools' });
    const res = await aiMcpClient.execute(ctx, p, []);
    if (res.kind !== 'items') throw new Error('expected items');
    expect(res.outputs.main).toHaveLength(1);
    expect(res.outputs.main![0]!.json).toEqual({ mcp: { tools: [] } });
  });

  it('honours a custom save_as', async () => {
    const ctx = makeCtx({ mcp: { tools: [{ name: 'x' }] } });
    const p = params(aiMcpClient, { credentialId: 'cred1', action: 'list_tools', save_as: 'toolset' });
    const res = await aiMcpClient.execute(ctx, p, [item({})]);
    if (res.kind !== 'items') throw new Error('expected items');
    expect(res.outputs.main![0]!.json).toHaveProperty('toolset');
  });
});

// ── call_tool ────────────────────────────────────────────────────────────────

describe('ai.mcpClient — call_tool', () => {
  it('parses arguments_json and forwards name + arguments to callTool', async () => {
    const ctx = makeCtx({
      mcp: { callResult: { content: [{ type: 'text', text: 'sunny' }], text: 'sunny', isError: false } },
    });
    const p = params(aiMcpClient, {
      credentialId: 'cred1',
      action: 'call_tool',
      tool_name: 'getWeather',
      arguments_json: '{"city":"Tehran","units":"c"}',
    });
    const res = await aiMcpClient.execute(ctx, p, [item({ q: 1 })]);

    expect(ctx.mcpCallCalls).toEqual([
      { credentialId: 'cred1', name: 'getWeather', arguments: { city: 'Tehran', units: 'c' } },
    ]);
    if (res.kind !== 'items') throw new Error('expected items');
    expect(res.outputs.main![0]!.json).toEqual({
      q: 1,
      mcp: { result: { content: [{ type: 'text', text: 'sunny' }], text: 'sunny', isError: false } },
    });
  });

  it('treats a blank arguments_json as {}', async () => {
    const ctx = makeCtx({});
    const p = params(aiMcpClient, {
      credentialId: 'cred1',
      action: 'call_tool',
      tool_name: 'ping',
      arguments_json: '   ',
    });
    await aiMcpClient.execute(ctx, p, [item({})]);
    expect(ctx.mcpCallCalls[0]!.arguments).toEqual({});
  });

  it('runs once per node run (one callTool regardless of item count)', async () => {
    const ctx = makeCtx({});
    const p = params(aiMcpClient, { credentialId: 'cred1', action: 'call_tool', tool_name: 'ping' });
    await aiMcpClient.execute(ctx, p, [item({ a: 1 }), item({ a: 2 })]);
    expect(ctx.mcpCallCalls).toHaveLength(1);
  });

  it('merges the result onto every output item', async () => {
    const ctx = makeCtx({
      mcp: { callResult: { content: [], text: 'ok', isError: false } },
    });
    const p = params(aiMcpClient, { credentialId: 'cred1', action: 'call_tool', tool_name: 'ping' });
    const res = await aiMcpClient.execute(ctx, p, [item({ a: 1 }), item({ a: 2 })]);
    if (res.kind !== 'items') throw new Error('expected items');
    expect(res.outputs.main).toHaveLength(2);
    expect(res.outputs.main![0]!.json).toMatchObject({ a: 1, mcp: { result: { text: 'ok' } } });
    expect(res.outputs.main![1]!.json).toMatchObject({ a: 2, mcp: { result: { text: 'ok' } } });
  });

  it('preserves binary on passthrough items', async () => {
    const ctx = makeCtx({});
    const p = params(aiMcpClient, { credentialId: 'cred1', action: 'call_tool', tool_name: 'ping' });
    const withBinary = { json: { a: 1 }, binary: { file: { kind: 'tg_file_id' as const, fileId: 'f1' } } };
    const res = await aiMcpClient.execute(ctx, p, [withBinary]);
    if (res.kind !== 'items') throw new Error('expected items');
    expect(res.outputs.main![0]!.binary).toEqual(withBinary.binary);
  });

  it('fails loudly on a non-JSON arguments_json', async () => {
    const ctx = makeCtx({});
    const p = params(aiMcpClient, {
      credentialId: 'cred1',
      action: 'call_tool',
      tool_name: 'ping',
      arguments_json: 'not json',
    });
    const res = await aiMcpClient.execute(ctx, p, [item({})]);
    expect(res.kind).toBe('error');
    if (res.kind !== 'error') throw new Error('expected error');
    expect(res.message).toMatch(/not valid JSON/i);
    expect(ctx.mcpCallCalls).toHaveLength(0); // never reached the server
  });

  it('fails loudly when arguments_json is a JSON array/primitive (not an object)', async () => {
    const ctx = makeCtx({});
    const p = params(aiMcpClient, {
      credentialId: 'cred1',
      action: 'call_tool',
      tool_name: 'ping',
      arguments_json: '[1,2,3]',
    });
    const res = await aiMcpClient.execute(ctx, p, [item({})]);
    expect(res.kind).toBe('error');
    if (res.kind !== 'error') throw new Error('expected error');
    expect(res.message).toMatch(/must be a JSON object/i);
  });

  it('surfaces a transport/tool error from callTool', async () => {
    const ctx = makeCtx({ mcp: { callError: 'MCP server returned HTTP 502' } });
    const p = params(aiMcpClient, { credentialId: 'cred1', action: 'call_tool', tool_name: 'ping' });
    const res = await aiMcpClient.execute(ctx, p, [item({})]);
    expect(res.kind).toBe('error');
    if (res.kind !== 'error') throw new Error('expected error');
    expect(res.message).toMatch(/502/);
  });
});

// ── no MCP service ───────────────────────────────────────────────────────────

describe('ai.mcpClient — no MCP service', () => {
  it('fails loudly when ctx.mcp is null (list_tools)', async () => {
    const ctx = makeCtx({ mcp: null });
    const p = params(aiMcpClient, { credentialId: 'cred1', action: 'list_tools' });
    const res = await aiMcpClient.execute(ctx, p, [item({})]);
    expect(res.kind).toBe('error');
    if (res.kind !== 'error') throw new Error('expected error');
    expect(res.message).toMatch(/not available/i);
  });

  it('fails loudly when ctx.mcp is null (call_tool)', async () => {
    const ctx = makeCtx({ mcp: null });
    const p = params(aiMcpClient, { credentialId: 'cred1', action: 'call_tool', tool_name: 'ping' });
    const res = await aiMcpClient.execute(ctx, p, [item({})]);
    expect(res.kind).toBe('error');
  });
});
