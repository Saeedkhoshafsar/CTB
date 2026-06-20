/**
 * PD-T1 — DB connection pooling + safety. This battery proves the hardening
 * added in PD-T1, end-to-end through the wired engine with an INJECTED recording
 * pool factory (no real socket — invariant I3 keeps the driver at the edge):
 *
 *   1. SQL-injection safety (the cardinal rule of db.postgres/db.mysql):
 *      • hostile VALUES are always BOUND, never spliced into the SQL text;
 *      • hostile IDENTIFIERS (table/column/order_by) are rejected by the node's
 *        strict identifier regex before any query is built;
 *      • a `query` operation passes the author's verbatim text through, so the
 *        only safe way to interpolate user data there is `$1`/`?` bind params —
 *        a `';DROP TABLE'`-style value rides as a bound param, not SQL.
 *
 *   2. Pool limits + statement timeout reach the factory: the resolved
 *      credential's `poolMax`/`statementTimeoutMs`/`readOnly` are handed to the
 *      pool factory (where the real pg/mysql driver enforces them) and default
 *      sensibly when omitted.
 *
 *   3. Read-only credentials refuse writes: a read-only credential makes the
 *      HOST reject an insert/update/delete/`query` (fail-closed: a missing
 *      `write` flag is treated as a write) BEFORE it reaches the pool, while a
 *      plain SELECT still goes through.
 */
import type { FastifyInstance } from 'fastify';
import type { UserFromGetMe } from 'grammy/types';
import { afterEach, describe, expect, it } from 'vitest';
import { SESSION_COOKIE, buildApp } from '../src/app';
import { openDb, type Db } from '../src/db/index';
import { runMigrations } from '../src/db/migrate';
import {
  wireEngine,
  type DbPool,
  type DbPoolConfig,
  type DbPoolFactory,
  type Engine,
  type MysqlPoolFactory,
} from '../src/engine/wire';
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
  cfg: DbPoolConfig;
  queries: QueryLog[];
  ended: boolean;
}

