/**
 * PB-T2 — server side of db.postgres: the `makeDb` capability wired into the
 * engine, exercised end-to-end through a real wired engine + in-memory DB with
 * an INJECTED pool factory (no real Postgres socket — invariant I3 keeps the
 * driver at the edge; here we replace it with a recording fake).
 *
 * We create a `postgres` credential (encrypted at rest — I7), build a
 * flow.manualTrigger → db.postgres flow, run it, and assert:
 *   - the host built a pool from the DECRYPTED credential (host/db/user/ssl…),
 *   - the parameterized statement + bound params reached the pool verbatim,
 *   - the result rows landed on the node output,
 *   - the password never surfaces in the run response (I6/I7),
 *   - pools are cached per credentialId (one factory call across runs) and
 *     drained by closeDbPools(),
 *   - a wrong-type credential is rejected before any pool is built.
 */
import type { FastifyInstance } from 'fastify';
import type { UserFromGetMe } from 'grammy/types';
import { afterEach, describe, expect, it } from 'vitest';
import { SESSION_COOKIE, buildApp } from '../src/app';
import { openDb, type Db } from '../src/db/index';
import { runMigrations } from '../src/db/migrate';
import { wireEngine, type DbPool, type DbPoolFactory, type Engine } from '../src/engine/wire';
import { loadEnv } from '../src/lib/env';

const SECRET = 'devsecret0123456';
const TOKEN = '123456789:AAEexampletokenexampletokenexample';
const BOT_INFO: UserFromGetMe = {
  id: 42, is_bot: true, first_name: 'TestBot', username: 'test_bot',
  can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: false,
  can_connect_to_business: false, has_main_web_app: false, can_manage_bots: false,
  has_topics_enabled: false, allows_users_to_create_topics: false,
};

interface QueryLog {
  sql: string;
  params: unknown[];
}
interface FakePool extends DbPool {
  cfg: Parameters<DbPoolFactory>[0];
  queries: QueryLog[];
  ended: boolean;
}

/** A recording fake pool factory — returns a scripted result, logs everything. */
function makeFakeFactory(
  result: { rows: Record<string, unknown>[]; rowCount: number | null },
  built: FakePool[],
): { factory: DbPoolFactory; built: FakePool[] } {
  const factory: DbPoolFactory = (cfg) => {
    const pool: FakePool = {
      cfg,
      queries: [],
      ended: false,
      async query(sql, params) {
        this.queries.push({ sql, params });
        return result;
      },
      async end() {
        this.ended = true;
      },
    };
    built.push(pool);
    return pool;
  };
  return { factory, built };
}

interface World {
  app: FastifyInstance;
  db: Db;
  engine: Engine;
  cookie: { [k: string]: string };
  built: FakePool[];
}

async function makeWorld(result: {
  rows: Record<string, unknown>[];
  rowCount: number | null;
}): Promise<World> {
  const env = loadEnv({ CTB_SECRET: SECRET, CTB_ADMIN_PASS: 'hunter2hunter2', NODE_ENV: 'test' } as NodeJS.ProcessEnv);
  const { db } = openDb(':memory:');
  runMigrations(db);
  const built: FakePool[] = [];
  const { factory } = makeFakeFactory(result, built);
  const engine = wireEngine({ db, ctbSecret: SECRET, dbPoolFactory: factory });
  const app = buildApp({
    env, db, engine, logger: false, editorDistDir: '/nonexistent',
    botRegisterOpts: () => ({ botInfo: BOT_INFO, callApi: async () => ({ message_id: 1 }) }),
  });
  const login = await app.inject({
    method: 'POST', url: '/api/auth/login',
    payload: { username: 'admin', password: 'hunter2hunter2' },
  });
  const cookie = { [SESSION_COOKIE]: login.cookies.find((c) => c.name === SESSION_COOKIE)!.value };
  return { app, db, engine, cookie, built };
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
    method: 'POST', url: '/api/credentials', cookies: w.cookie, payload: { name: 'pg', data },
  });
  expect(res.statusCode).toBe(201);
  return res.json().credential.id as string;
}

async function createFlow(w: World, botId: string, graph: unknown): Promise<string> {
  const res = await w.app.inject({
    method: 'POST', url: '/api/flows', cookies: w.cookie, payload: { botId, name: 'pg flow', graph },
  });
  expect(res.statusCode).toBe(201);
  return res.json().flow.id as string;
}

function pgFlowGraph(credentialId: string, params: Record<string, unknown>) {
  return {
    nodes: [
      { id: 'trig', type: 'flow.manualTrigger', params: { sample: '{}' } },
      { id: 'pg', type: 'db.postgres', params: { credentialId, ...params } },
    ],
    edges: [{ id: 'e1', from: { node: 'trig', port: 'main' }, to: { node: 'pg', port: 'main' } }],
  };
}

