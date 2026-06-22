/**
 * 🎬 PC-T5 — Phase-C demo: an EXTERNAL AGENT builds and runs a CTB flow over the
 * public v1 surface, using NOTHING but the bearer-token REST API (PC-T1…PC-T3).
 *
 * This is the inverse of the editor: no panel cookie, no hand-written graph JSON
 * pasted into the DB — every step is a real HTTP call an n8n node, a script, or
 * an MCP-driven AI agent could make, against the REAL wired engine + in-memory
 * SQLite + a fake Telegram transport (exactly like e2e-phase4-n8n-demo).
 *
 * The lifecycle proven (the PROTOCOL.md "Authoring & MCP" chapter, end-to-end):
 *
 *   1. DISCOVER   GET  /api/v1/node-types         → read the catalog, find the
 *                                                   three node types + their
 *                                                   JSON-Schema params it needs.
 *   2. BUILD      POST /api/v1/flows              → assemble a 3-node graph
 *                                                   (trigger → set → sendMessage)
 *                                                   from ONLY catalog node types.
 *   3. VALIDATE   POST /api/v1/flows/:id/validate → dry-run; ok:true, nothing saved.
 *   4. ACTIVATE   POST /api/v1/flows/:id/activate → flips the draft to active.
 *   5. TRIGGER    POST /api/v1/flows/:id/trigger  → async run; poll
 *                                                   GET /api/v1/executions until
 *                                                   it reaches `done`, and assert
 *                                                   the bot actually sent the
 *                                                   composed Telegram message.
 *
 * A second test proves the SAFETY rail the agent relies on: a graph that uses a
 * node type NOT in the catalog can never be assembled into a runnable flow —
 * validate/activate reject it (the catalog is the single source of truth, I5).
 */
import {
  FlowGraphSchema,
  type ApiTokenCreated,
  type FlowGraph,
  type NodeTypeInfo,
} from '@ctb/shared';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { UserFromGetMe } from 'grammy/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SESSION_COOKIE, buildApp } from '../src/app';
import { openDb, schema, type Db } from '../src/db/index';
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

function bearer(token: string): { authorization: string } {
  return { authorization: `Bearer ${token}` };
}

/** The panel-side setup the operator does ONCE before handing the agent a token. */
async function createBot(w: World, name = 'demo-bot'): Promise<string> {
  const { bot } = (
    await w.app.inject({
      method: 'POST', url: '/api/bots', cookies: w.cookie,
      payload: { name, token: TOKEN },
    })
  ).json() as { bot: { id: string } };
  return bot.id;
}

async function startBot(w: World, botId: string): Promise<void> {
  const res = await w.app.inject({ method: 'POST', url: `/api/bots/${botId}/start`, cookies: w.cookie });
  expect(res.statusCode).toBe(200);
}

async function createToken(w: World, opts: { botId?: string } = {}): Promise<ApiTokenCreated> {
  const res = await w.app.inject({
    method: 'POST', url: '/api/api-tokens', cookies: w.cookie,
    payload: { name: 'agent', ...(opts.botId ? { botId: opts.botId } : {}) },
  });
  expect(res.statusCode).toBe(201);
  return (res.json() as { apiToken: ApiTokenCreated }).apiToken;
}