/** A recording fake pool factory shared by both dialects — logs cfg + queries. */
function makeFakeFactory(
  result: { rows: Record<string, unknown>[]; rowCount: number | null },
  built: FakePool[],
): DbPoolFactory & MysqlPoolFactory {
  return (cfg) => {
    const pool: FakePool = {
      cfg,
      queries: [],
      ended: false,
      // A read-only pool surfaces its flag (the real pg pool does too); makeDb
      // falls back to cfg.readOnly when undefined, so set it from cfg here.
      readOnly: cfg.readOnly,
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
  const factory = makeFakeFactory(result, built);
  // One factory serves both dialects in this battery — the credential type +
  // the node's requested dialect still route correctly.
  const engine = wireEngine({
    db,
    ctbSecret: SECRET,
    dbPoolFactory: factory,
    mysqlPoolFactory: factory,
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
    method: 'POST', url: '/api/credentials', cookies: w.cookie, payload: { name: 'db', data },
  });
  expect(res.statusCode).toBe(201);
  return res.json().credential.id as string;
}

async function createFlow(w: World, botId: string, nodeType: string, params: Record<string, unknown>): Promise<string> {
  const graph = {
    nodes: [
      { id: 'trig', type: 'flow.manualTrigger', params: { sample: '{}' } },
      { id: 'db', type: nodeType, params },
    ],
    edges: [{ id: 'e1', from: { node: 'trig', port: 'main' }, to: { node: 'db', port: 'main' } }],
  };
  const res = await w.app.inject({
    method: 'POST', url: '/api/flows', cookies: w.cookie, payload: { botId, name: 'db flow', graph },
  });
  expect(res.statusCode).toBe(201);
  return res.json().flow.id as string;
}

async function run(w: World, flowId: string): Promise<{ status: string; error?: string; executionId: string }> {
  const res = await w.app.inject({ method: 'POST', url: `/api/flows/${flowId}/run`, cookies: w.cookie });
  expect(res.statusCode).toBe(200);
  return res.json();
}

const PG = { type: 'postgres', host: 'h', database: 'd', user: 'u', password: 'p', ssl: false } as const;
const MY = { type: 'mysql', host: 'h', database: 'd', user: 'u', password: 'p', ssl: false } as const;

// ───────────────────────────── SQL injection ──────────────────────────────

describe('PD-T1 — SQL-injection safety (db.postgres / db.mysql)', () => {
  let w: World;
  afterEach(async () => {
    await w.engine.closeDbPools();
    await w.engine.gateway.stopAll();
    await w.app.close();
  });

  it('binds a hostile VALUE rather than splicing it into the SQL (insert)', async () => {
    w = await makeWorld({ rows: [{ id: 1 }], rowCount: 1 });
    const botId = await createBot(w);
    const credId = await createCredential(w, PG);
    const evil = "Robert'); DROP TABLE students;--";
    const flowId = await createFlow(w, botId, 'db.postgres', {
      credentialId: credId,
      operation: 'insert',
      table: 'students',
      values: [{ field: 'name', value: evil }],
    });
    const out = await run(w, flowId);
    expect(out.status).toBe('done');

    expect(w.built).toHaveLength(1);
    const pool = w.built[0]!;
    expect(pool.queries).toHaveLength(1);
    // The SQL text never contains the payload — only the placeholder.
    expect(pool.queries[0]!.sql).toBe('INSERT INTO "students" ("name") VALUES ($1) RETURNING *');
    expect(pool.queries[0]!.sql).not.toContain('DROP TABLE');
    // The whole payload rides as a single bound param, verbatim.
    expect(pool.queries[0]!.params).toEqual([evil]);
  });

  it('binds a hostile VALUE in a WHERE clause (select)', async () => {
    w = await makeWorld({ rows: [], rowCount: 0 });
    const botId = await createBot(w);
    const credId = await createCredential(w, PG);
    const evil = "x' OR '1'='1";
    const flowId = await createFlow(w, botId, 'db.postgres', {
      credentialId: credId,
      operation: 'select',
      table: 'users',
      where: [{ field: 'name', op: 'eq', value: evil }],
    });
    const out = await run(w, flowId);
    expect(out.status).toBe('done');
    const q = w.built[0]!.queries[0]!;
    expect(q.sql).toBe('SELECT * FROM "users" WHERE "name" = $1');
    expect(q.params).toEqual([evil]);
  });

  it('rejects a hostile TABLE identifier before any query is built (postgres)', async () => {
    w = await makeWorld({ rows: [], rowCount: 0 });
    const botId = await createBot(w);
    const credId = await createCredential(w, PG);
    const flowId = await createFlow(w, botId, 'db.postgres', {
      credentialId: credId,
      operation: 'select',
      table: 'users; DROP TABLE users',
    });
    const out = await run(w, flowId);
    expect(out.status).toBe('error');
    expect(out.error).toMatch(/unsafe SQL identifier/);
    // The injection never reached a pool query (the node bailed building the SQL).
    expect(w.built.flatMap((p) => p.queries)).toHaveLength(0);
  });

  it('rejects a hostile COLUMN identifier in a WHERE clause', async () => {
    w = await makeWorld({ rows: [], rowCount: 0 });
    const botId = await createBot(w);
    const credId = await createCredential(w, PG);
    const flowId = await createFlow(w, botId, 'db.postgres', {
      credentialId: credId,
      operation: 'select',
      table: 'users',
      where: [{ field: 'name = 1 OR 1=1 --', op: 'eq', value: 'x' }],
    });
    const out = await run(w, flowId);
    expect(out.status).toBe('error');
    expect(out.error).toMatch(/unsafe SQL identifier/);
  });

  it('rejects a hostile ORDER BY identifier', async () => {
    w = await makeWorld({ rows: [], rowCount: 0 });
    const botId = await createBot(w);
    const credId = await createCredential(w, PG);
    const flowId = await createFlow(w, botId, 'db.postgres', {
      credentialId: credId,
      operation: 'select',
      table: 'users',
      order_by: 'id; DELETE FROM users',
    });
    const out = await run(w, flowId);
    expect(out.status).toBe('error');
    expect(out.error).toMatch(/unsafe SQL identifier/);
  });

  it('passes a raw `query` statement verbatim — interpolation must use bind params (postgres)', async () => {
    w = await makeWorld({ rows: [{ id: 5 }], rowCount: 1 });
    const botId = await createBot(w);
    const credId = await createCredential(w, PG);
    const evil = "5; DROP TABLE users;--";
    const flowId = await createFlow(w, botId, 'db.postgres', {
      credentialId: credId,
      operation: 'query',
      query: 'SELECT * FROM users WHERE id = $1',
      params: JSON.stringify([evil]),
    });
    const out = await run(w, flowId);
    expect(out.status).toBe('done');
    const q = w.built[0]!.queries[0]!;
    // The author's statement text is unchanged; the payload is a bound param.
    expect(q.sql).toBe('SELECT * FROM users WHERE id = $1');
    expect(q.params).toEqual([evil]);
  });

  it('binds a hostile VALUE for mysql too (? placeholders)', async () => {
    w = await makeWorld({ rows: [{ insertId: 1, affectedRows: 1 }], rowCount: 1 });
    const botId = await createBot(w);
    const credId = await createCredential(w, MY);
    const evil = "'; DROP TABLE t;--";
    const flowId = await createFlow(w, botId, 'db.mysql', {
      credentialId: credId,
      operation: 'insert',
      table: 'logs',
      values: [{ field: 'msg', value: evil }],
    });
    const out = await run(w, flowId);
    expect(out.status).toBe('done');
    const q = w.built[0]!.queries[0]!;
    expect(q.sql).toBe('INSERT INTO `logs` (`msg`) VALUES (?)');
    expect(q.sql).not.toContain('DROP TABLE');
    expect(q.params).toEqual([evil]);
  });

  it('rejects a hostile TABLE identifier for mysql', async () => {
    w = await makeWorld({ rows: [], rowCount: 0 });
    const botId = await createBot(w);
    const credId = await createCredential(w, MY);
    const flowId = await createFlow(w, botId, 'db.mysql', {
      credentialId: credId,
      operation: 'select',
      table: '`t`; DROP TABLE t',
    });
    const out = await run(w, flowId);
    expect(out.status).toBe('error');
    expect(out.error).toMatch(/unsafe SQL identifier/);
    expect(w.built.flatMap((p) => p.queries)).toHaveLength(0);
  });
});

// ──────────────────────── pool limits + timeout ───────────────────────────

describe('PD-T1 — pool limits + statement timeout reach the factory', () => {
  let w: World;
  afterEach(async () => {
    await w.engine.closeDbPools();
    await w.engine.gateway.stopAll();
    await w.app.close();
  });

  it('hands the credential poolMax + statementTimeoutMs to the pg factory', async () => {
    w = await makeWorld({ rows: [{ n: 1 }], rowCount: 1 });
    const botId = await createBot(w);
    const credId = await createCredential(w, { ...PG, poolMax: 12, statementTimeoutMs: 7500 });
    const flowId = await createFlow(w, botId, 'db.postgres', {
      credentialId: credId, operation: 'query', query: 'SELECT 1',
    });
    expect((await run(w, flowId)).status).toBe('done');
    const cfg = w.built[0]!.cfg;
    expect(cfg.poolMax).toBe(12);
    expect(cfg.statementTimeoutMs).toBe(7500);
    expect(cfg.readOnly).toBe(false);
  });

  it('applies sensible defaults when the hardening fields are omitted', async () => {
    w = await makeWorld({ rows: [{ n: 1 }], rowCount: 1 });
    const botId = await createBot(w);
    const credId = await createCredential(w, PG); // no poolMax / timeout / readOnly
    const flowId = await createFlow(w, botId, 'db.postgres', {
      credentialId: credId, operation: 'query', query: 'SELECT 1',
    });
    expect((await run(w, flowId)).status).toBe('done');
    const cfg = w.built[0]!.cfg;
    // Schema defaults: poolMax 5, statementTimeoutMs 30000, readOnly false.
    expect(cfg.poolMax).toBe(5);
    expect(cfg.statementTimeoutMs).toBe(30_000);
    expect(cfg.readOnly).toBe(false);
  });

  it('hands the credential poolMax + statementTimeoutMs to the mysql factory', async () => {
    w = await makeWorld({ rows: [{ n: 1 }], rowCount: 1 });
    const botId = await createBot(w);
    const credId = await createCredential(w, { ...MY, poolMax: 3, statementTimeoutMs: 1000 });
    const flowId = await createFlow(w, botId, 'db.mysql', {
      credentialId: credId, operation: 'query', query: 'SELECT 1',
    });
    expect((await run(w, flowId)).status).toBe('done');
    const cfg = w.built[0]!.cfg;
    expect(cfg.poolMax).toBe(3);
    expect(cfg.statementTimeoutMs).toBe(1000);
  });
});

// ──────────────────────────── read-only ───────────────────────────────────

describe('PD-T1 — read-only credentials refuse writes', () => {
  let w: World;
  afterEach(async () => {
    await w.engine.closeDbPools();
    await w.engine.gateway.stopAll();
    await w.app.close();
  });

  it('lets a SELECT through a read-only postgres credential', async () => {
    w = await makeWorld({ rows: [{ id: 1 }], rowCount: 1 });
    const botId = await createBot(w);
    const credId = await createCredential(w, { ...PG, readOnly: true });
    const flowId = await createFlow(w, botId, 'db.postgres', {
      credentialId: credId, operation: 'select', table: 'users',
    });
    const out = await run(w, flowId);
    expect(out.status).toBe('done');
    // readOnly intent reached the factory AND the SELECT actually executed.
    expect(w.built[0]!.cfg.readOnly).toBe(true);
    expect(w.built[0]!.queries).toHaveLength(1);
    expect(w.built[0]!.queries[0]!.sql).toBe('SELECT * FROM "users"');
  });

  it('refuses an INSERT through a read-only postgres credential, before the pool runs', async () => {
    w = await makeWorld({ rows: [], rowCount: 0 });
    const botId = await createBot(w);
    const credId = await createCredential(w, { ...PG, readOnly: true });
    const flowId = await createFlow(w, botId, 'db.postgres', {
      credentialId: credId,
      operation: 'insert',
      table: 'users',
      values: [{ field: 'name', value: 'x' }],
    });
    const out = await run(w, flowId);
    expect(out.status).toBe('error');
    expect(out.error).toMatch(/read-only/);
    // The host rejected it — the pool was built but never received the write.
    expect(w.built[0]!.queries).toHaveLength(0);
  });

  it('refuses an UPDATE through a read-only credential', async () => {
    w = await makeWorld({ rows: [], rowCount: 0 });
    const botId = await createBot(w);
    const credId = await createCredential(w, { ...PG, readOnly: true });
    const flowId = await createFlow(w, botId, 'db.postgres', {
      credentialId: credId,
      operation: 'update',
      table: 'users',
      values: [{ field: 'name', value: 'x' }],
      where: [{ field: 'id', op: 'eq', value: '1' }],
    });
    const out = await run(w, flowId);
    expect(out.status).toBe('error');
    expect(out.error).toMatch(/read-only/);
    expect(w.built[0]!.queries).toHaveLength(0);
  });

  it('fail-closed: refuses an arbitrary `query` through a read-only credential (treated as a write)', async () => {
    w = await makeWorld({ rows: [], rowCount: 0 });
    const botId = await createBot(w);
    const credId = await createCredential(w, { ...PG, readOnly: true });
    // Even though this happens to be a SELECT, the node marks `query` as a write
    // (it can't statically know), so a read-only credential refuses it.
    const flowId = await createFlow(w, botId, 'db.postgres', {
      credentialId: credId, operation: 'query', query: 'SELECT 1',
    });
    const out = await run(w, flowId);
    expect(out.status).toBe('error');
    expect(out.error).toMatch(/read-only/);
    expect(w.built[0]!.queries).toHaveLength(0);
  });

  it('refuses a write through a read-only MYSQL credential (host-side enforcement)', async () => {
    w = await makeWorld({ rows: [], rowCount: 0 });
    const botId = await createBot(w);
    const credId = await createCredential(w, { ...MY, readOnly: true });
    const flowId = await createFlow(w, botId, 'db.mysql', {
      credentialId: credId,
      operation: 'insert',
      table: 'logs',
      values: [{ field: 'msg', value: 'x' }],
    });
    const out = await run(w, flowId);
    expect(out.status).toBe('error');
    expect(out.error).toMatch(/read-only/);
    expect(w.built[0]!.queries).toHaveLength(0);
  });

  it('lets writes through a normal (writable) credential', async () => {
    w = await makeWorld({ rows: [{ id: 1 }], rowCount: 1 });
    const botId = await createBot(w);
    const credId = await createCredential(w, PG); // readOnly defaults to false
    const flowId = await createFlow(w, botId, 'db.postgres', {
      credentialId: credId,
      operation: 'insert',
      table: 'users',
      values: [{ field: 'name', value: 'x' }],
    });
    const out = await run(w, flowId);
    expect(out.status).toBe('done');
    expect(w.built[0]!.queries).toHaveLength(1);
  });
});
