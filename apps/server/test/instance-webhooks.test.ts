/**
 * P4-T4 — Outbound instance webhooks (PROTOCOL.md §Outbound). Two layers:
 *
 *  1. The WebhookDispatcher unit — over a real in-memory SQLite DB + a fake
 *     fetch: fan-out to all matching ACTIVE subscriptions, bot-scope filtering,
 *     event filtering, optional HMAC signature, retry/backoff on 5xx, no retry
 *     on 4xx, and last_fired_at / last_error bookkeeping.
 *  2. The end-to-end wiring through the app: admin CRUD (secret is write-only —
 *     never returned), and the two event sources actually firing —
 *     execution.finished (a flow run reaches terminal) and user.first_seen (a
 *     brand-new end user is touched).
 */
import { createHmac } from 'node:crypto';
import { FlowGraphSchema, type FlowGraph, type InstanceWebhookPublic, type OutboundEvent } from '@ctb/shared';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { UserFromGetMe } from 'grammy/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SESSION_COOKIE, buildApp } from '../src/app';
import { openDb, schema, type Db } from '../src/db/index';
import { runMigrations } from '../src/db/migrate';
import { wireEngine, type Engine } from '../src/engine/wire';
import { WebhookDispatcher } from '../src/engine/webhook-dispatcher';
import { loadEnv } from '../src/lib/env';

const SECRET = 'devsecret0123456';
const TOKEN = '123456789:AAEexampletokenexampletokenexample';

const BOT_INFO: UserFromGetMe = {
  id: 42, is_bot: true, first_name: 'TestBot', username: 'test_bot',
  can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: false,
  can_connect_to_business: false, has_main_web_app: false, can_manage_bots: false,
  has_topics_enabled: false, allows_users_to_create_topics: false,
};

// --------------------------------------------------------------------------
// A recording fake fetch — captures every delivery; programmable per-call status.
// --------------------------------------------------------------------------
interface Hit {
  url: string;
  body: string;
  headers: Record<string, string>;
}

function recordingFetch(statusFor: (url: string, n: number) => number) {
  const hits: Hit[] = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    const headers = init?.headers as Record<string, string>;
    hits.push({ url: u, body: String(init?.body ?? ''), headers });
    const callsToThisUrl = hits.filter((h) => h.url === u).length;
    const status = statusFor(u, callsToThisUrl);
    return new Response(null, { status });
  }) as unknown as typeof fetch;
  return { hits, fetchImpl };
}

/** Insert a minimal bot row so FK-referencing webhooks/executions are valid. */
function seedBot(db: Db, id: string): void {
  db.insert(schema.bots)
    .values({
      id,
      name: id,
      tokenEnc: 'x',
      mode: 'polling',
      status: 'inactive',
      settings: {},
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    })
    .run();
}

function seedWebhook(
  db: Db,
  row: Partial<typeof schema.instanceWebhooks.$inferInsert> & {
    url: string;
    events: string[];
  },
): string {
  const id = row.id ?? `wh-${Math.random().toString(36).slice(2)}`;
  db.insert(schema.instanceWebhooks)
    .values({
      id,
      name: row.name ?? 'wh',
      url: row.url,
      secret: row.secret ?? null,
      events: row.events,
      botId: row.botId ?? null,
      active: row.active ?? true,
      createdAt: '2026-01-01T00:00:00.000Z',
      lastFiredAt: null,
      lastError: null,
    })
    .run();
  return id;
}

const EVT: OutboundEvent = {
  event: 'execution.finished',
  bot_id: 'bot-1',
  flow_id: 'flow-1',
  execution_id: 'exec-1',
  chat_id: 555,
  at: '2026-06-14T00:00:00.000Z',
  data: { status: 'done' },
};

