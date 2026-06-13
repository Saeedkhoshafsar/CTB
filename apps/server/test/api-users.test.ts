/**
 * P3-T5 — Users page backend: the `users` table (until now defined but never
 * written), the router's per-update upsert, the data.userProfile ctx.users
 * capability, and the Users REST API — all over a real in-memory SQLite DB and
 * a fully wired engine (fake Telegram transport, no network).
 *
 * Covers: router upsert (first_seen/last_seen + mirrored TG identity), the
 * Users API (auth guard, botId-scoped list, get, PATCH tags & profile,
 * validation), and an end-to-end data.userProfile run that tags the live user.
 */
import { FlowGraphSchema, type FlowGraph } from '@ctb/shared';
import type { Update, UserFromGetMe } from 'grammy/types';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SESSION_COOKIE, buildApp } from '../src/app';
import { openDb, type Db } from '../src/db/index';
import * as schema from '../src/db/schema';
import { runMigrations } from '../src/db/migrate';
import { wireEngine, type Engine } from '../src/engine/wire';
import { encrypt, deriveKey } from '../src/lib/crypto';
import { loadEnv } from '../src/lib/env';

const SECRET = 'devsecret0123456';
const TOKEN = '123456789:AAEexampletokenexampletokenexample';
const BOT_INFO: UserFromGetMe = {
  id: 42, is_bot: true, first_name: 'DemoBot', username: 'demo_bot',
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
  const env = loadEnv({
    CTB_SECRET: SECRET, CTB_ADMIN_PASS: 'hunter2hunter2', NODE_ENV: 'test',
  } as NodeJS.ProcessEnv);
  const { db } = openDb(':memory:');
  runMigrations(db);
  const engine = wireEngine({ db, ctbSecret: SECRET });
  const now = new Date().toISOString();
  db.insert(schema.bots).values({
    id: 'demo-bot', name: 'Demo', tokenEnc: encrypt(TOKEN, deriveKey(SECRET)),
    mode: 'polling', status: 'active', settings: {}, createdAt: now, updatedAt: now,
  }).run();
  engine.gateway.registerBot('demo-bot', TOKEN, {
    botInfo: BOT_INFO,
    callApi: async () => ({ message_id: 1 }),
  });
  const app = buildApp({ env, db, engine, logger: false, editorDistDir: '/nonexistent' });
  const login = await app.inject({
    method: 'POST', url: '/api/auth/login',
    payload: { username: 'admin', password: 'hunter2hunter2' },
  });
  const cookie = { [SESSION_COOKIE]: login.cookies.find((c) => c.name === SESSION_COOKIE)!.value };
  return { app, db, engine, cookie };
}

let updateId = 0;
function tgUpdate(text: string, user: { id: number; first_name: string; last_name?: string; username?: string }): Update {
  updateId += 1;
  return {
    update_id: updateId,
    message: {
      message_id: updateId * 10,
      date: 0,
      from: { is_bot: false, ...user },
      chat: { id: user.id, type: 'private', first_name: user.first_name },
      text,
    },
  } as unknown as Update;
}

/** A minimal active flow: tg.trigger(/tagme) → data.userProfile(add_tags) → end. */
function tagFlow(): FlowGraph {
  return FlowGraphSchema.parse({
    nodes: [
      { id: 'trig', type: 'tg.trigger', params: { event: 'command', command: 'tagme' }, position: { x: 0, y: 0 } },
      {
        id: 'tag',
        type: 'data.userProfile',
        params: { op: 'add_tags', tags: ['onboarded'] },
        position: { x: 200, y: 0 },
      },
    ],
    edges: [{ id: 'e1', from: { node: 'trig', port: 'main' }, to: { node: 'tag', port: 'main' } }],
  });
}

