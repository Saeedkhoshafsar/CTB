/**
 * P4-T3 — Public REST API v1 (bearer tokens) + API-token management tests,
 * over a real in-memory SQLite DB + fully wired engine (fake Telegram transport).
 *
 * Covers the PROTOCOL.md §Inbound REST API contract:
 *  • token CRUD: create returns plaintext ONCE (never stored), list hides it,
 *    delete revokes; the at-rest row carries only a hash + display prefix
 *  • bearer auth: missing → 401, garbage → 401, valid → through; last_used_at stamped
 *  • POST /api/v1/flows/:id/trigger → 202 + a real execution row appears
 *  • POST /api/v1/bots/:id/send → 200 + the centralized sender is invoked;
 *    bot that isn't running → 409
 *  • GET /api/v1/executions / /api/v1/users behave + honor filters
 *  • bot-scoped token: 403 on a different bot's flow/bot/executions/users
 */
import {
  FlowGraphSchema,
  type ApiTokenCreated,
  type ApiTokenPublic,
  type FlowGraph,
} from '@ctb/shared';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { UserFromGetMe } from 'grammy/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SESSION_COOKIE, buildApp } from '../src/app';
import { openDb, schema, type Db } from '../src/db/index';
import { runMigrations } from '../src/db/migrate';
import { wireEngine, type Engine } from '../src/engine/wire';
import { hashApiToken } from '../src/lib/api-token';
import { nodeTypeInfos } from '../src/api/node-types';
import { loadEnv } from '../src/lib/env';

const SECRET = 'devsecret0123456';
const TOKEN = '123456789:AAEexampletokenexampletokenexample';

const BOT_INFO: UserFromGetMe = {
  id: 42, is_bot: true, first_name: 'TestBot', username: 'test_bot',
  can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: false,
  can_connect_to_business: false, has_main_web_app: false, can_manage_bots: false,
  has_topics_enabled: false, allows_users_to_create_topics: false,
};

/** Captured outbound Telegram calls, so the send endpoint is observable. */
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
  const { db } = openDb(':memory:');
  runMigrations(db);
  const engine = wireEngine({ db, ctbSecret: SECRET, expressionBudgetMs: 5_000 });
  const sent: SentCall[] = [];
  const app = buildApp({
    env, db, engine, logger: false, editorDistDir: '/nonexistent',
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

/** A minimal flow: manual trigger → setFields (so a run reaches a terminal state). */
function triggerGraph(): FlowGraph {
  return FlowGraphSchema.parse({
    nodes: [
      {
        id: 'trig', type: 'flow.manualTrigger',
        params: { sample: '{}' }, position: { x: 0, y: 0 }, disabled: false,
      },
      {
        id: 'set', type: 'data.setFields',
        params: { fields: [{ target: 'json', name: 'seen', value: 'yes', op: 'set' }] },
        position: { x: 200, y: 0 }, disabled: false,
      },
    ],
    edges: [{ id: 'e1', from: { node: 'trig', port: 'main' }, to: { node: 'set', port: 'main' } }],
  });
}

/** A structurally-valid graph that is NOT activatable — it has no trigger node. */
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
      method: 'POST', url: '/api/bots', cookies: w.cookie,
      payload: { name, token: TOKEN },
    })
  ).json() as { bot: { id: string } };
  return bot.id;
}

async function createFlow(w: World, botId: string, graph: FlowGraph): Promise<string> {
  const { flow } = (
    await w.app.inject({
      method: 'POST', url: '/api/flows', cookies: w.cookie,
      payload: { botId, name: 'api flow', graph },
    })
  ).json() as { flow: { id: string } };
  return flow.id;
}

async function startBot(w: World, botId: string): Promise<void> {
  const res = await w.app.inject({ method: 'POST', url: `/api/bots/${botId}/start`, cookies: w.cookie });
  expect(res.statusCode).toBe(200);
}

/** Create a token (optionally bot-scoped); returns the plaintext + its id. */
async function createToken(
  w: World,
  opts: { name?: string; botId?: string } = {},
): Promise<ApiTokenCreated> {
  const res = await w.app.inject({
    method: 'POST', url: '/api/api-tokens', cookies: w.cookie,
    payload: { name: opts.name ?? 'ci', ...(opts.botId ? { botId: opts.botId } : {}) },
  });
  expect(res.statusCode).toBe(201);
  return (res.json() as { apiToken: ApiTokenCreated }).apiToken;
}