/** Poll until `pred()` is true, so we observe the async run reaching a terminal state. */
async function until(pred: () => Promise<boolean> | boolean, tries = 200): Promise<void> {
  for (let i = 0; i < tries; i++) {
    if (await pred()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('condition not reached in time');
}

describe('🎬 Phase-C demo e2e (PC-T5) — an external agent builds + runs a flow over v1', () => {
  let w: World;
  beforeEach(async () => { w = await makeWorld(); });
  afterEach(async () => { await w.engine.gateway.stopAll(); await w.app.close(); });

  it('discover → build → validate → activate → trigger, all over the bearer API', async () => {
    // ── Operator setup (panel, one-time): a bot + a bot-scoped token for the agent.
    const botId = await createBot(w);
    await startBot(w, botId); // the sendMessage leg goes through the live sender
    const token = (await createToken(w, { botId })).token;

    // ── 1. DISCOVER: the agent reads the catalog and finds the node types it needs.
    const catRes = await w.app.inject({
      method: 'GET', url: '/api/v1/node-types', headers: bearer(token),
    });
    expect(catRes.statusCode).toBe(200);
    const catalog = (catRes.json() as { nodeTypes: NodeTypeInfo[] }).nodeTypes;
    const byType = new Map(catalog.map((n) => [n.type, n]));

    // The three bricks the agent will wire. It LEARNS they exist from the catalog
    // (rather than assuming) — exactly what an external builder must do.
    const triggerNode = catalog.find((n) => n.type === 'flow.manualTrigger');
    const setNode = byType.get('data.setFields');
    const sendNode = byType.get('tg.sendMessage');
    expect(triggerNode, 'catalog advertises a manual trigger').toBeTruthy();
    expect(setNode, 'catalog advertises data.setFields').toBeTruthy();
    expect(sendNode, 'catalog advertises tg.sendMessage').toBeTruthy();

    // The catalog also tells the agent each node's shape: ports + JSON-Schema params.
    expect(triggerNode!.category).toBe('trigger');
    expect(setNode!.ports.inputs).toContain('main');
    expect(setNode!.ports.outputs).toContain('main');
    expect(sendNode!.paramsJsonSchema).toBeTruthy();

    // ── 2. BUILD: assemble a 3-node graph from ONLY catalog node types.
    //   manualTrigger → setFields (compose a greeting) → sendMessage (deliver it)
    const graph: FlowGraph = FlowGraphSchema.parse({
      nodes: [
        {
          id: 'trig', type: 'flow.manualTrigger',
          params: { sample: '{}' }, position: { x: 0, y: 0 }, disabled: false,
        },
        {
          id: 'compose', type: 'data.setFields',
          params: {
            fields: [
              { target: 'json', name: 'greeting', value: 'Hello from an external agent 👋', op: 'set' },
            ],
          },
          position: { x: 220, y: 0 }, disabled: false,
        },
        {
          id: 'send', type: 'tg.sendMessage',
          params: { chat_id: '555', text: '{{ $json.greeting }}' },
          position: { x: 440, y: 0 }, disabled: false,
        },
      ],
      edges: [
        { id: 'e1', from: { node: 'trig', port: 'main' }, to: { node: 'compose', port: 'main' } },
        { id: 'e2', from: { node: 'compose', port: 'main' }, to: { node: 'send', port: 'main' } },
      ],
    });

    const createRes = await w.app.inject({
      method: 'POST', url: '/api/v1/flows', headers: bearer(token),
      payload: { bot_id: botId, name: 'agent-built greeting', graph }, // snake_case alias, as a script would send
    });
    expect(createRes.statusCode).toBe(201);
    const flowId = (createRes.json() as { flow: { id: string; status: string; version: number } }).flow.id;
    // A fresh draft, never auto-activated.
    expect((createRes.json() as { flow: { status: string } }).flow.status).toBe('draft');

    // ── 3. VALIDATE (dry-run): ok:true, no problems, nothing mutated.
    const valRes = await w.app.inject({
      method: 'POST', url: `/api/v1/flows/${flowId}/validate`, headers: bearer(token),
    });
    expect(valRes.statusCode).toBe(200);
    const val = valRes.json() as { ok: boolean; problems: string[]; nodeProblems: unknown[] };
    expect(val.ok).toBe(true);
    expect(val.problems).toHaveLength(0);
    // Still a draft — validate is read-only.
    expect(w.db.select().from(schema.flows).where(eq(schema.flows.id, flowId)).get()!.status).toBe('draft');

    // ── 4. ACTIVATE: the draft becomes live.
    const actRes = await w.app.inject({
      method: 'POST', url: `/api/v1/flows/${flowId}/activate`, headers: bearer(token),
    });
    expect(actRes.statusCode).toBe(200);
    expect(actRes.json()).toMatchObject({ ok: true, status: 'active' });
    expect(w.db.select().from(schema.flows).where(eq(schema.flows.id, flowId)).get()!.status).toBe('active');

    // ── 5. TRIGGER: start a run (async), then poll executions until it finishes.
    const trigRes = await w.app.inject({
      method: 'POST', url: `/api/v1/flows/${flowId}/trigger`,
      headers: bearer(token), payload: { chat_id: 555 },
    });
    expect(trigRes.statusCode).toBe(202);
    const { executionId } = trigRes.json() as { ok: boolean; executionId: string };
    expect(executionId).toBeTruthy();

    // Poll the public executions endpoint exactly as an external client would.
    await until(async () => {
      const list = await w.app.inject({
        method: 'GET', url: `/api/v1/executions?flow_id=${flowId}`, headers: bearer(token),
      });
      const execs = (list.json() as { executions: { id: string; status: string }[] }).executions;
      const me = execs.find((e) => e.id === executionId);
      return me?.status === 'done';
    });

    // The run reached `done` (not `error`).
    const finalRow = w.db.select().from(schema.executions).where(eq(schema.executions.id, executionId)).get()!;
    expect(finalRow.status).toBe('done');

    // And the composed greeting was actually delivered through the bot's sender —
    // the expression {{ $json.greeting }} resolved against the setFields output.
    const send = w.sent.find((c) => c.method === 'sendMessage');
    expect(send, 'the bot sent a message').toBeTruthy();
    expect(send!.payload).toMatchObject({ chat_id: 555, text: 'Hello from an external agent 👋' });
  });

  it('safety rail: a flow using a node type NOT in the catalog can never be activated', async () => {
    const botId = await createBot(w);
    const token = (await createToken(w, { botId })).token;

    // The catalog is the agent's source of truth; a type it does NOT advertise
    // must not survive validation. (Shop/VPN/etc. domain nodes don't exist — I2.)
    const catalog = (
      (await w.app.inject({ method: 'GET', url: '/api/v1/node-types', headers: bearer(token) }))
        .json() as { nodeTypes: NodeTypeInfo[] }
    ).nodeTypes;
    expect(catalog.some((n) => n.type === 'shop.checkout')).toBe(false);

    const graph: FlowGraph = FlowGraphSchema.parse({
      nodes: [
        {
          id: 'trig', type: 'flow.manualTrigger',
          params: { sample: '{}' }, position: { x: 0, y: 0 }, disabled: false,
        },
        {
          id: 'bogus', type: 'shop.checkout', // a node type the engine can't run
          params: {}, position: { x: 220, y: 0 }, disabled: false,
        },
      ],
      edges: [{ id: 'e1', from: { node: 'trig', port: 'main' }, to: { node: 'bogus', port: 'main' } }],
    });

    const flowId = (
      (await w.app.inject({
        method: 'POST', url: '/api/v1/flows', headers: bearer(token),
        payload: { bot_id: botId, name: 'bogus', graph },
      })).json() as { flow: { id: string } }
    ).flow.id;

    // validate reports the problem (ok:false) …
    const val = (
      await w.app.inject({
        method: 'POST', url: `/api/v1/flows/${flowId}/validate`, headers: bearer(token),
      })
    ).json() as { ok: boolean; problems: string[] };
    expect(val.ok).toBe(false);
    expect(val.problems.length).toBeGreaterThan(0);

    // … and activate refuses (422), leaving the flow a draft.
    const act = await w.app.inject({
      method: 'POST', url: `/api/v1/flows/${flowId}/activate`, headers: bearer(token),
    });
    expect(act.statusCode).toBe(422);
    expect((act.json() as { error: string }).error).toBe('not_activatable');
    expect(w.db.select().from(schema.flows).where(eq(schema.flows.id, flowId)).get()!.status).toBe('draft');
  });
});
