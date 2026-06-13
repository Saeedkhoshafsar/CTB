/**
 * P2-T7 — server side of the Code node: the manual test-run endpoint
 * (POST /api/flows/:id/run) and the $http allow-list (hostAllowed).
 *
 * A flow.manualTrigger → data.code flow runs synchronously through the real
 * wired engine + sandbox pool; we then read the execution detail back and
 * assert the Code node ran (console output captured into the log).
 */
import type { FastifyInstance } from 'fastify';
import type { UserFromGetMe } from 'grammy/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SESSION_COOKIE, buildApp } from '../src/app';
import { openDb, type Db } from '../src/db/index';
import { runMigrations } from '../src/db/migrate';
import { hostAllowed, wireEngine, type Engine } from '../src/engine/wire';
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
  const engine = wireEngine({ db, ctbSecret: SECRET });
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

/** A flow.manualTrigger → data.code graph (code logs + returns one item). */
function codeFlowGraph(code: string) {
  return {
    nodes: [
      { id: 'trig', type: 'flow.manualTrigger', params: { sample: '{}' } },
      { id: 'code', type: 'data.code', params: { mode: 'run_once', code } },
    ],
    edges: [{ id: 'e1', from: { node: 'trig', port: 'main' }, to: { node: 'code', port: 'main' } }],
  };
}

async function createBot(w: World): Promise<string> {
  const res = await w.app.inject({
    method: 'POST', url: '/api/bots', cookies: w.cookie,
    payload: { name: 'bot', token: TOKEN },
  });
  expect(res.statusCode).toBe(201);
  return res.json().bot.id as string;
}

async function createFlow(w: World, botId: string, graph: unknown): Promise<string> {
  const res = await w.app.inject({
    method: 'POST', url: '/api/flows', cookies: w.cookie,
    payload: { botId, name: 'code flow', graph },
  });
  expect(res.statusCode).toBe(201);
  return res.json().flow.id as string;
}

describe('POST /api/flows/:id/run (P2-T7)', () => {
  let w: World;
  beforeEach(async () => { w = await makeWorld(); });
  afterEach(async () => { await w.engine.gateway.stopAll(); await w.app.close(); });

  it('requires auth (401)', async () => {
    const res = await w.app.inject({ method: 'POST', url: '/api/flows/whatever/run' });
    expect(res.statusCode).toBe(401);
  });

  it('404 for an unknown flow id', async () => {
    const res = await w.app.inject({ method: 'POST', url: '/api/flows/missing/run', cookies: w.cookie });
    expect(res.statusCode).toBe(404);
  });

  it('422 when the flow has no enabled manual trigger', async () => {
    const botId = await createBot(w);
    const id = await createFlow(w, botId, {
      nodes: [{ id: 'code', type: 'data.code', params: { mode: 'run_once', code: 'return 1;' } }],
      edges: [],
    });
    const res = await w.app.inject({ method: 'POST', url: `/api/flows/${id}/run`, cookies: w.cookie });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toBe('no_manual_trigger');
  });

  it('runs a manualTrigger → code flow to completion and captures console output', async () => {
    const botId = await createBot(w);
    const id = await createFlow(w, botId, codeFlowGraph('console.log("ran in sandbox"); return { ok: true };'));
    const res = await w.app.inject({ method: 'POST', url: `/api/flows/${id}/run`, cookies: w.cookie });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('done');
    expect(body.error).toBeNull();
    expect(typeof body.executionId).toBe('string');

    // The execution detail carries the Code node's captured console line.
    const detail = await w.app.inject({
      method: 'GET', url: `/api/executions/${body.executionId}`, cookies: w.cookie,
    });
    expect(detail.statusCode).toBe(200);
    const logs = detail.json().execution.logs as { message: string }[];
    expect(logs.some((l) => l.message.includes('ran in sandbox'))).toBe(true);
  });

  it('surfaces a user-code error as status=error (honest test run)', async () => {
    const botId = await createBot(w);
    const id = await createFlow(w, botId, codeFlowGraph('throw new Error("kaboom");'));
    const res = await w.app.inject({ method: 'POST', url: `/api/flows/${id}/run`, cookies: w.cookie });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('error');
    expect(body.error).toMatch(/kaboom/);
  });
});

describe('hostAllowed — Code node $http allow-list (ARCH §11)', () => {
  it('empty allow-list ⇒ unrestricted', () => {
    expect(hostAllowed('https://anything.example.com/x', [])).toBe(true);
  });

  it('exact host match', () => {
    expect(hostAllowed('https://api.example.com/v1', ['api.example.com'])).toBe(true);
    expect(hostAllowed('https://evil.com/v1', ['api.example.com'])).toBe(false);
  });

  it('dot-prefixed entry matches the apex and any subdomain', () => {
    const list = ['.example.com'];
    expect(hostAllowed('https://example.com/', list)).toBe(true);
    expect(hostAllowed('https://hooks.example.com/abc', list)).toBe(true);
    expect(hostAllowed('https://example.com.evil.net/', list)).toBe(false);
  });

  it('case-insensitive host comparison', () => {
    expect(hostAllowed('https://API.Example.COM/x', ['api.example.com'])).toBe(true);
  });

  it('an unparseable url is rejected when a list is set', () => {
    expect(hostAllowed('not a url', ['api.example.com'])).toBe(false);
  });
});
