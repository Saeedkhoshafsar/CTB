/**
 * P5-T3 — server side of ai.mcpClient: the `makeMcp` capability wired into the
 * engine, exercised end-to-end through a real wired engine + in-memory DB with
 * an INJECTED fetch (no network).
 *
 * We create an `mcpServer` credential (encrypted at rest — I7), build a
 * flow.manualTrigger → ai.mcpClient flow, run it, and assert:
 *   - the host POSTed a JSON-RPC envelope to the credential's URL with the
 *     `tools/list` / `tools/call` method, bearer auth, and an `accept` header
 *     that allows both JSON and SSE,
 *   - the decrypted key is used by the host but never surfaces in the response
 *     (I6/I7),
 *   - list_tools lands `{ tools }` and call_tool lands `{ result }` on the
 *     node's output item under `save_as`,
 *   - an SSE-framed provider response is parsed correctly,
 *   - a non-2xx provider response fails the run honestly,
 *   - a wrong-type credential is rejected before any network call.
 */
import type { FastifyInstance } from 'fastify';
import type { UserFromGetMe } from 'grammy/types';
import { afterEach, describe, expect, it } from 'vitest';
import { SESSION_COOKIE, buildApp } from '../src/app';
import { openDb, type Db } from '../src/db/index';
import { runMigrations } from '../src/db/migrate';
import { wireEngine, type Engine } from '../src/engine/wire';
import { loadEnv } from '../src/lib/env';

const SECRET = 'devsecret0123456';
const TOKEN = '123456789:AAEexampletokenexampletokenexample';
const BOT_INFO: UserFromGetMe = {
  id: 42, is_bot: true, first_name: 'TestBot', username: 'test_bot',
  can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: false,
  can_connect_to_business: false, has_main_web_app: false, can_manage_bots: false,
  has_topics_enabled: false, allows_users_to_create_topics: false,
};

