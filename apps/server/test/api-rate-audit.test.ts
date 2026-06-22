/**
 * PD-T3 — Public-API hardening: per-token rate limiting + an append-only audit
 * log over the `/api/v1/*` surface. Mix of focused unit tests (the limiter +
 * the audit store in isolation) and end-to-end tests over a real in-memory DB +
 * fully wired engine (fake Telegram transport), mirroring api-v1.test.ts.
 *
 * Covers the PD-T3 contract:
 *  • RateLimiter — sliding window: admits up to `limit`/window, then refuses with
 *    a retry-after; `0` = unlimited; a window slides as time passes; forget/reset.
 *  • SqliteApiAuditStore — record + most-recent-first list, token/bot filters, cap.
 *  • token config — POST /api/api-tokens accepts + echoes rateLimitPerMin (default 120).
 *  • rate limit over the app — a token with a small quota gets 429 + retry-after,
 *    and the limiter is keyed per-token (one token's breach doesn't block another).
 *  • audit over the app — authoring/trigger/send calls write a row (with status +
 *    targetId); plain reads do not; a 403 is logged just like a success.
 *  • GET /api/v1/audit — instance-wide sees all (filterable by bot), bot-scoped is
 *    locked to its own bot.
 */
import { type ApiAuditEntry, type ApiTokenCreated, type FlowGraph, FlowGraphSchema } from '@ctb/shared';
import type { FastifyInstance } from 'fastify';
import type { UserFromGetMe } from 'grammy/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SESSION_COOKIE, buildApp } from '../src/app';
import { openDb, type Db } from '../src/db/index';
import { runMigrations } from '../src/db/migrate';
import { wireEngine, type Engine } from '../src/engine/wire';
import { RateLimiter } from '../src/lib/rate-limiter';
import { SqliteApiAuditStore } from '../src/engine/audit-store';
import { loadEnv } from '../src/lib/env';

const SECRET = 'devsecret0123456';
const TOKEN = '123456789:AAEexampletokenexampletokenexample';

const BOT_INFO: UserFromGetMe = {
  id: 42, is_bot: true, first_name: 'TestBot', username: 'test_bot',
  can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: false,
  can_connect_to_business: false, has_main_web_app: false, can_manage_bots: false,
  has_topics_enabled: false, allows_users_to_create_topics: false,
};

// ===========================================================================
// Unit: RateLimiter (deterministic via an injected clock)
// ===========================================================================
describe('RateLimiter (PD-T3)', () => {
  it('admits up to `limit` per window, then refuses with a retry-after', () => {
    let t = 1_000_000;
    const rl = new RateLimiter(() => t);
    expect(rl.check('k', 2)).toMatchObject({ allowed: true, remaining: 1 });
    expect(rl.check('k', 2)).toMatchObject({ allowed: true, remaining: 0 });
    const blocked = rl.check('k', 2);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSec).toBeGreaterThanOrEqual(1);
    expect(blocked.retryAfterSec).toBeLessThanOrEqual(60);
  });

  it('a blocked check does not push recovery further out', () => {
    let t = 0;
    const rl = new RateLimiter(() => t);
    rl.check('k', 1); // fills the window at t=0
    t = 30_000;
    const a = rl.check('k', 1); // blocked; recovery ~30s away
    expect(a.allowed).toBe(false);
    t = 40_000;
    const b = rl.check('k', 1); // still blocked but closer — not reset by the rejection
    expect(b.allowed).toBe(false);
    expect(b.retryAfterSec).toBeLessThan(a.retryAfterSec);
  });

  it('window slides: once the oldest hit ages out, a slot frees up', () => {
    let t = 0;
    const rl = new RateLimiter(() => t);
    rl.check('k', 1);
    t = 60_001; // past the 60s window
    expect(rl.check('k', 1).allowed).toBe(true);
  });

  it('`0` (and negatives) mean unlimited — always allowed, never recorded', () => {
    const rl = new RateLimiter(() => 0);
    for (let i = 0; i < 1000; i++) expect(rl.check('k', 0).allowed).toBe(true);
    expect(rl.check('k', -5).allowed).toBe(true);
  });

  it('keys are independent; forget + reset clear windows', () => {
    let t = 0;
    const rl = new RateLimiter(() => t);
    rl.check('a', 1);
    expect(rl.check('a', 1).allowed).toBe(false);
    expect(rl.check('b', 1).allowed).toBe(true); // separate key, own window
    rl.forget('a');
    expect(rl.check('a', 1).allowed).toBe(true); // forgotten → fresh
    rl.reset();
    expect(rl.check('a', 1).allowed).toBe(true);
    expect(rl.check('b', 1).allowed).toBe(true);
  });
});