describe('WebhookDispatcher (P4-T4)', () => {
  let db: Db;
  beforeEach(() => {
    const opened = openDb(':memory:');
    db = opened.db;
    runMigrations(db);
  });

  it('fans out to every ACTIVE matching subscription; skips inactive + non-subscribed', async () => {
    const { hits, fetchImpl } = recordingFetch(() => 200);
    seedWebhook(db, { url: 'https://a.test/hook', events: ['execution.finished'] });
    seedWebhook(db, { url: 'https://b.test/hook', events: ['execution.finished', 'user.first_seen'] });
    seedWebhook(db, { url: 'https://inactive.test', events: ['execution.finished'], active: false });
    seedWebhook(db, { url: 'https://other-event.test', events: ['user.first_seen'] });

    const d = new WebhookDispatcher({ db, fetchImpl, backoffMs: 0 });
    d.dispatch(EVT);
    await d.drain();

    const urls = hits.map((h) => h.url).sort();
    expect(urls).toEqual(['https://a.test/hook', 'https://b.test/hook']);
    // The envelope is delivered verbatim.
    expect(JSON.parse(hits[0]!.body)).toEqual(EVT);
    expect(hits[0]!.headers['x-ctb-event']).toBe('execution.finished');
  });

  it('a bot-scoped subscription only fires for its own bot', async () => {
    const { hits, fetchImpl } = recordingFetch(() => 200);
    seedBot(db, 'bot-1');
    seedBot(db, 'bot-2');
    seedWebhook(db, { url: 'https://mine.test', events: ['execution.finished'], botId: 'bot-1' });
    seedWebhook(db, { url: 'https://theirs.test', events: ['execution.finished'], botId: 'bot-2' });
    seedWebhook(db, { url: 'https://all.test', events: ['execution.finished'] }); // instance-wide

    const d = new WebhookDispatcher({ db, fetchImpl, backoffMs: 0 });
    d.dispatch(EVT); // bot_id = bot-1
    await d.drain();

    expect(hits.map((h) => h.url).sort()).toEqual(['https://all.test', 'https://mine.test']);
  });

  it('signs the body with HMAC-SHA256 when a secret is set', async () => {
    const { hits, fetchImpl } = recordingFetch(() => 200);
    seedWebhook(db, { url: 'https://signed.test', events: ['execution.finished'], secret: 's3cr3t' });

    const d = new WebhookDispatcher({ db, fetchImpl, backoffMs: 0 });
    d.dispatch(EVT);
    await d.drain();

    const expected = 'sha256=' + createHmac('sha256', 's3cr3t').update(hits[0]!.body).digest('hex');
    expect(hits[0]!.headers['x-ctb-signature']).toBe(expected);
  });

  it('retries on 5xx then stamps last_error; records last_fired_at', async () => {
    // Always 500 → exhausts attempts.
    const { hits, fetchImpl } = recordingFetch(() => 500);
    const id = seedWebhook(db, { url: 'https://flaky.test', events: ['execution.finished'] });

    const d = new WebhookDispatcher({ db, fetchImpl, backoffMs: 0, maxAttempts: 3 });
    d.dispatch(EVT);
    await d.drain();

    expect(hits.length).toBe(3); // first + 2 retries
    const row = db.select().from(schema.instanceWebhooks).where(eq(schema.instanceWebhooks.id, id)).get()!;
    expect(row.lastError).toContain('HTTP 500');
    expect(row.lastFiredAt).not.toBeNull();
  });

  it('recovers when a retry succeeds; clears last_error', async () => {
    // 503 on the 1st call, 200 on the 2nd.
    const { hits, fetchImpl } = recordingFetch((_u, n) => (n === 1 ? 503 : 200));
    const id = seedWebhook(db, { url: 'https://recovers.test', events: ['execution.finished'] });

    const d = new WebhookDispatcher({ db, fetchImpl, backoffMs: 0, maxAttempts: 3 });
    d.dispatch(EVT);
    await d.drain();

    expect(hits.length).toBe(2);
    const row = db.select().from(schema.instanceWebhooks).where(eq(schema.instanceWebhooks.id, id)).get()!;
    expect(row.lastError).toBeNull();
  });

  it('does NOT retry a 4xx (the request is bad, not transient)', async () => {
    const { hits, fetchImpl } = recordingFetch(() => 400);
    seedWebhook(db, { url: 'https://bad.test', events: ['execution.finished'] });

    const d = new WebhookDispatcher({ db, fetchImpl, backoffMs: 0, maxAttempts: 3 });
    d.dispatch(EVT);
    await d.drain();

    expect(hits.length).toBe(1);
  });
});

