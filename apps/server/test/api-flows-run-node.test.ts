/**
 * PLAN3 I-T2 (gap G16) — single-node run: `POST /api/flows/:id/run-node`.
 *
 * The editor's "Run this node" button executes ONE node and stops, without
 * running the whole flow. This test drives the REAL wired engine + in-memory
 * SQLite over the panel HTTP route the editor uses, and proves:
 *
 *   1. running a `data.setFields` node alone produces its output (read from the
 *      execution log) and the downstream `tg.sendMessage` node NEVER runs
 *      (no Telegram call) — the single-node boundary stopped after the target.
 *   2. the supplied `input` reaches the node (its expression resolves against it).
 *   3. a node that does not exist → 404 node_not_found; a disabled node → 422.
 *   4. an invalid body → 400; an unknown flow → 404.
 *
 * Harness mirrored from e2e-phaseF-quickstart-demo.
 */
import type { FlowPublic } from '@ctb/shared';
import type { FastifyInstance } from 'fastify';
import type { UserFromGetMe } from 'grammy/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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

interface SentCall { method: string; payload: Record<string, unknown>; }
interface World {
  app: FastifyInstance;
  db: Db;
  engine: Engine;
  cookie: { [k: string]: string };
  sent: SentCall[];
}

async function makeWorld(): Promise<World> {
  const env = loadEnv({ CTB_SECRET: SECRET, CTB_ADMIN_PASS: 'hunter2hunter2', NODE_ENV: 'test' } as NodeJS.ProcessEnv);
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

async function createBot(w: World, name = 'demo-bot'): Promise<string> {
  const { bot } = (
    await w.app.inject({ method: 'POST', url: '/api/bots', cookies: w.cookie, payload: { name, token: TOKEN } })
  ).json() as { bot: { id: string } };
  return bot.id;
}

function wireSender(w: World, botId: string): void {
  w.engine.gateway.registerBot(botId, TOKEN, {
    botInfo: BOT_INFO,
    callApi: async (method: string, payload: Record<string, unknown>) => {
      w.sent.push({ method, payload });
      return { message_id: 777 };
    },
  });
}

/** A two-node flow: setFields → tg.sendMessage. Running `set` alone must NOT send. */
function twoNodeGraph() {
  return {
    nodes: [
      {
        id: 'set', type: 'data.setFields',
        params: { fields: [{ target: 'json', name: 'greeting', value: 'hi {{ $json.who }}', op: 'set' }] },
        position: { x: 0, y: 0 }, disabled: false,
      },
      {
        id: 'send', type: 'tg.sendMessage',
        params: { chat: '{{ $json.chat }}', text: '{{ $json.greeting }}' },
        position: { x: 200, y: 0 }, disabled: false,
      },
    ],
    edges: [{ id: 'e1', from: { node: 'set', port: 'main' }, to: { node: 'send', port: 'main' } }],
  };
}

async function createFlow(w: World, botId: string, graph: unknown): Promise<FlowPublic> {
  return (
    await w.app.inject({ method: 'POST', url: '/api/flows', cookies: w.cookie, payload: { botId, name: 'f', graph } })
  ).json().flow as FlowPublic;
}

async function latestExecutionLogs(w: World, flowId: string): Promise<{ nodeId: string | null; output?: Record<string, Array<{ json: Record<string, unknown> }>> }[]> {
  const list = (
    await w.app.inject({ method: 'GET', url: `/api/executions?flowId=${flowId}&limit=1`, cookies: w.cookie })
  ).json() as { executions: { id: string }[] };
  const id = list.executions[0]!.id;
  const detail = (
    await w.app.inject({ method: 'GET', url: `/api/executions/${id}`, cookies: w.cookie })
  ).json() as { execution: { logs: { nodeId: string | null; output?: Record<string, Array<{ json: Record<string, unknown> }>> }[] } };
  return detail.execution.logs;
}

describe('POST /api/flows/:id/run-node — single-node run (I-T2, gap G16)', () => {
  let w: World;
  beforeEach(async () => { w = await makeWorld(); });
  afterEach(async () => { await w.engine.gateway.stopAll(); await w.app.close(); });

  it('runs ONLY the target node — its output is captured and the downstream node never runs', async () => {
    const botId = await createBot(w);
    wireSender(w, botId);
    const flow = await createFlow(w, botId, twoNodeGraph());

    const res = await w.app.inject({
      method: 'POST', url: `/api/flows/${flow.id}/run-node`, cookies: w.cookie,
      payload: { nodeId: 'set', input: [{ json: { who: 'علی' } }] },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { status: string }).status).toBe('done');

    // the target node executed and emitted its computed greeting
    const logs = await latestExecutionLogs(w, flow.id);
    const setOut = logs.find((l) => l.nodeId === 'set' && l.output);
    expect(setOut).toBeTruthy();
    expect(setOut!.output!.main![0]!.json.greeting).toBe('hi علی');

    // the downstream tg.sendMessage was NOT reached → no Telegram call
    expect(w.sent.find((c) => c.method === 'sendMessage')).toBeUndefined();
    // and `send` produced no log row of its own
    expect(logs.find((l) => l.nodeId === 'send' && l.output)).toBeUndefined();
  });

  it('runs with one empty item when no input is supplied', async () => {
    const botId = await createBot(w);
    const flow = await createFlow(w, botId, twoNodeGraph());
    const res = await w.app.inject({
      method: 'POST', url: `/api/flows/${flow.id}/run-node`, cookies: w.cookie,
      payload: { nodeId: 'set' },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { status: string }).status).toBe('done');
  });

  it('404 node_not_found for an unknown node id', async () => {
    const botId = await createBot(w);
    const flow = await createFlow(w, botId, twoNodeGraph());
    const res = await w.app.inject({
      method: 'POST', url: `/api/flows/${flow.id}/run-node`, cookies: w.cookie,
      payload: { nodeId: 'ghost' },
    });
    expect(res.statusCode).toBe(404);
    expect((res.json() as { error: string }).error).toBe('node_not_found');
  });

  it('422 node_disabled for a disabled node', async () => {
    const botId = await createBot(w);
    const graph = twoNodeGraph();
    graph.nodes[0]!.disabled = true;
    const flow = await createFlow(w, botId, graph);
    const res = await w.app.inject({
      method: 'POST', url: `/api/flows/${flow.id}/run-node`, cookies: w.cookie,
      payload: { nodeId: 'set' },
    });
    expect(res.statusCode).toBe(422);
    expect((res.json() as { error: string }).error).toBe('node_disabled');
  });

  it('400 invalid_body when nodeId is missing', async () => {
    const botId = await createBot(w);
    const flow = await createFlow(w, botId, twoNodeGraph());
    const res = await w.app.inject({
      method: 'POST', url: `/api/flows/${flow.id}/run-node`, cookies: w.cookie, payload: {},
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toBe('invalid_body');
  });

  it('404 not_found for an unknown flow', async () => {
    const res = await w.app.inject({
      method: 'POST', url: '/api/flows/does-not-exist/run-node', cookies: w.cookie,
      payload: { nodeId: 'set' },
    });
    expect(res.statusCode).toBe(404);
    expect((res.json() as { error: string }).error).toBe('not_found');
  });
});