// ===========================================================================
// Unit: SqliteApiAuditStore
// ===========================================================================
describe('SqliteApiAuditStore (PD-T3)', () => {
  function fresh(): { store: SqliteApiAuditStore; db: Db } {
    const { db } = openDb(':memory:');
    runMigrations(db);
    let n = 0;
    const store = new SqliteApiAuditStore(db, () => new Date(1_700_000_000_000 + n++ * 1000));
    return { store, db };
  }

  // The unit tests record with `tokenId: null` — the `api_audit.token_id`
  // FK is `ON DELETE SET NULL`, and these tests don't seed `api_tokens`, so a
  // null avoids a foreign-key violation while still exercising record/list.
  it('records rows and lists them most-recent-first', () => {
    const { store } = fresh();
    store.record({ tokenId: null, botId: 'b1', action: 'flow.create', method: 'POST', route: 'POST /api/v1/flows', targetId: null, status: 201 });
    store.record({ tokenId: null, botId: 'b1', action: 'flow.activate', method: 'POST', route: 'POST /api/v1/flows/activate', targetId: 'f1', status: 200 });
    const entries = store.list();
    expect(entries).toHaveLength(2);
    expect(entries[0]!.action).toBe('flow.activate'); // newest first (desc by id)
    expect(entries[0]!.targetId).toBe('f1');
    expect(entries[1]!.action).toBe('flow.create');
  });

  it('filters by bot', () => {
    const { store } = fresh();
    store.record({ tokenId: null, botId: 'b1', action: 'a', method: 'POST', route: 'r', status: 200 });
    store.record({ tokenId: null, botId: 'b2', action: 'b', method: 'POST', route: 'r', status: 200 });
    store.record({ tokenId: null, botId: 'b2', action: 'c', method: 'POST', route: 'r', status: 200 });
    expect(store.list({ botId: 'b1' }).map((e) => e.action)).toEqual(['a']);
    expect(store.list({ botId: 'b2' }).map((e) => e.action).sort()).toEqual(['b', 'c']);
  });

  it('honors the limit (and the store cap)', () => {
    const { store } = fresh();
    for (let i = 0; i < 10; i++) {
      store.record({ tokenId: null, botId: null, action: `a${i}`, method: 'POST', route: 'r', status: 200 });
    }
    expect(store.list({ limit: 3 })).toHaveLength(3);
    expect(store.list({ limit: 100000 }).length).toBeLessThanOrEqual(500); // capped
  });
});

// ===========================================================================
// E2E over the app
// ===========================================================================
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

function triggerGraph(): FlowGraph {
  return FlowGraphSchema.parse({
    nodes: [
      { id: 'trig', type: 'flow.manualTrigger', params: { sample: '{}' }, position: { x: 0, y: 0 }, disabled: false },
      { id: 'set', type: 'data.setFields', params: { fields: [{ target: 'json', name: 'seen', value: 'yes', op: 'set' }] }, position: { x: 200, y: 0 }, disabled: false },
    ],
    edges: [{ id: 'e1', from: { node: 'trig', port: 'main' }, to: { node: 'set', port: 'main' } }],
  });
}