// --------------------------------------------------------------------------
// End-to-end through the app: CRUD + the two real event sources.
// --------------------------------------------------------------------------
interface World {
  app: FastifyInstance;
  db: Db;
  engine: Engine;
  cookie: { [k: string]: string };
  hits: Hit[];
}

async function makeWorld(): Promise<World> {
  const env = loadEnv({ CTB_SECRET: SECRET, CTB_ADMIN_PASS: 'hunter2hunter2', NODE_ENV: 'test' } as NodeJS.ProcessEnv);
  const { db } = openDb(':memory:');
  runMigrations(db);
  const { hits, fetchImpl } = recordingFetch(() => 200);
  const engine = wireEngine({ db, ctbSecret: SECRET, fetchImpl });
  const app = buildApp({
    env, db, engine, logger: false, editorDistDir: '/nonexistent',
    botRegisterOpts: () => ({
      botInfo: BOT_INFO,
      callApi: async () => ({ message_id: 1 }),
    }),
  });
  const login = await app.inject({
    method: 'POST', url: '/api/auth/login',
    payload: { username: 'admin', password: 'hunter2hunter2' },
  });
  const cookie = { [SESSION_COOKIE]: login.cookies.find((c) => c.name === SESSION_COOKIE)!.value };
  return { app, db, engine, cookie, hits };
}

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

async function createBot(w: World, name = 'b'): Promise<string> {
  const { bot } = (await w.app.inject({
    method: 'POST', url: '/api/bots', cookies: w.cookie, payload: { name, token: TOKEN },
  })).json() as { bot: { id: string } };
  return bot.id;
}

async function createFlow(w: World, botId: string, graph: FlowGraph): Promise<string> {
  const { flow } = (await w.app.inject({
    method: 'POST', url: '/api/flows', cookies: w.cookie, payload: { botId, name: 'wh flow', graph },
  })).json() as { flow: { id: string } };
  return flow.id;
}

