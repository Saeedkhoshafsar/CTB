/**
 * L-T1 (PLAN4 Phase L) — the GET /api/setup/checklist route.
 *
 * Gathers the real facts (bot/active-flow counts from the DB, owner/admin
 * counts from the admin store, env) and returns the PURE model's output. These
 * tests exercise the wiring + the permission gate end to end on an in-memory DB:
 *   • an operator can't read the checklist (admin+ guard);
 *   • a fresh instance is not ready and lists the owner/bot/activeFlow gaps;
 *   • adding an owner + a bot + an active flow clears those items;
 *   • the recommended `admins` item is open but doesn't block readiness.
 */
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SESSION_COOKIE, buildApp } from '../src/app';
import { openDb, type Db } from '../src/db/index';
import { bots, flows } from '../src/db/schema';
import { runMigrations } from '../src/db/migrate';
import { SqlitePanelAdminStore } from '../src/engine/admin-store';
import { loadEnv } from '../src/lib/env';
import { createSessionToken } from '../src/lib/session';

const SECRET = 'devsecret0123456';

interface World {
  app: FastifyInstance;
  db: Db;
}

function makeWorld(extraEnv: Record<string, string> = {}): World {
  const env = loadEnv({
    CTB_SECRET: SECRET,
    CTB_ADMIN_USER: 'admin',
    CTB_ADMIN_PASS: 'hunter2hunter2',
    NODE_ENV: 'test',
    ...extraEnv,
  } as NodeJS.ProcessEnv);
  const { db } = openDb(':memory:');
  runMigrations(db);
  const app = buildApp({ env, db, logger: false, editorDistDir: '/nonexistent' });
  return { app, db };
}

function cookieFor(role: 'owner' | 'admin' | 'operator', tg?: string): Record<string, string> {
  return { [SESSION_COOKIE]: createSessionToken('u', SECRET, role, Date.now(), tg) };
}

async function getChecklist(app: FastifyInstance, cookies: Record<string, string>) {
  return app.inject({ method: 'GET', url: '/api/setup/checklist', cookies });
}

const NOW = '2026-01-01T00:00:00.000Z';

/** Insert a bot row directly (the checklist only counts rows). */
function addBot(db: Db, id: string): void {
  db.insert(bots)
    .values({ id, name: id, tokenEnc: 'x', status: 'active', createdAt: NOW, updatedAt: NOW })
    .run();
}

/** Insert a flow row directly with a chosen status. */
function addFlow(db: Db, id: string, botId: string, status: 'draft' | 'active'): void {
  db.insert(flows)
    .values({ id, botId, name: id, status, graph: { nodes: [], edges: [] }, updatedAt: NOW })
    .run();
}

describe('GET /api/setup/checklist (L-T1)', () => {
  let w: World;
  beforeEach(() => {
    w = makeWorld();
  });
  afterEach(async () => {
    await w.app.close();
  });

  it('403s an operator (admin+ guard)', async () => {
    const res = await getChecklist(w.app, cookieFor('operator'));
    expect(res.statusCode).toBe(403);
  });

  it('401s an anonymous caller', async () => {
    const res = await getChecklist(w.app, {});
    expect(res.statusCode).toBe(401);
  });

  it('a fresh instance is not ready and lists owner/bot/activeFlow/admins gaps', async () => {
    const res = await getChecklist(w.app, cookieFor('admin'));
    expect(res.statusCode).toBe(200);
    const body = res.json() as { items: { id: string; optional: boolean }[]; ready: boolean };
    const ids = body.items.map((i) => i.id);
    // CTB_SECRET is set (env requires ≥16 chars) → 'secret' is satisfied.
    expect(ids).not.toContain('secret');
    expect(ids).toEqual(expect.arrayContaining(['owner', 'bot', 'activeFlow', 'admins']));
    expect(body.ready).toBe(false);
  });

  it('clears bot + delivery once a bot is registered (polling fallback)', async () => {
    addBot(w.db, 'b1');
    const res = await getChecklist(w.app, cookieFor('admin'));
    const ids = (res.json() as { items: { id: string }[] }).items.map((i) => i.id);
    expect(ids).not.toContain('bot');
    // A registered bot has a delivery path (polling), so delivery clears too.
    expect(ids).not.toContain('delivery');
  });

  it('clears activeFlow only when a flow is ACTIVE (a draft does not count)', async () => {
    addBot(w.db, 'b1');
    addFlow(w.db, 'f1', 'b1', 'draft');
    let ids = ((await getChecklist(w.app, cookieFor('admin'))).json() as { items: { id: string }[] })
      .items.map((i) => i.id);
    expect(ids).toContain('activeFlow');

    addFlow(w.db, 'f2', 'b1', 'active');
    ids = ((await getChecklist(w.app, cookieFor('admin'))).json() as { items: { id: string }[] })
      .items.map((i) => i.id);
    expect(ids).not.toContain('activeFlow');
  });

  it('is ready (admins-only open) once owner + bot + active flow exist', async () => {
    // Bootstrap an owner via the store, add a bot + an active flow.
    const store = new SqlitePanelAdminStore(w.db);
    store.bootstrapOwner('100', 'admin');
    addBot(w.db, 'b1');
    addFlow(w.db, 'f1', 'b1', 'active');

    const res = await getChecklist(w.app, cookieFor('admin'));
    const body = res.json() as { items: { id: string; optional: boolean }[]; ready: boolean };
    expect(body.items.map((i) => i.id)).toEqual(['admins']);
    expect(body.items[0]?.optional).toBe(true);
    expect(body.ready).toBe(true); // recommended-only item doesn't block

    // Adding a non-owner admin clears the last item entirely.
    store.add('200', 'admin', 'Second');
    const res2 = await getChecklist(w.app, cookieFor('admin'));
    const body2 = res2.json() as { items: unknown[]; ready: boolean };
    expect(body2.items).toEqual([]);
    expect(body2.ready).toBe(true);
  });
});
