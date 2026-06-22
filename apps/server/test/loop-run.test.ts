/**
 * P3-T2 server integration — flow.loop through the real wired engine over a
 * genuinely CYCLIC graph. The flow is:
 *
 *   manualTrigger(3 items) → loop ──loop──▶ code(per-batch, logs) ──┐
 *                              ▲                                     │
 *                              └─────────────────────────────────────┘
 *                            └──done──▶ code(final, logs the total)
 *
 * The `loop` output cycles back into the loop node's own `main` input; the
 * executor's cursor run-loop must traverse that edge repeatedly until the
 * batches are exhausted, then take the `done` branch exactly once. This proves
 * the n8n splitInBatches contract end-to-end (per-node $vars state survives the
 * cycle, done fires with all items) and that the run terminates (no maxSteps
 * blow-up). flow.merge's branch semantics are covered by the node contract test.
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

async function makeWorld(): Promise<World> {
  const env = loadEnv({ CTB_SECRET: SECRET, CTB_ADMIN_PASS: 'hunter2hunter2', NODE_ENV: 'test' } as NodeJS.ProcessEnv);
  const { db } = openDb(':memory:');
  runMigrations(db);
  const engine = wireEngine({ db, ctbSecret: SECRET, expressionBudgetMs: 5_000 });
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

/**
 * Cyclic loop graph. The trigger emits 3 items; the loop node splits them into
 * batches of `batchSize`. Each batch hits a code node that logs `batch=<n>` and
 * passes the items straight back to the loop. When batches run out, the `done`
 * branch logs `done total=<n>`.
 */
function loopGraph(batchSize: number) {
  return {
    nodes: [
      {
        id: 'trig', type: 'flow.manualTrigger',
        // three items via run_once code below; manualTrigger emits one sample item,
        // then a code node fans it out to 3. (manualTrigger sample is a single item.)
        params: { sample: '{}' },
      },
      {
        id: 'seed', type: 'data.code',
        params: { mode: 'run_once', code: 'return [{a:1},{a:2},{a:3}];' },
      },
      { id: 'loop', type: 'flow.loop', params: { batch_size: batchSize } },
      {
        id: 'work', type: 'data.code',
        params: { mode: 'run_once', code: 'console.log("batch=" + $items.length); return $items;' },
      },
      {
        id: 'fin', type: 'data.code',
        params: { mode: 'run_once', code: 'console.log("done total=" + $items.length); return $items;' },
      },
    ],
    edges: [
      { id: 'e1', from: { node: 'trig', port: 'main' }, to: { node: 'seed', port: 'main' } },
      { id: 'e2', from: { node: 'seed', port: 'main' }, to: { node: 'loop', port: 'main' } },
      { id: 'e3', from: { node: 'loop', port: 'loop' }, to: { node: 'work', port: 'main' } },
      // the cycle: work's output loops back into the loop node's main input
      { id: 'e4', from: { node: 'work', port: 'main' }, to: { node: 'loop', port: 'main' } },
      { id: 'e5', from: { node: 'loop', port: 'done' }, to: { node: 'fin', port: 'main' } },
    ],
  };
}

describe('flow.loop (P3-T2, server integration — cyclic graph)', () => {
  let w: World;
  beforeEach(async () => { w = await makeWorld(); });
  afterEach(async () => { await w.engine.gateway.stopAll(); await w.app.close(); });

  it('batch_size 1: iterates each item, then done fires once with all 3', async () => {
    const botId = await createBot(w, TOKEN);
    const flowId = await createFlow(w, botId, 'looper', loopGraph(1));

    const body = await run(w, flowId);
    expect(body.status).toBe('done');
    expect(body.error).toBeNull();

    const logs = await logsOf(w, body.executionId);
    const batchLogs = logs.filter((l) => /^batch=/.test(l.message) || l.message.includes('batch='));
    // three single-item batches went round the loop
    expect(batchLogs.filter((l) => l.message.includes('batch=1'))).toHaveLength(3);
    // done fired exactly once, carrying all originals
    expect(logs.filter((l) => l.message.includes('done total=3'))).toHaveLength(1);
  });

  it('batch_size 2: two batches (2 + 1), then done with all 3', async () => {
    const botId = await createBot(w, TOKEN);
    const flowId = await createFlow(w, botId, 'looper2', loopGraph(2));

    const body = await run(w, flowId);
    expect(body.status).toBe('done');

    const logs = await logsOf(w, body.executionId);
    expect(logs.some((l) => l.message.includes('batch=2'))).toBe(true);
    expect(logs.some((l) => l.message.includes('batch=1'))).toBe(true);
    expect(logs.filter((l) => l.message.includes('done total=3'))).toHaveLength(1);
  });
});