async function createBot(w: World, name = 'b'): Promise<string> {
  const { bot } = (await w.app.inject({
    method: 'POST', url: '/api/bots', cookies: w.cookie, payload: { name, token: TOKEN },
  })).json() as { bot: { id: string } };
  return bot.id;
}

async function createFlow(w: World, botId: string, graph: FlowGraph): Promise<string> {
  const { flow } = (await w.app.inject({
    method: 'POST', url: '/api/flows', cookies: w.cookie, payload: { botId, name: 'audit flow', graph },
  })).json() as { flow: { id: string } };
  return flow.id;
}

async function startBot(w: World, botId: string): Promise<void> {
  const res = await w.app.inject({ method: 'POST', url: `/api/bots/${botId}/start`, cookies: w.cookie });
  expect(res.statusCode).toBe(200);
}

async function createToken(
  w: World,
  opts: { name?: string; botId?: string; rateLimitPerMin?: number } = {},
): Promise<ApiTokenCreated> {
  const res = await w.app.inject({
    method: 'POST', url: '/api/api-tokens', cookies: w.cookie,
    payload: {
      name: opts.name ?? 'ci',
      ...(opts.botId ? { botId: opts.botId } : {}),
      ...(opts.rateLimitPerMin !== undefined ? { rateLimitPerMin: opts.rateLimitPerMin } : {}),
    },
  });
  expect(res.statusCode).toBe(201);
  return (res.json() as { apiToken: ApiTokenCreated }).apiToken;
}

function bearer(token: string): { authorization: string } {
  return { authorization: `Bearer ${token}` };
}

describe('v1 token rate-limit config (PD-T3)', () => {
  let w: World;
  beforeEach(async () => { w = await makeWorld(); });
  afterEach(async () => { await w.engine.gateway.stopAll(); await w.app.close(); });

  it('defaults rateLimitPerMin to 120 when omitted', async () => {
    const created = await createToken(w);
    expect(created.rateLimitPerMin).toBe(120);
  });

  it('echoes a custom rateLimitPerMin on create and list', async () => {
    const created = await createToken(w, { rateLimitPerMin: 5 });
    expect(created.rateLimitPerMin).toBe(5);
    const list = (await w.app.inject({ method: 'GET', url: '/api/api-tokens', cookies: w.cookie }))
      .json() as { tokens: { id: string; rateLimitPerMin: number }[] };
    expect(list.tokens.find((t) => t.id === created.id)!.rateLimitPerMin).toBe(5);
  });
});