describe('instance-webhooks CRUD (P4-T4)', () => {
  let w: World;
  beforeEach(async () => { w = await makeWorld(); });
  afterEach(async () => { await w.engine.gateway.stopAll(); await w.app.close(); });

  it('requires the panel session (401 without cookie)', async () => {
    const res = await w.app.inject({ method: 'GET', url: '/api/instance-webhooks' });
    expect(res.statusCode).toBe(401);
  });

  it('create never returns the secret — only hasSecret; list hides it too', async () => {
    const res = await w.app.inject({
      method: 'POST', url: '/api/instance-webhooks', cookies: w.cookie,
      payload: { name: 'n8n', url: 'https://n8n.test/hook', secret: 'topsecret', events: ['execution.finished'] },
    });
    expect(res.statusCode).toBe(201);
    const { webhook } = res.json() as { webhook: InstanceWebhookPublic };
    expect(webhook.hasSecret).toBe(true);
    expect(JSON.stringify(webhook)).not.toContain('topsecret');

    const list = (await w.app.inject({ method: 'GET', url: '/api/instance-webhooks', cookies: w.cookie })).json() as {
      webhooks: InstanceWebhookPublic[];
    };
    expect(list.webhooks).toHaveLength(1);
    expect(JSON.stringify(list.webhooks)).not.toContain('topsecret');
  });

  it('rejects an empty events array and an unknown bot scope', async () => {
    const noEvents = await w.app.inject({
      method: 'POST', url: '/api/instance-webhooks', cookies: w.cookie,
      payload: { name: 'x', url: 'https://x.test', events: [] },
    });
    expect(noEvents.statusCode).toBe(400);

    const badBot = await w.app.inject({
      method: 'POST', url: '/api/instance-webhooks', cookies: w.cookie,
      payload: { name: 'x', url: 'https://x.test', events: ['execution.finished'], botId: 'nope' },
    });
    expect(badBot.statusCode).toBe(400);
    expect((badBot.json() as { error: string }).error).toBe('unknown_bot');
  });

  it('PATCH toggles active + edits events; DELETE removes', async () => {
    const created = (await w.app.inject({
      method: 'POST', url: '/api/instance-webhooks', cookies: w.cookie,
      payload: { name: 'n', url: 'https://n.test', events: ['execution.finished'] },
    })).json() as { webhook: InstanceWebhookPublic };

    const patched = (await w.app.inject({
      method: 'PATCH', url: `/api/instance-webhooks/${created.webhook.id}`, cookies: w.cookie,
      payload: { active: false, events: ['user.first_seen'] },
    })).json() as { webhook: InstanceWebhookPublic };
    expect(patched.webhook.active).toBe(false);
    expect(patched.webhook.events).toEqual(['user.first_seen']);

    const del = await w.app.inject({
      method: 'DELETE', url: `/api/instance-webhooks/${created.webhook.id}`, cookies: w.cookie,
    });
    expect(del.statusCode).toBe(200);
    const list = (await w.app.inject({ method: 'GET', url: '/api/instance-webhooks', cookies: w.cookie })).json() as {
      webhooks: InstanceWebhookPublic[];
    };
    expect(list.webhooks).toHaveLength(0);
  });

  it('PATCH on an unknown id → 404', async () => {
    const res = await w.app.inject({
      method: 'PATCH', url: '/api/instance-webhooks/nope', cookies: w.cookie, payload: { active: false },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('instance-webhooks event sources (P4-T4)', () => {
  let w: World;
  beforeEach(async () => { w = await makeWorld(); });
  afterEach(async () => { await w.engine.gateway.stopAll(); await w.app.close(); });

  it('a finished execution fires execution.finished to a subscriber', async () => {
    const botId = await createBot(w);
    const graph = triggerGraph();
    const flowId = await createFlow(w, botId, graph);
    seedWebhook(w.db, { url: 'https://exec.test/hook', events: ['execution.finished'] });

    // Run the flow to completion directly through the executor.
    await w.engine.executor.start({
      executionId: 'e2e-exec-1',
      flow: { id: flowId, name: 'f' },
      graph,
      botId,
      chatId: null,
      userId: null,
      entry: { nodeId: 'trig', items: { main: [{ json: {} }] } },
    });
    await w.engine.webhookDispatcher.drain();

    const fired = w.hits.filter((h) => h.url === 'https://exec.test/hook');
    expect(fired).toHaveLength(1);
    const evt = JSON.parse(fired[0]!.body) as OutboundEvent;
    expect(evt.event).toBe('execution.finished');
    expect(evt.bot_id).toBe(botId);
    expect(evt.execution_id).toBe('e2e-exec-1');
    expect(evt.data.status).toBe('done');
  });

  it('a brand-new user fires user.first_seen exactly once', async () => {
    const botId = await createBot(w);
    seedWebhook(w.db, { url: 'https://user.test/hook', events: ['user.first_seen'] });

    // Touch the SAME user twice — only the first insert is "first seen".
    w.engine.userStore.touch(botId, 9001, { firstName: 'Neo' });
    w.engine.userStore.touch(botId, 9001, { firstName: 'Neo' });
    await w.engine.webhookDispatcher.drain();

    const fired = w.hits.filter((h) => h.url === 'https://user.test/hook');
    expect(fired).toHaveLength(1);
    const evt = JSON.parse(fired[0]!.body) as OutboundEvent;
    expect(evt.event).toBe('user.first_seen');
    expect(evt.bot_id).toBe(botId);
    expect(evt.chat_id).toBe(9001);
    expect((evt.data as { tg_user_id: number }).tg_user_id).toBe(9001);
  });
});
