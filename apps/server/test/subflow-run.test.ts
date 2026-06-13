/**
 * P3-T1 server integration — flow.executeSubFlow + flow.return through the real
 * wired engine. A parent flow (manualTrigger → executeSubFlow → code) calls a
 * child flow (manualTrigger → setFields → return); we run the parent via
 * POST /api/flows/:id/run and assert the child's returned items reached the
 * parent. Also covers the recursion-depth cap and the same-bot guard.
 */
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
const TOKEN2 = '987654321:BBEexampletokenexampletokenexample';
const BOT_INFO: UserFromGetMe = {
  id: 42, is_bot: true, first_name: 'TestBot', username: 'test_bot',
  can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: false,
  can_connect_to_business: false, has_main_web_app: false, can_manage_bots: false,
  has_topics_enabled: false, allows_users_to_create_topics: false,
};

interface World {
  app: FastifyInstance;
  db: Db;
  engine: Engine;
  cookie: { [k: string]: string };
}

async function makeWorld(opts: { maxSubFlowDepth?: number } = {}): Promise<World> {
  const env = loadEnv({ CTB_SECRET: SECRET, CTB_ADMIN_PASS: 'hunter2hunter2', NODE_ENV: 'test' } as NodeJS.ProcessEnv);
  const { db } = openDb(':memory:');
  runMigrations(db);
  const engine = wireEngine({
    db, ctbSecret: SECRET,
    ...(opts.maxSubFlowDepth !== undefined ? { maxSubFlowDepth: opts.maxSubFlowDepth } : {}),
  });
  const app = buildApp({
    env, db, engine, logger: false, editorDistDir: '/nonexistent',
    botRegisterOpts: () => ({ botInfo: BOT_INFO, callApi: async () => ({ message_id: 1 }) }),
  });
  const login = await app.inject({
    method: 'POST', url: '/api/auth/login',
    payload: { username: 'admin', password: 'hunter2hunter2' },
  });
  const cookie = { [SESSION_COOKIE]: login.cookies.find((c) => c.name === SESSION_COOKIE)!.value };
  return { app, db, engine, cookie };
}

async function createBot(w: World, token: string, name = 'bot'): Promise<string> {
  const res = await w.app.inject({
    method: 'POST', url: '/api/bots', cookies: w.cookie, payload: { name, token },
  });
  expect(res.statusCode).toBe(201);
  return res.json().bot.id as string;
}

async function createFlow(w: World, botId: string, name: string, graph: unknown): Promise<string> {
  const res = await w.app.inject({
    method: 'POST', url: '/api/flows', cookies: w.cookie, payload: { botId, name, graph },
  });
  expect(res.statusCode).toBe(201);
  return res.json().flow.id as string;
}

async function run(w: World, flowId: string) {
  const res = await w.app.inject({ method: 'POST', url: `/api/flows/${flowId}/run`, cookies: w.cookie });
  expect(res.statusCode).toBe(200);
  return res.json() as { executionId: string; status: string; error: string | null };
}

async function logsOf(w: World, executionId: string): Promise<{ message: string }[]> {
  const detail = await w.app.inject({
    method: 'GET', url: `/api/executions/${executionId}`, cookies: w.cookie,
  });
  expect(detail.statusCode).toBe(200);
  return detail.json().execution.logs as { message: string }[];
}

/** child: manualTrigger → setFields(adds greeted=true) → return */
const childGraph = {
  nodes: [
    { id: 'ctrig', type: 'flow.manualTrigger', params: { sample: '{}' } },
    { id: 'set', type: 'data.setFields', params: { fields: [{ name: 'greeted', value: 'yes', target: 'json' }] } },
    { id: 'ret', type: 'flow.return', params: {} },
  ],
  edges: [
    { id: 'ce1', from: { node: 'ctrig', port: 'main' }, to: { node: 'set', port: 'main' } },
    { id: 'ce2', from: { node: 'set', port: 'main' }, to: { node: 'ret', port: 'main' } },
  ],
};

/** parent: manualTrigger → executeSubFlow(child, wait) → code (logs the result) */
function parentGraph(childFlowId: string, mode: 'wait' | 'fire_and_forget' = 'wait') {
  return {
    nodes: [
      { id: 'ptrig', type: 'flow.manualTrigger', params: { sample: '{"name":"Sara"}' } },
      { id: 'sub', type: 'flow.executeSubFlow', params: { flow_id: childFlowId, mode } },
      { id: 'pcode', type: 'data.code', params: { mode: 'run_once', code: 'console.log("greeted=" + ($json.greeted ?? "none")); return $items;' } },
    ],
    edges: [
      { id: 'pe1', from: { node: 'ptrig', port: 'main' }, to: { node: 'sub', port: 'main' } },
      { id: 'pe2', from: { node: 'sub', port: 'main' }, to: { node: 'pcode', port: 'main' } },
    ],
  };
}

