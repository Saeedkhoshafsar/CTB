/**
 * PC-T3 — CTB as an MCP *server* (POST /api/v1/mcp, JSON-RPC 2.0 over
 * streamable-HTTP), over a real in-memory SQLite DB + fully wired engine with a
 * fake Telegram transport. The collection store is wired (sqlite passed to
 * wireEngine) so the `query_collection` tool is live.
 *
 * Covers the PROTOCOL.md §MCP server contract:
 *  • bearer auth — the endpoint sits inside the same scope as REST v1, so a
 *    missing/garbage token is 401 before any JSON-RPC is parsed
 *  • initialize → protocolVersion + serverInfo + tools capability
 *  • notifications (no id) → 202, no body
 *  • tools/list → the 6 CTB tools with JSON-Schema inputs
 *  • tools/call: list_nodes (= the REST catalog), validate_flow (dry-run),
 *    create_flow (draft persisted), trigger_flow (execution row), send_message
 *    (centralized sender invoked), query_collection (records read)
 *  • bot scope — a bot-scoped token gets a tool-level error on another bot
 *  • protocol errors — bad JSON-RPC, unknown method, unknown tool
 */
import {
  FlowGraphSchema,
  MCP_PROTOCOL_VERSION,
  type ApiTokenCreated,
  type FlowGraph,
  type JsonRpcResponse,
} from '@ctb/shared';
import type { FastifyInstance } from 'fastify';
import type { UserFromGetMe } from 'grammy/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SESSION_COOKIE, buildApp } from '../src/app';
import { openDb, type Db } from '../src/db/index';
import { runMigrations } from '../src/db/migrate';
import { wireEngine, type Engine } from '../src/engine/wire';
import { nodeTypeInfos } from '../src/api/node-types';
import { loadEnv } from '../src/lib/env';

const SECRET = 'devsecret0123456';
const TG_TOKEN = '123456789:AAEexampletokenexampletokenexample';

const BOT_INFO: UserFromGetMe = {
  id: 42, is_bot: true, first_name: 'TestBot', username: 'test_bot',
  can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: false,
  can_connect_to_business: false, has_main_web_app: false, can_manage_bots: false,
  has_topics_enabled: false, allows_users_to_create_topics: false,
};

interface SentCall {
  method: string;
  payload: Record<string, unknown>;
}

interface World {
  app: FastifyInstance;
  db: Db;
  engine: Engine;
  cookie: { [k: string]: string };
  sent: SentCall[];
}

async function makeWorld(): Promise<World> {
  const env = loadEnv({
    CTB_SECRET: SECRET, CTB_ADMIN_PASS: 'hunter2hunter2', NODE_ENV: 'test',
  } as NodeJS.ProcessEnv);
  // CRITICAL: pass `sqlite` so the engine wires the SqliteCollectionStore —
  // that is what makes the MCP query_collection tool live (else it reports
  // collections_not_available).
  const { db, sqlite } = openDb(':memory:');
  runMigrations(db);
  const engine = wireEngine({ db, sqlite, ctbSecret: SECRET });
  const sent: SentCall[] = [];
  const app = buildApp({
    env, db, sqlite, engine, logger: false, editorDistDir: '/nonexistent',
    botRegisterOpts: () => ({
      botInfo: BOT_INFO,
      callApi: async (method: string, payload: Record<string, unknown>) => {
        sent.push({ method, payload });
        return { message_id: 777 };
      },
    }),
  });
  const login = await app.inject({
    method: 'POST', url: '/api/auth/login',
    payload: { username: 'admin', password: 'hunter2hunter2' },
  });
  const cookie = { [SESSION_COOKIE]: login.cookies.find((c) => c.name === SESSION_COOKIE)!.value };
  return { app, db, engine, cookie, sent };
}