function bearer(token: string): { authorization: string } {
  return { authorization: `Bearer ${token}` };
}

describe('API-token management (P4-T3)', () => {
  let w: World;
  beforeEach(async () => { w = await makeWorld(); });
  afterEach(async () => { await w.engine.gateway.stopAll(); await w.app.close(); });

  it('requires the panel session (401 without cookie)', async () => {
    const res = await w.app.inject({ method: 'GET', url: '/api/api-tokens' });
    expect(res.statusCode).toBe(401);
  });

  it('create returns the plaintext ONCE; only a hash + prefix are stored', async () => {
    const created = await createToken(w);
    expect(created.token).toMatch(/^ctb_/);
    expect(created.prefix).toBe(created.token.slice(0, 10));
    expect(created.botId).toBeNull();

    // The at-rest row never holds the plaintext.
    const row = w.db.select().from(schema.apiTokens).where(eq(schema.apiTokens.id, created.id)).get()!;
    expect(row.tokenHash).toBe(hashApiToken(created.token));
    expect(JSON.stringify(row)).not.toContain(created.token);

    // The list never re-reveals the token.
    const list = (await w.app.inject({ method: 'GET', url: '/api/api-tokens', cookies: w.cookie })).json() as {
      tokens: ApiTokenPublic[];
    };
    expect(list.tokens).toHaveLength(1);
    expect(JSON.stringify(list.tokens)).not.toContain(created.token);
  });

  it('rejects a bot scope that does not exist', async () => {
    const res = await w.app.inject({
      method: 'POST', url: '/api/api-tokens', cookies: w.cookie,
      payload: { name: 'x', botId: 'nope' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('unknown_bot');
  });

  it('delete revokes the token', async () => {
    const created = await createToken(w);
    const del = await w.app.inject({
      method: 'DELETE', url: `/api/api-tokens/${created.id}`, cookies: w.cookie,
    });
    expect(del.statusCode).toBe(200);
    // The revoked token no longer authenticates v1.
    const after = await w.app.inject({
      method: 'GET', url: '/api/v1/users?bot_id=x', headers: bearer(created.token),
    });
    expect(after.statusCode).toBe(401);
  });
});

describe('v1 bearer auth (P4-T3)', () => {
  let w: World;
  beforeEach(async () => { w = await makeWorld(); });
  afterEach(async () => { await w.engine.gateway.stopAll(); await w.app.close(); });

  it('missing bearer → 401', async () => {
    const res = await w.app.inject({ method: 'GET', url: '/api/v1/users?bot_id=x' });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe('missing_bearer_token');
  });

  it('garbage token → 401', async () => {
    const res = await w.app.inject({
      method: 'GET', url: '/api/v1/users?bot_id=x', headers: bearer('ctb_notreal'),
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe('invalid_token');
  });

  it('valid token authenticates and stamps last_used_at', async () => {
    const botId = await createBot(w);
    const created = await createToken(w);
    expect(created.lastUsedAt).toBeNull();

    const res = await w.app.inject({
      method: 'GET', url: `/api/v1/users?bot_id=${botId}`, headers: bearer(created.token),
    });
    expect(res.statusCode).toBe(200);

    const row = w.db.select().from(schema.apiTokens).where(eq(schema.apiTokens.id, created.id)).get()!;
    expect(row.lastUsedAt).not.toBeNull();
  });
});

describe('v1 endpoints (P4-T3)', () => {
  let w: World;
  beforeEach(async () => { w = await makeWorld(); });
  afterEach(async () => { await w.engine.gateway.stopAll(); await w.app.close(); });

  it('POST /api/v1/flows/:id/trigger → 202 and an execution is created', async () => {
    const botId = await createBot(w);
    const flowId = await createFlow(w, botId, triggerGraph());
    const token = (await createToken(w)).token;

    const res = await w.app.inject({
      method: 'POST', url: `/api/v1/flows/${flowId}/trigger`,
      headers: bearer(token), payload: { payload: { hello: 'world' } },
    });
    expect(res.statusCode).toBe(202);
    const body = res.json() as { ok: boolean; executionId: string };
    expect(body.ok).toBe(true);

    const rows = w.db.select().from(schema.executions).where(eq(schema.executions.flowId, flowId)).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(body.executionId);
  });

  it('trigger on an unknown flow → 404', async () => {
    const token = (await createToken(w)).token;
    const res = await w.app.inject({
      method: 'POST', url: '/api/v1/flows/nope/trigger', headers: bearer(token), payload: {},
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('flow_not_found');
  });

  it('POST /api/v1/bots/:id/send → 200 and the sender is invoked', async () => {
    const botId = await createBot(w);
    await startBot(w, botId);
    const token = (await createToken(w)).token;

    const res = await w.app.inject({
      method: 'POST', url: `/api/v1/bots/${botId}/send`,
      headers: bearer(token), payload: { chat_id: 555, text: 'سلام' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, messageId: 777 });

    const send = w.sent.find((c) => c.method === 'sendMessage');
    expect(send).toBeTruthy();
    expect(send!.payload).toMatchObject({ chat_id: 555, text: 'سلام' });
  });

  it('send to a bot that is not running → 409', async () => {
    const botId = await createBot(w); // created but never started → no sender
    const token = (await createToken(w)).token;
    const res = await w.app.inject({
      method: 'POST', url: `/api/v1/bots/${botId}/send`,
      headers: bearer(token), payload: { chat_id: 1, text: 'hi' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('bot_not_running');
  });

  it('send with an inline keyboard maps to reply_markup', async () => {
    const botId = await createBot(w);
    await startBot(w, botId);
    const token = (await createToken(w)).token;

    const res = await w.app.inject({
      method: 'POST', url: `/api/v1/bots/${botId}/send`,
      headers: bearer(token),
      payload: {
        chat_id: 1, text: 'pick',
        keyboard: { kind: 'inline', rows: [[{ text: 'A', kind: 'callback', value: 'a' }]] },
      },
    });
    expect(res.statusCode).toBe(200);
    const send = w.sent.find((c) => c.method === 'sendMessage')!;
    expect(send.payload.reply_markup).toBeTruthy();
  });

  it('GET /api/v1/executions lists + filters by status', async () => {
    const botId = await createBot(w);
    const flowId = await createFlow(w, botId, triggerGraph());
    const token = (await createToken(w)).token;

    await w.app.inject({
      method: 'POST', url: `/api/v1/flows/${flowId}/trigger`, headers: bearer(token), payload: {},
    });

    const all = await w.app.inject({ method: 'GET', url: '/api/v1/executions', headers: bearer(token) });
    expect(all.statusCode).toBe(200);
    expect((all.json() as { executions: unknown[] }).executions.length).toBe(1);

    const bad = await w.app.inject({
      method: 'GET', url: '/api/v1/executions?status=nope', headers: bearer(token),
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toBe('invalid_status');
  });

  it('GET /api/v1/users requires bot_id', async () => {
    const token = (await createToken(w)).token;
    const res = await w.app.inject({ method: 'GET', url: '/api/v1/users', headers: bearer(token) });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('bot_id_required');
  });
});

describe('v1 bot-scoped token isolation (P4-T3)', () => {
  let w: World;
  beforeEach(async () => { w = await makeWorld(); });
  afterEach(async () => { await w.engine.gateway.stopAll(); await w.app.close(); });

  it('a bot-scoped token is 403 on another bot’s flow, bot, executions and users', async () => {
    const botA = await createBot(w, 'A');
    const botB = await createBot(w, 'B');
    const flowB = await createFlow(w, botB, triggerGraph());
    await startBot(w, botB);

    // Token scoped to bot A only.
    const scoped = (await createToken(w, { botId: botA })).token;

    // trigger a flow owned by B → 403
    const trig = await w.app.inject({
      method: 'POST', url: `/api/v1/flows/${flowB}/trigger`, headers: bearer(scoped), payload: {},
    });
    expect(trig.statusCode).toBe(403);

    // send through bot B → 403
    const send = await w.app.inject({
      method: 'POST', url: `/api/v1/bots/${botB}/send`,
      headers: bearer(scoped), payload: { chat_id: 1, text: 'x' },
    });
    expect(send.statusCode).toBe(403);

    // ask for B's executions explicitly → 403
    const ex = await w.app.inject({
      method: 'GET', url: `/api/v1/executions?bot_id=${botB}`, headers: bearer(scoped),
    });
    expect(ex.statusCode).toBe(403);

    // ask for B's users → 403
    const us = await w.app.inject({
      method: 'GET', url: `/api/v1/users?bot_id=${botB}`, headers: bearer(scoped),
    });
    expect(us.statusCode).toBe(403);
  });

  it('a bot-scoped token only ever sees its own bot’s executions (no bot_id filter)', async () => {
    const botA = await createBot(w, 'A');
    const botB = await createBot(w, 'B');
    const flowA = await createFlow(w, botA, triggerGraph());
    const flowB = await createFlow(w, botB, triggerGraph());

    const wide = (await createToken(w)).token; // instance-wide
    await w.app.inject({ method: 'POST', url: `/api/v1/flows/${flowA}/trigger`, headers: bearer(wide), payload: {} });
    await w.app.inject({ method: 'POST', url: `/api/v1/flows/${flowB}/trigger`, headers: bearer(wide), payload: {} });

    const scopedA = (await createToken(w, { botId: botA })).token;
    const list = await w.app.inject({ method: 'GET', url: '/api/v1/executions', headers: bearer(scopedA) });
    const execs = (list.json() as { executions: { botId: string }[] }).executions;
    expect(execs.length).toBe(1);
    expect(execs.every((e) => e.botId === botA)).toBe(true);
  });
});

describe('v1 node catalog — GET /api/v1/node-types (PC-T1)', () => {
  let w: World;
  beforeEach(async () => { w = await makeWorld(); });
  afterEach(async () => { await w.engine.gateway.stopAll(); await w.app.close(); });

  it('missing bearer → 401 (the catalog is bearer-guarded like the rest of v1)', async () => {
    const res = await w.app.inject({ method: 'GET', url: '/api/v1/node-types' });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe('missing_bearer_token');
  });

  it('garbage token → 401', async () => {
    const res = await w.app.inject({
      method: 'GET', url: '/api/v1/node-types', headers: bearer('ctb_notreal'),
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe('invalid_token');
  });

  it('valid token → 200 and the payload mirrors the engine registry exactly', async () => {
    const token = (await createToken(w)).token;
    const res = await w.app.inject({
      method: 'GET', url: '/api/v1/node-types', headers: bearer(token),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { nodeTypes: ReturnType<typeof nodeTypeInfos> };
    // The public catalog is the SAME projection as the engine registry — so it
    // can never advertise a node the engine can't run.
    const expected = nodeTypeInfos(w.engine.registry);
    expect(body.nodeTypes).toEqual(expected);
    expect(body.nodeTypes.length).toBe(expected.length);
    // Spot-check the shape an external builder relies on (PC-T1 contract).
    const sendMsg = body.nodeTypes.find((n) => n.type === 'tg.sendMessage')!;
    expect(sendMsg.category).toBe('telegram');
    expect(sendMsg.ports.inputs).toContain('main');
    expect(sendMsg.meta.labelKey).toBe('nodes.tg.sendMessage.label');
    expect(typeof sendMsg.paramsJsonSchema).toBe('object');
  });

  it('exposes the typed sub-connection surface (role/inputSlots/provides) for AI nodes', async () => {
    const token = (await createToken(w)).token;
    const res = await w.app.inject({
      method: 'GET', url: '/api/v1/node-types', headers: bearer(token),
    });
    const body = res.json() as { nodeTypes: ReturnType<typeof nodeTypeInfos> };
    // A consumer (ai.agent) advertises its typed input slots…
    const agent = body.nodeTypes.find((n) => n.type === 'ai.agent')!;
    expect(agent.inputSlots?.some((s) => s.kind === 'ai:model')).toBe(true);
    // …and a provider (ai.modelOpenai) advertises what it provides.
    const model = body.nodeTypes.find((n) => n.type === 'ai.modelOpenai')!;
    expect(model.role).toBe('provider');
    expect(model.provides).toBe('ai:model');
  });

  it('a bot-scoped token may also read the catalog (the node library is bot-agnostic)', async () => {
    const botId = await createBot(w);
    const scoped = (await createToken(w, { botId })).token;
    const res = await w.app.inject({
      method: 'GET', url: '/api/v1/node-types', headers: bearer(scoped),
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { nodeTypes: unknown[] }).nodeTypes.length).toBeGreaterThan(0);
  });

  it('the public catalog is byte-identical to the internal /api/node-types', async () => {
    const token = (await createToken(w)).token;
    const pub = await w.app.inject({
      method: 'GET', url: '/api/v1/node-types', headers: bearer(token),
    });
    // The internal route is panel-cookie guarded.
    const internal = await w.app.inject({
      method: 'GET', url: '/api/node-types', cookies: w.cookie,
    });
    expect(pub.statusCode).toBe(200);
    expect(internal.statusCode).toBe(200);
    expect(pub.json()).toEqual(internal.json());
  });
});

describe('v1 flow authoring — POST/PATCH /api/v1/flows (PC-T2)', () => {
  let w: World;
  beforeEach(async () => { w = await makeWorld(); });
  afterEach(async () => { await w.engine.gateway.stopAll(); await w.app.close(); });

  it('missing bearer → 401 on create', async () => {
    const res = await w.app.inject({ method: 'POST', url: '/api/v1/flows', payload: {} });
    expect(res.statusCode).toBe(401);
  });

  it('POST creates a draft flow and a real row appears', async () => {
    const botId = await createBot(w);
    const token = (await createToken(w)).token;
    const res = await w.app.inject({
      method: 'POST', url: '/api/v1/flows', headers: bearer(token),
      payload: { botId, name: 'built by agent', graph: triggerGraph() },
    });
    expect(res.statusCode).toBe(201);
    const flow = (res.json() as { flow: { id: string; status: string; version: number; botId: string } }).flow;
    expect(flow.status).toBe('draft');
    expect(flow.version).toBe(1);
    expect(flow.botId).toBe(botId);
    const row = w.db.select().from(schema.flows).where(eq(schema.flows.id, flow.id)).get()!;
    expect(row.name).toBe('built by agent');
  });

  it('POST accepts snake_case bot_id as an alias of botId', async () => {
    const botId = await createBot(w);
    const token = (await createToken(w)).token;
    const res = await w.app.inject({
      method: 'POST', url: '/api/v1/flows', headers: bearer(token),
      payload: { bot_id: botId, name: 'snake', graph: triggerGraph() },
    });
    expect(res.statusCode).toBe(201);
    expect((res.json() as { flow: { botId: string } }).flow.botId).toBe(botId);
  });

  it('POST graph defaults to an empty graph when omitted', async () => {
    const botId = await createBot(w);
    const token = (await createToken(w)).token;
    const res = await w.app.inject({
      method: 'POST', url: '/api/v1/flows', headers: bearer(token),
      payload: { botId, name: 'empty' },
    });
    expect(res.statusCode).toBe(201);
    const graph = (res.json() as { flow: { graph: { nodes: unknown[]; edges: unknown[] } } }).flow.graph;
    expect(graph.nodes).toHaveLength(0);
    expect(graph.edges).toHaveLength(0);
  });

  it('POST on an unknown bot → 400 unknown_bot', async () => {
    const token = (await createToken(w)).token;
    const res = await w.app.inject({
      method: 'POST', url: '/api/v1/flows', headers: bearer(token),
      payload: { botId: 'nope', name: 'x' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('unknown_bot');
  });

  it('PATCH a graph snapshots the old version and bumps version', async () => {
    const botId = await createBot(w);
    const token = (await createToken(w)).token;
    const created = await w.app.inject({
      method: 'POST', url: '/api/v1/flows', headers: bearer(token),
      payload: { botId, name: 'v1', graph: noTriggerGraph() },
    });
    const flowId = (created.json() as { flow: { id: string } }).flow.id;

    const patched = await w.app.inject({
      method: 'PATCH', url: `/api/v1/flows/${flowId}`, headers: bearer(token),
      payload: { name: 'v2', graph: triggerGraph() },
    });
    expect(patched.statusCode).toBe(200);
    const flow = (patched.json() as { flow: { name: string; version: number } }).flow;
    expect(flow.name).toBe('v2');
    expect(flow.version).toBe(2);
    // The outgoing version is snapshotted for rollback.
    const versions = w.db.select().from(schema.flowVersions).where(eq(schema.flowVersions.flowId, flowId)).all();
    expect(versions).toHaveLength(1);
    expect(versions[0]!.version).toBe(1);
  });

  it('PATCH on an unknown flow → 404 flow_not_found', async () => {
    const token = (await createToken(w)).token;
    const res = await w.app.inject({
      method: 'PATCH', url: '/api/v1/flows/nope', headers: bearer(token), payload: { name: 'x' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('flow_not_found');
  });
});

describe('v1 flow validate + activate (PC-T2)', () => {
  let w: World;
  beforeEach(async () => { w = await makeWorld(); });
  afterEach(async () => { await w.engine.gateway.stopAll(); await w.app.close(); });

  async function v1Create(token: string, botId: string, graph: FlowGraph): Promise<string> {
    const res = await w.app.inject({
      method: 'POST', url: '/api/v1/flows', headers: bearer(token),
      payload: { botId, name: 'f', graph },
    });
    expect(res.statusCode).toBe(201);
    return (res.json() as { flow: { id: string } }).flow.id;
  }

  it('validate a good flow → ok:true, no problems (nothing is saved/changed)', async () => {
    const botId = await createBot(w);
    const token = (await createToken(w)).token;
    const flowId = await v1Create(token, botId, triggerGraph());
    const res = await w.app.inject({
      method: 'POST', url: `/api/v1/flows/${flowId}/validate`, headers: bearer(token),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { ok: boolean; problems: string[] };
    expect(body.ok).toBe(true);
    expect(body.problems).toHaveLength(0);
    // Still a draft — validate never mutates.
    const row = w.db.select().from(schema.flows).where(eq(schema.flows.id, flowId)).get()!;
    expect(row.status).toBe('draft');
  });

  it('validate a flow with no trigger → ok:false with a pointed problem', async () => {
    const botId = await createBot(w);
    const token = (await createToken(w)).token;
    const flowId = await v1Create(token, botId, noTriggerGraph());
    const res = await w.app.inject({
      method: 'POST', url: `/api/v1/flows/${flowId}/validate`, headers: bearer(token),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { ok: boolean; problems: string[] };
    expect(body.ok).toBe(false);
    expect(body.problems.some((p) => p.includes('no enabled trigger'))).toBe(true);
  });

  it('activate a good flow → active', async () => {
    const botId = await createBot(w);
    const token = (await createToken(w)).token;
    const flowId = await v1Create(token, botId, triggerGraph());
    const res = await w.app.inject({
      method: 'POST', url: `/api/v1/flows/${flowId}/activate`, headers: bearer(token),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, status: 'active' });
    const row = w.db.select().from(schema.flows).where(eq(schema.flows.id, flowId)).get()!;
    expect(row.status).toBe('active');
  });

  it('activate a flow with no trigger → 422 not_activatable + problems', async () => {
    const botId = await createBot(w);
    const token = (await createToken(w)).token;
    const flowId = await v1Create(token, botId, noTriggerGraph());
    const res = await w.app.inject({
      method: 'POST', url: `/api/v1/flows/${flowId}/activate`, headers: bearer(token),
    });
    expect(res.statusCode).toBe(422);
    const body = res.json() as { error: string; problems: string[] };
    expect(body.error).toBe('not_activatable');
    expect(body.problems.length).toBeGreaterThan(0);
    // Stays a draft on a failed activation.
    const row = w.db.select().from(schema.flows).where(eq(schema.flows.id, flowId)).get()!;
    expect(row.status).toBe('draft');
  });

  it('deactivate flips an active flow back to draft', async () => {
    const botId = await createBot(w);
    const token = (await createToken(w)).token;
    const flowId = await v1Create(token, botId, triggerGraph());
    await w.app.inject({ method: 'POST', url: `/api/v1/flows/${flowId}/activate`, headers: bearer(token) });
    const res = await w.app.inject({
      method: 'POST', url: `/api/v1/flows/${flowId}/deactivate`, headers: bearer(token),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, status: 'draft' });
  });

  it('a bot-scoped token cannot author/activate on another bot (403)', async () => {
    const botA = await createBot(w, 'A');
    const botB = await createBot(w, 'B');
    const flowB = await createFlow(w, botB, triggerGraph()); // built via panel
    const scopedA = (await createToken(w, { botId: botA })).token;

    // create on B
    const create = await w.app.inject({
      method: 'POST', url: '/api/v1/flows', headers: bearer(scopedA),
      payload: { botId: botB, name: 'x', graph: triggerGraph() },
    });
    expect(create.statusCode).toBe(403);
    // patch / validate / activate / deactivate on B's flow
    for (const path of [`/api/v1/flows/${flowB}`]) {
      const r = await w.app.inject({ method: 'PATCH', url: path, headers: bearer(scopedA), payload: { name: 'y' } });
      expect(r.statusCode).toBe(403);
    }
    for (const verb of ['validate', 'activate', 'deactivate']) {
      const r = await w.app.inject({ method: 'POST', url: `/api/v1/flows/${flowB}/${verb}`, headers: bearer(scopedA) });
      expect(r.statusCode).toBe(403);
    }
  });
});