describe('flow.executeSubFlow + flow.return (P3-T1, server integration)', () => {
  let w: World;
  beforeEach(async () => { w = await makeWorld(); });
  afterEach(async () => { await w.engine.gateway.stopAll(); await w.app.close(); });

  it('wait mode: child’s returned items flow into the parent', async () => {
    const botId = await createBot(w, TOKEN);
    const childId = await createFlow(w, botId, 'child', childGraph);
    const parentId = await createFlow(w, botId, 'parent', parentGraph(childId, 'wait'));

    const body = await run(w, parentId);
    expect(body.status).toBe('done');
    expect(body.error).toBeNull();

    // The parent's code node saw the field the CHILD set → item passing works.
    const logs = await logsOf(w, body.executionId);
    expect(logs.some((l) => l.message.includes('greeted=yes'))).toBe(true);
  });

  it('fire_and_forget: parent passes its own input through (child does not feed it)', async () => {
    const botId = await createBot(w, TOKEN);
    const childId = await createFlow(w, botId, 'child', childGraph);
    const parentId = await createFlow(w, botId, 'parent', parentGraph(childId, 'fire_and_forget'));

    const body = await run(w, parentId);
    expect(body.status).toBe('done');
    // The child's `greeted` never reached the parent — input passed straight through.
    const logs = await logsOf(w, body.executionId);
    expect(logs.some((l) => l.message.includes('greeted=none'))).toBe(true);
  });

  it('same-bot guard: calling another bot’s flow fails', async () => {
    const botA = await createBot(w, TOKEN, 'A');
    const botB = await createBot(w, TOKEN2, 'B');
    const childOnB = await createFlow(w, botB, 'childB', childGraph);
    const parentOnA = await createFlow(w, botA, 'parentA', parentGraph(childOnB, 'wait'));

    const body = await run(w, parentOnA);
    expect(body.status).toBe('error');
    expect(body.error).toMatch(/different bot|not allowed/);
  });

  it('missing sub-flow id fails cleanly', async () => {
    const botId = await createBot(w, TOKEN);
    const parentId = await createFlow(w, botId, 'parent', parentGraph('does-not-exist', 'wait'));
    const body = await run(w, parentId);
    expect(body.status).toBe('error');
    expect(body.error).toMatch(/not found/);
  });

  it('recursion-depth cap stops runaway mutual/self recursion', async () => {
    // A low cap + a flow that calls a second flow that calls the first.
    const ww = await makeWorld({ maxSubFlowDepth: 2 });
    try {
      const botId = await createBot(ww, TOKEN);
      // two-flow ping-pong: A → B → A → … (each is a distinct flow id, so the
      // node's self-call guard doesn't trip — only the depth cap stops it).
      const aId = await createFlow(ww, botId, 'A', { nodes: [], edges: [] }); // placeholder, patched below
      const bId = await createFlow(ww, botId, 'B', {
        nodes: [
          { id: 'bt', type: 'flow.manualTrigger', params: { sample: '{}' } },
          { id: 'bs', type: 'flow.executeSubFlow', params: { flow_id: aId, mode: 'wait' } },
        ],
        edges: [{ id: 'be', from: { node: 'bt', port: 'main' }, to: { node: 'bs', port: 'main' } }],
      });
      // patch A to call B (now that we have bId)
      const patch = await ww.app.inject({
        method: 'PATCH', url: `/api/flows/${aId}`, cookies: ww.cookie,
        payload: {
          graph: {
            nodes: [
              { id: 'at', type: 'flow.manualTrigger', params: { sample: '{}' } },
              { id: 'as', type: 'flow.executeSubFlow', params: { flow_id: bId, mode: 'wait' } },
            ],
            edges: [{ id: 'ae', from: { node: 'at', port: 'main' }, to: { node: 'as', port: 'main' } }],
          },
        },
      });
      expect(patch.statusCode).toBe(200);

      const body = await run(ww, aId);
      expect(body.status).toBe('error');
      expect(body.error).toMatch(/depth cap/);
    } finally {
      await ww.engine.gateway.stopAll();
      await ww.app.close();
    }
  });
});