/** A minimal activatable flow: manual trigger → setFields. */
function triggerGraph(): FlowGraph {
  return FlowGraphSchema.parse({
    nodes: [
      { id: 'trig', type: 'flow.manualTrigger', params: { sample: '{}' }, position: { x: 0, y: 0 }, disabled: false },
      {
        id: 'set', type: 'data.setFields',
        params: { fields: [{ target: 'json', name: 'seen', value: 'yes', op: 'set' }] },
        position: { x: 200, y: 0 }, disabled: false,
      },
    ],
    edges: [{ id: 'e1', from: { node: 'trig', port: 'main' }, to: { node: 'set', port: 'main' } }],
  });
}

/** A structurally-valid graph with NO trigger node (not activatable). */
function noTriggerGraph(): FlowGraph {
  return FlowGraphSchema.parse({
    nodes: [
      {
        id: 'set', type: 'data.setFields',
        params: { fields: [{ target: 'json', name: 'seen', value: 'yes', op: 'set' }] },
        position: { x: 0, y: 0 }, disabled: false,
      },
    ],
    edges: [],
  });
}

async function createBot(w: World, name = 'b'): Promise<string> {
  const { bot } = (
    await w.app.inject({
      method: 'POST', url: '/api/bots', cookies: w.cookie, payload: { name, token: TG_TOKEN },
    })
  ).json() as { bot: { id: string } };
  return bot.id;
}

async function startBot(w: World, botId: string): Promise<void> {
  const res = await w.app.inject({ method: 'POST', url: `/api/bots/${botId}/start`, cookies: w.cookie });
  expect(res.statusCode).toBe(200);
}

async function createFlow(w: World, botId: string, graph: FlowGraph): Promise<string> {
  const { flow } = (
    await w.app.inject({
      method: 'POST', url: '/api/flows', cookies: w.cookie, payload: { botId, name: 'f', graph },
    })
  ).json() as { flow: { id: string } };
  return flow.id;
}

async function createToken(w: World, opts: { botId?: string } = {}): Promise<ApiTokenCreated> {
  const res = await w.app.inject({
    method: 'POST', url: '/api/api-tokens', cookies: w.cookie,
    payload: { name: 'ci', ...(opts.botId ? { botId: opts.botId } : {}) },
  });
  expect(res.statusCode).toBe(201);
  return (res.json() as { apiToken: ApiTokenCreated }).apiToken;
}

async function defineCollection(w: World, botId: string, slug: string): Promise<string> {
  const res = await w.app.inject({
    method: 'POST', url: `/api/collections?botId=${botId}`, cookies: w.cookie,
    payload: {
      slug, name: slug,
      schema: { fields: [{ key: 'title', type: 'text', required: true, indexed: true }] },
    },
  });
  expect(res.statusCode).toBe(201);
  return res.json().collection.id as string;
}

async function insertRecord(w: World, collectionId: string, data: Record<string, unknown>): Promise<void> {
  const res = await w.app.inject({
    method: 'POST', url: `/api/records/${collectionId}`, cookies: w.cookie, payload: { data },
  });
  expect(res.statusCode).toBe(201);
}

function bearer(token: string): { authorization: string } {
  return { authorization: `Bearer ${token}` };
}

/** Send one JSON-RPC message to the MCP endpoint. */
async function rpc(
  w: World,
  token: string,
  body: Record<string, unknown>,
): Promise<{ status: number; json: JsonRpcResponse }> {
  const res = await w.app.inject({
    method: 'POST', url: '/api/v1/mcp', headers: bearer(token), payload: body,
  });
  return { status: res.statusCode, json: res.body ? (res.json() as JsonRpcResponse) : ({} as JsonRpcResponse) };
}

/** Run a tools/call and parse the single JSON text block back into an object. */
async function callTool(
  w: World, token: string, name: string, args: Record<string, unknown> = {},
): Promise<{ rpc: JsonRpcResponse; result: { content: { type: string; text: string }[]; isError?: boolean }; data: any }> {
  const { json } = await rpc(w, token, {
    jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args },
  });
  const result = json.result as { content: { type: string; text: string }[]; isError?: boolean };
  const data = JSON.parse(result.content[0]!.text);
  return { rpc: json, result, data };
}