/** A recording fake fetch. Returns a scripted MCP JSON-RPC response. */
interface FetchLog {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: { jsonrpc?: string; id?: unknown; method?: string; params?: unknown };
}
function makeFakeFetch(
  resp: { status: number; text: string },
  log: FetchLog[],
): typeof fetch {
  return (async (input: unknown, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[k.toLowerCase()] = v;
    }
    log.push({
      url: String(input),
      method: init?.method ?? 'GET',
      headers,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    return {
      status: resp.status,
      async text() {
        return resp.text;
      },
    } as Response;
  }) as unknown as typeof fetch;
}

interface World {
  app: FastifyInstance;
  db: Db;
  engine: Engine;
  cookie: { [k: string]: string };
  fetchLog: FetchLog[];
}

async function makeWorld(resp: { status: number; text: string }): Promise<World> {
  const env = loadEnv({ CTB_SECRET: SECRET, CTB_ADMIN_PASS: 'hunter2hunter2', NODE_ENV: 'test' } as NodeJS.ProcessEnv);
  const { db } = openDb(':memory:');
  runMigrations(db);
  const fetchLog: FetchLog[] = [];
  const engine = wireEngine({ db, ctbSecret: SECRET, fetchImpl: makeFakeFetch(resp, fetchLog), expressionBudgetMs: 5_000 });
  const app = buildApp({
    env, db, engine, logger: false, editorDistDir: '/nonexistent',
    botRegisterOpts: () => ({ botInfo: BOT_INFO, callApi: async () => ({ message_id: 1 }) }),
  });
  const login = await app.inject({
    method: 'POST', url: '/api/auth/login',
    payload: { username: 'admin', password: 'hunter2hunter2' },
  });
  const cookie = { [SESSION_COOKIE]: login.cookies.find((c) => c.name === SESSION_COOKIE)!.value };
  return { app, db, engine, cookie, fetchLog };
}

async function createBot(w: World): Promise<string> {
  const res = await w.app.inject({
    method: 'POST', url: '/api/bots', cookies: w.cookie, payload: { name: 'bot', token: TOKEN },
  });
  expect(res.statusCode).toBe(201);
  return res.json().bot.id as string;
}

async function createCredential(w: World, data: unknown): Promise<string> {
  const res = await w.app.inject({
    method: 'POST', url: '/api/credentials', cookies: w.cookie, payload: { name: 'mcp', data },
  });
  expect(res.statusCode).toBe(201);
  return res.json().credential.id as string;
}

async function createFlow(w: World, botId: string, graph: unknown): Promise<string> {
  const res = await w.app.inject({
    method: 'POST', url: '/api/flows', cookies: w.cookie, payload: { botId, name: 'mcp flow', graph },
  });
  expect(res.statusCode).toBe(201);
  return res.json().flow.id as string;
}

function mcpFlowGraph(credentialId: string, params: Record<string, unknown>) {
  return {
    nodes: [
      { id: 'trig', type: 'flow.manualTrigger', params: { sample: '{}' } },
      { id: 'mcp', type: 'ai.mcpClient', params: { credentialId, ...params } },
    ],
    edges: [{ id: 'e1', from: { node: 'trig', port: 'main' }, to: { node: 'mcp', port: 'main' } }],
  };
}

/** Pull the ai.mcpClient node's first output item json out of the execution logs. */
async function mcpOutputItem(w: World, executionId: string): Promise<Record<string, unknown>> {
  const detail = await w.app.inject({
    method: 'GET', url: `/api/executions/${executionId}`, cookies: w.cookie,
  });
  const logs = detail.json().execution.logs as {
    nodeId: string | null;
    output: Record<string, { json: Record<string, unknown> }[]> | null;
  }[];
  const row = logs.find((l) => l.nodeId === 'mcp' && l.output);
  expect(row).toBeTruthy();
  return row!.output!.main![0]!.json;
}

describe('ai.mcpClient via wired engine (P5-T3)', () => {
  let w: World;
  afterEach(async () => { await w.engine.gateway.stopAll(); await w.app.close(); });

  it('list_tools: POSTs a tools/list JSON-RPC envelope with bearer auth and merges { tools }', async () => {
    const body = {
      jsonrpc: '2.0', id: '1',
      result: { tools: [{ name: 'echo', description: 'Echo back', inputSchema: { type: 'object' } }, { name: 'add' }] },
    };
    w = await makeWorld({ status: 200, text: JSON.stringify(body) });
    const botId = await createBot(w);
    const credId = await createCredential(w, {
      type: 'mcpServer', url: 'https://mcp.example.com/rpc', apiKey: 'mcp-secret-xyz',
    });
    const flowId = await createFlow(w, botId, mcpFlowGraph(credId, { action: 'list_tools', save_as: 'mcp' }));

    const res = await w.app.inject({ method: 'POST', url: `/api/flows/${flowId}/run`, cookies: w.cookie });
    expect(res.statusCode).toBe(200);
    const out = res.json();
    expect(out.status).toBe('done');

    // The host hit the MCP endpoint exactly once with the right JSON-RPC shape.
    expect(w.fetchLog).toHaveLength(1);
    const call = w.fetchLog[0]!;
    expect(call.url).toBe('https://mcp.example.com/rpc');
    expect(call.method).toBe('POST');
    expect(call.headers.authorization).toBe('Bearer mcp-secret-xyz');
    expect(call.headers['content-type']).toBe('application/json');
    expect(call.headers.accept).toContain('application/json');
    expect(call.headers.accept).toContain('text/event-stream');
    expect(call.body.jsonrpc).toBe('2.0');
    expect(call.body.method).toBe('tools/list');
    expect(call.body.id).toBeTruthy();

    // The secret never appears in the run response (I7).
    expect(JSON.stringify(out)).not.toContain('mcp-secret-xyz');

    // The tools list landed on the node output.
    const item = await mcpOutputItem(w, out.executionId);
    const merged = item.mcp as { tools: { name: string; description?: string }[] };
    expect(merged.tools).toHaveLength(2);
    expect(merged.tools[0]!.name).toBe('echo');
    expect(merged.tools[0]!.description).toBe('Echo back');
    expect(merged.tools[1]!.name).toBe('add');
  });

  it('call_tool: forwards name + parsed arguments and merges { result }', async () => {
    const body = {
      jsonrpc: '2.0', id: '1',
      result: { content: [{ type: 'text', text: 'pong' }], isError: false },
    };
    w = await makeWorld({ status: 200, text: JSON.stringify(body) });
    const botId = await createBot(w);
    const credId = await createCredential(w, {
      type: 'mcpServer', url: 'https://mcp.example.com/rpc', apiKey: 'mcp-secret-xyz',
    });
    const flowId = await createFlow(
      w, botId,
      mcpFlowGraph(credId, {
        action: 'call_tool', tool_name: 'echo', arguments_json: '{"msg":"ping"}', save_as: 'mcp',
      }),
    );

    const res = await w.app.inject({ method: 'POST', url: `/api/flows/${flowId}/run`, cookies: w.cookie });
    expect(res.statusCode).toBe(200);
    const out = res.json();
    expect(out.status).toBe('done');

    expect(w.fetchLog).toHaveLength(1);
    const call = w.fetchLog[0]!;
    expect(call.body.method).toBe('tools/call');
    expect(call.body.params).toEqual({ name: 'echo', arguments: { msg: 'ping' } });

    const item = await mcpOutputItem(w, out.executionId);
    const merged = item.mcp as { result: { text: string; isError: boolean; content: unknown[] } };
    expect(merged.result.text).toBe('pong');
    expect(merged.result.isError).toBe(false);
    expect(merged.result.content).toEqual([{ type: 'text', text: 'pong' }]);
  });

  it('parses an SSE-framed MCP response', async () => {
    const payload = JSON.stringify({ jsonrpc: '2.0', id: '1', result: { tools: [{ name: 'only' }] } });
    const sse = `event: message\ndata: ${payload}\n\n`;
    w = await makeWorld({ status: 200, text: sse });
    const botId = await createBot(w);
    const credId = await createCredential(w, { type: 'mcpServer', url: 'https://mcp.example.com/rpc' });
    const flowId = await createFlow(w, botId, mcpFlowGraph(credId, { action: 'list_tools', save_as: 'mcp' }));

    const res = await w.app.inject({ method: 'POST', url: `/api/flows/${flowId}/run`, cookies: w.cookie });
    const out = res.json();
    expect(out.status).toBe('done');
    // No apiKey on this credential → no bearer header.
    expect(w.fetchLog[0]!.headers.authorization).toBeUndefined();

    const item = await mcpOutputItem(w, out.executionId);
    const merged = item.mcp as { tools: { name: string }[] };
    expect(merged.tools).toEqual([{ name: 'only' }]);
  });

  it('fails the run when the MCP server returns a non-2xx status', async () => {
    w = await makeWorld({ status: 502, text: 'upstream boom' });
    const botId = await createBot(w);
    const credId = await createCredential(w, { type: 'mcpServer', url: 'https://mcp.example.com/rpc' });
    const flowId = await createFlow(w, botId, mcpFlowGraph(credId, { action: 'list_tools', save_as: 'mcp' }));
    const res = await w.app.inject({ method: 'POST', url: `/api/flows/${flowId}/run`, cookies: w.cookie });
    const out = res.json();
    expect(out.status).toBe('error');
    expect(out.error).toMatch(/HTTP 502/);
  });

  it('surfaces a JSON-RPC error envelope as a failed run', async () => {
    const body = { jsonrpc: '2.0', id: '1', error: { code: -32601, message: 'Method not found' } };
    w = await makeWorld({ status: 200, text: JSON.stringify(body) });
    const botId = await createBot(w);
    const credId = await createCredential(w, { type: 'mcpServer', url: 'https://mcp.example.com/rpc' });
    const flowId = await createFlow(
      w, botId, mcpFlowGraph(credId, { action: 'call_tool', tool_name: 'nope', save_as: 'mcp' }),
    );
    const res = await w.app.inject({ method: 'POST', url: `/api/flows/${flowId}/run`, cookies: w.cookie });
    const out = res.json();
    expect(out.status).toBe('error');
    expect(out.error).toMatch(/Method not found/);
  });

  it('rejects a credential that is not an mcpServer type, before any network call', async () => {
    w = await makeWorld({ status: 200, text: '{}' });
    const botId = await createBot(w);
    const credId = await createCredential(w, { type: 'httpBearerAuth', token: 'tok_abcdefghij' });
    const flowId = await createFlow(w, botId, mcpFlowGraph(credId, { action: 'list_tools', save_as: 'mcp' }));
    const res = await w.app.inject({ method: 'POST', url: `/api/flows/${flowId}/run`, cookies: w.cookie });
    const out = res.json();
    expect(out.status).toBe('error');
    expect(out.error).toMatch(/not an MCP server credential/);
    expect(w.fetchLog).toHaveLength(0); // never reached the network
  });
});