describe('v1 rate limiting (PD-T3)', () => {
  let w: World;
  beforeEach(async () => { w = await makeWorld(); });
  afterEach(async () => { await w.engine.gateway.stopAll(); await w.app.close(); });

  it('a token over its per-minute quota gets 429 + retry-after', async () => {
    const botId = await createBot(w);
    const token = (await createToken(w, { rateLimitPerMin: 2 })).token;
    const url = `/api/v1/users?bot_id=${botId}`;
    expect((await w.app.inject({ method: 'GET', url, headers: bearer(token) })).statusCode).toBe(200);
    expect((await w.app.inject({ method: 'GET', url, headers: bearer(token) })).statusCode).toBe(200);
    const third = await w.app.inject({ method: 'GET', url, headers: bearer(token) });
    expect(third.statusCode).toBe(429);
    expect(third.json().error).toBe('rate_limited');
    expect(Number(third.headers['retry-after'])).toBeGreaterThanOrEqual(1);
  });

  it('the limit is keyed per-token — one token’s breach does not block another', async () => {
    const botId = await createBot(w);
    const a = (await createToken(w, { name: 'a', rateLimitPerMin: 1 })).token;
    const b = (await createToken(w, { name: 'b', rateLimitPerMin: 1 })).token;
    const url = `/api/v1/users?bot_id=${botId}`;
    expect((await w.app.inject({ method: 'GET', url, headers: bearer(a) })).statusCode).toBe(200);
    expect((await w.app.inject({ method: 'GET', url, headers: bearer(a) })).statusCode).toBe(429);
    // b still has its own fresh window
    expect((await w.app.inject({ method: 'GET', url, headers: bearer(b) })).statusCode).toBe(200);
  });

  it('rateLimitPerMin = 0 means unlimited', async () => {
    const botId = await createBot(w);
    const token = (await createToken(w, { rateLimitPerMin: 0 })).token;
    const url = `/api/v1/users?bot_id=${botId}`;
    for (let i = 0; i < 30; i++) {
      expect((await w.app.inject({ method: 'GET', url, headers: bearer(token) })).statusCode).toBe(200);
    }
  });

  it('a rate-limited request is NOT audited (no apiToken stamped)', async () => {
    const token = (await createToken(w, { rateLimitPerMin: 1 })).token;
    // First POST flows (audited) succeeds-ish (400 unknown_bot but still audited);
    // second is rate-limited before auth context is stamped → no extra audit row.
    await w.app.inject({ method: 'POST', url: '/api/v1/flows', headers: bearer(token), payload: { botId: 'nope', name: 'x' } });
    const blocked = await w.app.inject({ method: 'POST', url: '/api/v1/flows', headers: bearer(token), payload: { botId: 'nope', name: 'y' } });
    expect(blocked.statusCode).toBe(429);
    // Exactly one audit row — the rate-limited call left none.
    const entries = w.engine.auditStore.list();
    expect(entries.filter((e) => e.action === 'flow.create')).toHaveLength(1);
  });
});

describe('v1 audit log (PD-T3)', () => {
  let w: World;
  beforeEach(async () => { w = await makeWorld(); });
  afterEach(async () => { await w.engine.gateway.stopAll(); await w.app.close(); });

  it('records authoring + trigger + send calls with action/target/status', async () => {
    const botId = await createBot(w);
    await startBot(w, botId);
    const token = (await createToken(w)).token;

    // create (POST /flows) → flow.create, target null, status 201
    const created = await w.app.inject({
      method: 'POST', url: '/api/v1/flows', headers: bearer(token),
      payload: { botId, name: 'a', graph: triggerGraph() },
    });
    const flowId = (created.json() as { flow: { id: string } }).flow.id;
    // activate → flow.activate, target = flowId, status 200
    await w.app.inject({ method: 'POST', url: `/api/v1/flows/${flowId}/activate`, headers: bearer(token) });
    // trigger → flow.trigger, target = flowId, status 202
    await w.app.inject({ method: 'POST', url: `/api/v1/flows/${flowId}/trigger`, headers: bearer(token), payload: {} });
    // send → bot.send, target = botId, status 200
    await w.app.inject({ method: 'POST', url: `/api/v1/bots/${botId}/send`, headers: bearer(token), payload: { chat_id: 1, text: 'hi' } });

    const entries = w.engine.auditStore.list();
    const byAction = new Map(entries.map((e) => [e.action, e]));
    expect(byAction.get('flow.create')).toMatchObject({ method: 'POST', route: 'POST /api/v1/flows', targetId: null, status: 201 });
    expect(byAction.get('flow.activate')).toMatchObject({ route: 'POST /api/v1/flows/activate', targetId: flowId, status: 200 });
    expect(byAction.get('flow.trigger')).toMatchObject({ route: 'POST /api/v1/flows/trigger', targetId: flowId, status: 202 });
    expect(byAction.get('bot.send')).toMatchObject({ route: 'POST /api/v1/bots/send', targetId: botId, status: 200 });
  });

  it('does NOT audit plain reads (node-types / executions / users)', async () => {
    const botId = await createBot(w);
    const token = (await createToken(w)).token;
    await w.app.inject({ method: 'GET', url: '/api/v1/node-types', headers: bearer(token) });
    await w.app.inject({ method: 'GET', url: '/api/v1/executions', headers: bearer(token) });
    await w.app.inject({ method: 'GET', url: `/api/v1/users?bot_id=${botId}`, headers: bearer(token) });
    expect(w.engine.auditStore.list()).toHaveLength(0);
  });

  it('logs a denied call too (a 403 is recorded just like a success)', async () => {
    const botA = await createBot(w, 'A');
    const botB = await createBot(w, 'B');
    const flowB = await createFlow(w, botB, triggerGraph());
    const scopedA = (await createToken(w, { botId: botA })).token;
    const r = await w.app.inject({ method: 'POST', url: `/api/v1/flows/${flowB}/activate`, headers: bearer(scopedA) });
    expect(r.statusCode).toBe(403);
    const entry = w.engine.auditStore.list().find((e) => e.action === 'flow.activate')!;
    expect(entry.status).toBe(403);
    expect(entry.targetId).toBe(flowB);
  });
});