/** Pull the db.postgres node's output items out of the execution logs. */
async function pgOutputItems(w: World, executionId: string): Promise<Record<string, unknown>[]> {
  const detail = await w.app.inject({
    method: 'GET', url: `/api/executions/${executionId}`, cookies: w.cookie,
  });
  const logs = detail.json().execution.logs as {
    nodeId: string | null;
    output: Record<string, { json: Record<string, unknown> }[]> | null;
  }[];
  const row = logs.find((l) => l.nodeId === 'pg' && l.output);
  expect(row).toBeTruthy();
  return row!.output!.main!.map((it) => it.json);
}

describe('db.postgres via wired engine (PB-T2)', () => {
  let w: World;
  afterEach(async () => {
    await w.engine.closeDbPools();
    await w.engine.gateway.stopAll();
    await w.app.close();
  });

  it('builds a pool from the decrypted credential and runs the parameterized query', async () => {
    w = await makeWorld({ rows: [{ id: 7, name: 'Sara' }], rowCount: 1 });
    const botId = await createBot(w);
    const credId = await createCredential(w, {
      type: 'postgres', host: 'db.internal', port: 5432, database: 'app',
      user: 'svc', password: 'pg-secret-xyz', ssl: true,
    });
    const flowId = await createFlow(
      w, botId,
      pgFlowGraph(credId, { operation: 'query', query: 'SELECT * FROM users WHERE id = $1', params: '[7]' }),
    );

    const res = await w.app.inject({ method: 'POST', url: `/api/flows/${flowId}/run`, cookies: w.cookie });
    expect(res.statusCode).toBe(200);
    const out = res.json();
    expect(out.status).toBe('done');

    // The pool was built once from the decrypted DSN parts (I7 — host resolves).
    expect(w.built).toHaveLength(1);
    const pool = w.built[0]!;
    expect(pool.cfg.host).toBe('db.internal');
    expect(pool.cfg.database).toBe('app');
    expect(pool.cfg.user).toBe('svc');
    expect(pool.cfg.password).toBe('pg-secret-xyz');
    expect(pool.cfg.ssl).toBe(true);

    // The parameterized statement + bound params reached the pool verbatim.
    expect(pool.queries).toHaveLength(1);
    expect(pool.queries[0]!.sql).toBe('SELECT * FROM users WHERE id = $1');
    expect(pool.queries[0]!.params).toEqual([7]);

    // The result rows landed on the node output.
    const items = await pgOutputItems(w, out.executionId);
    expect(items).toEqual([{ id: 7, name: 'Sara' }]);

    // The password never surfaces in the run response (I6/I7).
    expect(JSON.stringify(out)).not.toContain('pg-secret-xyz');
  });

  it('builds a SELECT helper statement and caches the pool per credentialId', async () => {
    w = await makeWorld({ rows: [{ n: 1 }], rowCount: 1 });
    const botId = await createBot(w);
    const credId = await createCredential(w, {
      type: 'postgres', host: 'h', database: 'd', user: 'u', password: 'p', ssl: false,
    });
    const flowId = await createFlow(
      w, botId,
      pgFlowGraph(credId, {
        operation: 'select', table: 'orders',
        where: [{ field: 'status', op: 'eq', value: 'open' }],
        limit: 5,
      }),
    );

    // Run twice — the pool must be created once and reused.
    for (let i = 0; i < 2; i++) {
      const res = await w.app.inject({ method: 'POST', url: `/api/flows/${flowId}/run`, cookies: w.cookie });
      expect(res.json().status).toBe('done');
    }
    expect(w.built).toHaveLength(1); // cached per credentialId
    const pool = w.built[0]!;
    expect(pool.queries).toHaveLength(2);
    expect(pool.queries[0]!.sql).toBe('SELECT * FROM "orders" WHERE "status" = $1 LIMIT 5');
    expect(pool.queries[0]!.params).toEqual(['open']);
  });

  it('closeDbPools drains every pool', async () => {
    w = await makeWorld({ rows: [], rowCount: 0 });
    const botId = await createBot(w);
    const credId = await createCredential(w, {
      type: 'postgres', host: 'h', database: 'd', user: 'u', password: 'p', ssl: false,
    });
    const flowId = await createFlow(w, botId, pgFlowGraph(credId, { operation: 'query', query: 'SELECT 1' }));
    await w.app.inject({ method: 'POST', url: `/api/flows/${flowId}/run`, cookies: w.cookie });
    expect(w.built).toHaveLength(1);
    expect(w.built[0]!.ended).toBe(false);
    await w.engine.closeDbPools();
    expect(w.built[0]!.ended).toBe(true);
  });

  it('rejects a credential that is not a postgres type, before any pool is built', async () => {
    w = await makeWorld({ rows: [], rowCount: 0 });
    const botId = await createBot(w);
    const credId = await createCredential(w, { type: 'httpBearerAuth', token: 'tok_abcdefghij' });
    const flowId = await createFlow(w, botId, pgFlowGraph(credId, { operation: 'query', query: 'SELECT 1' }));
    const res = await w.app.inject({ method: 'POST', url: `/api/flows/${flowId}/run`, cookies: w.cookie });
    const out = res.json();
    expect(out.status).toBe('error');
    expect(out.error).toMatch(/not a Postgres credential/);
    expect(w.built).toHaveLength(0); // never built a pool
  });
});