describe('users API + upsert (P3-T5)', () => {
  let w: World;
  beforeEach(async () => { w = await makeWorld(); });
  afterEach(async () => { await w.engine.gateway.stopAll(); await w.app.close(); });

  it('requires auth (401 without cookie)', async () => {
    const res = await w.app.inject({ method: 'GET', url: '/api/users?botId=demo-bot' });
    expect(res.statusCode).toBe(401);
  });

  it('list requires botId (400)', async () => {
    const res = await w.app.inject({ method: 'GET', url: '/api/users', cookies: w.cookie });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('botId_required');
  });

  it('router upserts a user on first update; bumps last_seen + mirrors identity', async () => {
    await w.engine.gateway.dispatch('demo-bot', tgUpdate('سلام', { id: 900, first_name: 'علی', username: 'ali_g' }));
    const rows1 = w.db.select().from(schema.users).all();
    expect(rows1).toHaveLength(1);
    const u = rows1[0]!;
    expect(u.tgUserId).toBe(900);
    expect((u.profile as Record<string, unknown>).first_name).toBe('علی');
    expect((u.profile as Record<string, unknown>).username).toBe('ali_g');
    const firstSeen = u.firstSeen;

    // Second update from the SAME user → still one row, last_seen advances.
    await new Promise((r) => setTimeout(r, 5));
    await w.engine.gateway.dispatch('demo-bot', tgUpdate('باز هم', { id: 900, first_name: 'علی رضا' }));
    const rows2 = w.db.select().from(schema.users).all();
    expect(rows2).toHaveLength(1);
    expect(rows2[0]!.firstSeen).toBe(firstSeen); // unchanged
    expect((rows2[0]!.profile as Record<string, unknown>).first_name).toBe('علی رضا'); // re-mirrored
  });

  it('lists users newest-seen first, scoped by bot, with a display name', async () => {
    await w.engine.gateway.dispatch('demo-bot', tgUpdate('a', { id: 100, first_name: 'Ann' }));
    await new Promise((r) => setTimeout(r, 5));
    await w.engine.gateway.dispatch('demo-bot', tgUpdate('b', { id: 200, first_name: 'Bob' }));

    const res = await w.app.inject({ method: 'GET', url: '/api/users?botId=demo-bot', cookies: w.cookie });
    expect(res.statusCode).toBe(200);
    const { users } = res.json();
    expect(users.map((u: { tgUserId: number }) => u.tgUserId)).toEqual([200, 100]); // newest first
    expect(users[0].displayName).toBe('Bob');
    // A different bot has none of these users.
    const other = await w.app.inject({ method: 'GET', url: '/api/users?botId=other', cookies: w.cookie });
    expect(other.json().users).toHaveLength(0);
  });

  it('GET /:id reads one; 404 when missing', async () => {
    await w.engine.gateway.dispatch('demo-bot', tgUpdate('a', { id: 100, first_name: 'Ann' }));
    const list = await w.app.inject({ method: 'GET', url: '/api/users?botId=demo-bot', cookies: w.cookie });
    const id = list.json().users[0].id;
    const res = await w.app.inject({ method: 'GET', url: `/api/users/${id}`, cookies: w.cookie });
    expect(res.statusCode).toBe(200);
    expect(res.json().user.tgUserId).toBe(100);
    const miss = await w.app.inject({ method: 'GET', url: '/api/users/nope', cookies: w.cookie });
    expect(miss.statusCode).toBe(404);
  });

  it('PATCH edits tags and profile; rejects an empty body (400)', async () => {
    await w.engine.gateway.dispatch('demo-bot', tgUpdate('a', { id: 100, first_name: 'Ann' }));
    const list = await w.app.inject({ method: 'GET', url: '/api/users?botId=demo-bot', cookies: w.cookie });
    const id = list.json().users[0].id;

    const patch = await w.app.inject({
      method: 'PATCH', url: `/api/users/${id}`, cookies: w.cookie,
      payload: { tags: ['vip', 'beta'], profile: { note: 'great customer' } },
    });
    expect(patch.statusCode).toBe(200);
    expect(patch.json().user.tags).toEqual(['vip', 'beta']);
    expect(patch.json().user.profile.note).toBe('great customer');

    const empty = await w.app.inject({
      method: 'PATCH', url: `/api/users/${id}`, cookies: w.cookie, payload: {},
    });
    expect(empty.statusCode).toBe(400);
  });

  it('end-to-end: data.userProfile tags the live conversation user', async () => {
    const now = new Date().toISOString();
    w.db.insert(schema.flows).values({
      id: 'tag-flow', botId: 'demo-bot', name: 'Tag', status: 'active',
      graph: tagFlow(), version: 1, updatedAt: now,
    }).run();

    await w.engine.gateway.dispatch('demo-bot', tgUpdate('/tagme', { id: 555, first_name: 'Sara' }));

    const list = await w.app.inject({ method: 'GET', url: '/api/users?botId=demo-bot', cookies: w.cookie });
    const sara = list.json().users.find((u: { tgUserId: number }) => u.tgUserId === 555);
    expect(sara.tags).toEqual(['onboarded']);
  });
});