describe('MCP server — protocol handshake + auth (PC-T3)', () => {
  let w: World;
  beforeEach(async () => { w = await makeWorld(); });
  afterEach(async () => { await w.engine.gateway.stopAll(); await w.app.close(); });

  it('rejects a missing bearer with 401 (shared v1 auth guard)', async () => {
    const res = await w.app.inject({
      method: 'POST', url: '/api/v1/mcp',
      payload: { jsonrpc: '2.0', id: 1, method: 'initialize' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('rejects a garbage bearer with 401', async () => {
    const { status } = await rpc(w, 'ctb_not_a_real_token', { jsonrpc: '2.0', id: 1, method: 'ping' });
    expect(status).toBe(401);
  });

  it('initialize returns the protocol version, server info, and tools capability', async () => {
    const tok = await createToken(w);
    const { json } = await rpc(w, tok.token, { jsonrpc: '2.0', id: 7, method: 'initialize' });
    expect(json.id).toBe(7);
    const r = json.result as Record<string, any>;
    expect(r.protocolVersion).toBe(MCP_PROTOCOL_VERSION);
    expect(r.serverInfo.name).toBe('ctb');
    expect(r.capabilities.tools).toBeDefined();
  });

  it('ping returns an empty result', async () => {
    const tok = await createToken(w);
    const { json } = await rpc(w, tok.token, { jsonrpc: '2.0', id: 2, method: 'ping' });
    expect(json.result).toEqual({});
  });

  it('a notification (no id) is acked 202 with no JSON-RPC body', async () => {
    const tok = await createToken(w);
    const res = await w.app.inject({
      method: 'POST', url: '/api/v1/mcp', headers: bearer(tok.token),
      payload: { jsonrpc: '2.0', method: 'notifications/initialized' },
    });
    expect(res.statusCode).toBe(202);
    expect(res.body).toBe('');
  });

  it('a malformed JSON-RPC message → invalidRequest error (-32600)', async () => {
    const tok = await createToken(w);
    const { json } = await rpc(w, tok.token, { not: 'jsonrpc' });
    expect(json.error?.code).toBe(-32600);
  });

  it('an unknown method → methodNotFound error (-32601)', async () => {
    const tok = await createToken(w);
    const { json } = await rpc(w, tok.token, { jsonrpc: '2.0', id: 3, method: 'does/not/exist' });
    expect(json.error?.code).toBe(-32601);
  });
});

describe('MCP server — tools/list (PC-T3)', () => {
  let w: World;
  beforeEach(async () => { w = await makeWorld(); });
  afterEach(async () => { await w.engine.gateway.stopAll(); await w.app.close(); });

  it('advertises exactly the six CTB tools, each with a JSON-Schema input', async () => {
    const tok = await createToken(w);
    const { json } = await rpc(w, tok.token, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    const tools = (json.result as { tools: { name: string; inputSchema: unknown }[] }).tools;
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([
      'create_flow', 'list_nodes', 'query_collection', 'send_message', 'trigger_flow', 'validate_flow',
    ]);
    for (const t of tools) {
      expect((t.inputSchema as { type: string }).type).toBe('object');
    }
  });
});

describe('MCP server — tools/call (PC-T3)', () => {
  let w: World;
  beforeEach(async () => { w = await makeWorld(); });
  afterEach(async () => { await w.engine.gateway.stopAll(); await w.app.close(); });

  it('list_nodes returns the SAME catalog as the REST node-types projection', async () => {
    const tok = await createToken(w);
    const { data } = await callTool(w, tok.token, 'list_nodes');
    expect(data).toEqual({ nodeTypes: nodeTypeInfos(w.engine.registry) });
    expect(data.nodeTypes.some((n: { type: string }) => n.type === 'tg.sendMessage')).toBe(true);
  });

  it('validate_flow: a good graph → ok:true; a no-trigger graph → ok:false with a problem', async () => {
    const tok = await createToken(w);
    const good = await callTool(w, tok.token, 'validate_flow', { graph: triggerGraph() });
    expect(good.data.ok).toBe(true);
    expect(good.data.problems).toEqual([]);

    const bad = await callTool(w, tok.token, 'validate_flow', { graph: noTriggerGraph() });
    expect(bad.data.ok).toBe(false);
    expect(bad.data.problems.length).toBeGreaterThan(0);
  });

  it('validate_flow with a malformed graph → a tool-level error (isError)', async () => {
    const tok = await createToken(w);
    const { result, data } = await callTool(w, tok.token, 'validate_flow', { graph: { nodes: 'nope' } });
    expect(result.isError).toBe(true);
    expect(data.error).toBe('invalid_arguments');
  });

  it('create_flow persists a DRAFT (snake_case bot_id alias) the REST API can read', async () => {
    const botId = await createBot(w);
    const tok = await createToken(w);
    const { data } = await callTool(w, tok.token, 'create_flow', {
      bot_id: botId, name: 'mcp-built', graph: triggerGraph(),
    });
    expect(data.flow.status).toBe('draft');
    expect(data.flow.botId).toBe(botId);

    // The REST surface sees the same flow → no drift (I5).
    const got = await w.app.inject({
      method: 'POST', url: `/api/v1/flows/${data.flow.id}/validate`, headers: bearer(tok.token),
    });
    expect(got.statusCode).toBe(200);
    expect((got.json() as { ok: boolean }).ok).toBe(true);
  });

  it('create_flow with an unknown bot → unknown_bot tool error', async () => {
    const tok = await createToken(w);
    const { result, data } = await callTool(w, tok.token, 'create_flow', {
      bot_id: 'nope', name: 'x', graph: triggerGraph(),
    });
    expect(result.isError).toBe(true);
    expect(data.error).toBe('unknown_bot');
  });

  it('trigger_flow starts a real execution', async () => {
    const botId = await createBot(w);
    const flowId = await createFlow(w, botId, triggerGraph());
    const tok = await createToken(w);
    const { data } = await callTool(w, tok.token, 'trigger_flow', { flow_id: flowId });
    expect(data.ok).toBe(true);
    expect(typeof data.executionId).toBe('string');

    // The execution row appears via the REST executions list.
    await new Promise((r) => setTimeout(r, 50));
    const list = await w.app.inject({
      method: 'GET', url: `/api/v1/executions?flow_id=${flowId}`, headers: bearer(tok.token),
    });
    expect((list.json() as { executions: unknown[] }).executions.length).toBeGreaterThanOrEqual(1);
  });

  it('trigger_flow on a missing flow → flow_not_found tool error', async () => {
    const tok = await createToken(w);
    const { result, data } = await callTool(w, tok.token, 'trigger_flow', { flow_id: 'ghost' });
    expect(result.isError).toBe(true);
    expect(data.error).toBe('flow_not_found');
  });

  it('send_message goes through the centralized sender of a running bot', async () => {
    const botId = await createBot(w);
    await startBot(w, botId);
    const tok = await createToken(w);
    const { data } = await callTool(w, tok.token, 'send_message', {
      bot_id: botId, chat_id: 555, text: 'hi from mcp',
    });
    expect(data.ok).toBe(true);
    const sent = w.sent.find((s) => s.method === 'sendMessage');
    expect(sent?.payload.chat_id).toBe(555);
    expect(sent?.payload.text).toBe('hi from mcp');
  });

  it('send_message to a non-running bot → bot_not_running tool error', async () => {
    const botId = await createBot(w);
    const tok = await createToken(w);
    const { result, data } = await callTool(w, tok.token, 'send_message', {
      bot_id: botId, chat_id: 1, text: 'x',
    });
    expect(result.isError).toBe(true);
    expect(data.error).toBe('bot_not_running');
  });

  it('query_collection reads records of a bot collection', async () => {
    const botId = await createBot(w);
    const colId = await defineCollection(w, botId, 'todos');
    await insertRecord(w, colId, { title: 'first' });
    await insertRecord(w, colId, { title: 'second' });
    const tok = await createToken(w);

    const { data } = await callTool(w, tok.token, 'query_collection', {
      bot_id: botId, collection: 'todos',
    });
    expect(data.total).toBe(2);
    expect(data.records.map((r: { data: { title: string } }) => r.data.title).sort()).toEqual(['first', 'second']);
  });

  it('query_collection honors a where filter', async () => {
    const botId = await createBot(w);
    const colId = await defineCollection(w, botId, 'todos');
    await insertRecord(w, colId, { title: 'keep' });
    await insertRecord(w, colId, { title: 'drop' });
    const tok = await createToken(w);

    const { data } = await callTool(w, tok.token, 'query_collection', {
      bot_id: botId, collection: 'todos', filter: { where: [{ field: 'title', op: 'eq', value: 'keep' }] },
    });
    expect(data.total).toBe(1);
    expect(data.records[0].data.title).toBe('keep');
  });

  it('query_collection on an unknown slug → collection_not_found tool error', async () => {
    const botId = await createBot(w);
    const tok = await createToken(w);
    const { result, data } = await callTool(w, tok.token, 'query_collection', {
      bot_id: botId, collection: 'ghost',
    });
    expect(result.isError).toBe(true);
    expect(data.error).toBe('collection_not_found');
  });

  it('an unknown tool name → invalidParams JSON-RPC error', async () => {
    const tok = await createToken(w);
    const { json } = await rpc(w, tok.token, {
      jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'no_such_tool', arguments: {} },
    });
    expect(json.error?.code).toBe(-32602);
  });
});

describe('MCP server — bot-scoped tokens (PC-T3)', () => {
  let w: World;
  beforeEach(async () => { w = await makeWorld(); });
  afterEach(async () => { await w.engine.gateway.stopAll(); await w.app.close(); });

  it('a bot-scoped token cannot author/trigger/query/send on ANOTHER bot', async () => {
    const botA = await createBot(w, 'A');
    const botB = await createBot(w, 'B');
    const colB = await defineCollection(w, botB, 'todos');
    await insertRecord(w, colB, { title: 'b-only' });
    const flowB = await createFlow(w, botB, triggerGraph());
    const tokA = await createToken(w, { botId: botA });

    const create = await callTool(w, tokA.token, 'create_flow', {
      bot_id: botB, name: 'x', graph: triggerGraph(),
    });
    expect(create.result.isError).toBe(true);
    expect(create.data.error).toBe('token_not_authorized_for_bot');

    const trigger = await callTool(w, tokA.token, 'trigger_flow', { flow_id: flowB });
    expect(trigger.result.isError).toBe(true);
    expect(trigger.data.error).toBe('token_not_authorized_for_bot');

    const query = await callTool(w, tokA.token, 'query_collection', { bot_id: botB, collection: 'todos' });
    expect(query.result.isError).toBe(true);
    expect(query.data.error).toBe('token_not_authorized_for_bot');

    const send = await callTool(w, tokA.token, 'send_message', { bot_id: botB, chat_id: 1, text: 'x' });
    expect(send.result.isError).toBe(true);
    expect(send.data.error).toBe('token_not_authorized_for_bot');
  });

  it('list_nodes works for any valid token (the catalog is bot-agnostic)', async () => {
    const botA = await createBot(w, 'A');
    const tokA = await createToken(w, { botId: botA });
    const { result, data } = await callTool(w, tokA.token, 'list_nodes');
    expect(result.isError).toBeUndefined();
    expect(data.nodeTypes.length).toBeGreaterThan(0);
  });
});