describe('GET /api/v1/audit (PD-T3)', () => {
  let w: World;
  beforeEach(async () => { w = await makeWorld(); });
  afterEach(async () => { await w.engine.gateway.stopAll(); await w.app.close(); });

  it('instance-wide token sees all entries; can filter by bot', async () => {
    const botA = await createBot(w, 'A');
    const botB = await createBot(w, 'B');
    const wide = (await createToken(w, { rateLimitPerMin: 0 })).token;
    await w.app.inject({ method: 'POST', url: '/api/v1/flows', headers: bearer(wide), payload: { botId: botA, name: 'a', graph: triggerGraph() } });
    await w.app.inject({ method: 'POST', url: '/api/v1/flows', headers: bearer(wide), payload: { botId: botB, name: 'b', graph: triggerGraph() } });

    const all = await w.app.inject({ method: 'GET', url: '/api/v1/audit', headers: bearer(wide) });
    expect(all.statusCode).toBe(200);
    const allEntries = (all.json() as { entries: ApiAuditEntry[] }).entries;
    expect(allEntries.filter((e) => e.action === 'flow.create').length).toBe(2);

    const onlyB = await w.app.inject({ method: 'GET', url: `/api/v1/audit?bot_id=${botB}`, headers: bearer(wide) });
    const bEntries = (onlyB.json() as { entries: ApiAuditEntry[] }).entries;
    expect(bEntries.length).toBeGreaterThan(0);
    expect(bEntries.every((e) => e.botId === botB)).toBe(true);
  });

  it('bot-scoped token is locked to its own bot’s entries', async () => {
    const botA = await createBot(w, 'A');
    const botB = await createBot(w, 'B');
    const wide = (await createToken(w, { name: 'wide', rateLimitPerMin: 0 })).token;
    // Author on both bots with the wide token so audit rows exist for each.
    await w.app.inject({ method: 'POST', url: '/api/v1/flows', headers: bearer(wide), payload: { botId: botA, name: 'a', graph: triggerGraph() } });
    await w.app.inject({ method: 'POST', url: '/api/v1/flows', headers: bearer(wide), payload: { botId: botB, name: 'b', graph: triggerGraph() } });

    const scopedA = (await createToken(w, { name: 'sa', botId: botA, rateLimitPerMin: 0 })).token;
    const res = await w.app.inject({ method: 'GET', url: '/api/v1/audit', headers: bearer(scopedA) });
    expect(res.statusCode).toBe(200);
    const entries = (res.json() as { entries: ApiAuditEntry[] }).entries;
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.every((e) => e.botId === botA)).toBe(true); // never sees B

    // Even asking for B explicitly is rejected.
    const denied = await w.app.inject({ method: 'GET', url: `/api/v1/audit?bot_id=${botB}`, headers: bearer(scopedA) });
    expect(denied.statusCode).toBe(403);
  });
});
