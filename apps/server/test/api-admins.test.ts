/**
 * K-T2 (PLAN4 Phase K) — Telegram-ID login bootstrap + the panel-admin
 * management REST API permission matrix.
 *
 * Covers every acceptance criterion:
 *   • empty table + env creds + CTB_OWNER_TG_ID → first login mints the OWNER row
 *     and the session is bound to that Telegram id (role:'owner');
 *   • a second login no longer bootstraps (owner already exists) but the
 *     configured account keeps its owner role;
 *   • an operator session can reach NEITHER the Admins list nor any mutation;
 *   • an admin can add/remove/setRole another admin but NOT the owner;
 *   • only the owner can transfer ownership, and the transfer demotes the
 *     caller to admin (store-enforced; this asserts the route wiring).
 */
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SESSION_COOKIE, buildApp } from '../src/app';
import { openDb, type Db } from '../src/db/index';
import { runMigrations } from '../src/db/migrate';
import { loadEnv } from '../src/lib/env';
import { createSessionToken } from '../src/lib/session';

const SECRET = 'devsecret0123456';
const OWNER_TG = '100';

interface World {
  app: FastifyInstance;
  db: Db;
}

function makeWorld(extraEnv: Record<string, string> = {}): World {
  const env = loadEnv({
    CTB_SECRET: SECRET,
    CTB_ADMIN_USER: 'admin',
    CTB_ADMIN_PASS: 'hunter2hunter2',
    CTB_OPERATOR_PASS: 'managerpass99',
    CTB_OWNER_TG_ID: OWNER_TG,
    NODE_ENV: 'test',
    ...extraEnv,
  } as NodeJS.ProcessEnv);
  const { db } = openDb(':memory:');
  runMigrations(db);
  const app = buildApp({ env, db, logger: false, editorDistDir: '/nonexistent' });
  return { app, db };
}

/** A signed cookie for an arbitrary role/identity (used to exercise guards). */
function cookieFor(role: 'owner' | 'admin' | 'operator', tg?: string): Record<string, string> {
  return { [SESSION_COOKIE]: createSessionToken('u', SECRET, role, Date.now(), tg) };
}

async function loginAdmin(app: FastifyInstance): Promise<Record<string, string>> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username: 'admin', password: 'hunter2hunter2' },
  });
  return { [SESSION_COOKIE]: res.cookies.find((c) => c.name === SESSION_COOKIE)!.value };
}

describe('K-T2 — Telegram-ID login bootstrap + admins API', () => {
  let w: World;
  beforeEach(() => {
    w = makeWorld();
  });
  afterEach(async () => {
    await w.app.close();
  });

  it('first admin login on an empty table bootstraps the OWNER row', async () => {
    const res = await w.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'admin', password: 'hunter2hunter2' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, user: { username: 'admin', role: 'owner', tgUserId: OWNER_TG } });

    // The owner row is now durable.
    const me = await w.app.inject({
      method: 'GET',
      url: '/api/auth/me',
      cookies: { [SESSION_COOKIE]: res.cookies.find((c) => c.name === SESSION_COOKIE)!.value },
    });
    expect(me.json()).toEqual({ user: { username: 'admin', role: 'owner', tgUserId: OWNER_TG } });
  });

  it('a second login does not mint a second owner; configured account stays owner', async () => {
    await loginAdmin(w.app); // bootstrap
    const again = await w.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'admin', password: 'hunter2hunter2' },
    });
    expect(again.json()).toMatchObject({ user: { role: 'owner', tgUserId: OWNER_TG } });

    const list = await w.app.inject({
      method: 'GET',
      url: '/api/admins',
      cookies: { [SESSION_COOKIE]: again.cookies.find((c) => c.name === SESSION_COOKIE)!.value },
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().admins).toHaveLength(1);
    expect(list.json().admins[0]).toMatchObject({ tgUserId: OWNER_TG, role: 'owner' });
  });

  it('without CTB_OWNER_TG_ID, env login stays a plain admin (back-compat)', async () => {
    const env = loadEnv({
      CTB_SECRET: SECRET,
      CTB_ADMIN_USER: 'admin',
      CTB_ADMIN_PASS: 'hunter2hunter2',
      NODE_ENV: 'test',
    } as NodeJS.ProcessEnv);
    const { db } = openDb(':memory:');
    runMigrations(db);
    const w2: World = { app: buildApp({ env, db, logger: false, editorDistDir: '/nonexistent' }), db };
    const res = await w2.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'admin', password: 'hunter2hunter2' },
    });
    expect(res.json()).toEqual({ ok: true, user: { username: 'admin', role: 'admin' } });
    const list = await w2.app.inject({
      method: 'GET',
      url: '/api/admins',
      cookies: { [SESSION_COOKIE]: res.cookies.find((c) => c.name === SESSION_COOKIE)!.value },
    });
    expect(list.json().admins).toHaveLength(0);
    await w2.app.close();
  });

  it('operator is forbidden from the Admins list and any mutation', async () => {
    const operator = cookieFor('operator');
    const list = await w.app.inject({ method: 'GET', url: '/api/admins', cookies: operator });
    expect(list.statusCode).toBe(403);
    const add = await w.app.inject({
      method: 'POST',
      url: '/api/admins',
      cookies: operator,
      payload: { tgUserId: '200', role: 'admin', label: 'X' },
    });
    expect(add.statusCode).toBe(403);
  });

  it('admin can add / list / setRole / remove another admin', async () => {
    const admin = cookieFor('admin');
    const add = await w.app.inject({
      method: 'POST',
      url: '/api/admins',
      cookies: admin,
      payload: { tgUserId: '200', role: 'admin', label: 'Sara' },
    });
    expect(add.statusCode).toBe(201);
    expect(add.json().admin).toMatchObject({ tgUserId: '200', role: 'admin', label: 'Sara' });

    const list = await w.app.inject({ method: 'GET', url: '/api/admins', cookies: admin });
    expect(list.json().admins).toHaveLength(1);

    const setRole = await w.app.inject({
      method: 'PATCH',
      url: '/api/admins/200/role',
      cookies: admin,
      payload: { role: 'operator' },
    });
    expect(setRole.statusCode).toBe(200);
    expect(setRole.json().admin.role).toBe('operator');

    const del = await w.app.inject({ method: 'DELETE', url: '/api/admins/200', cookies: admin });
    expect(del.statusCode).toBe(200);
    expect(del.json()).toEqual({ ok: true });
  });

  it('the owner cannot be removed nor demoted via the admin routes', async () => {
    await loginAdmin(w.app); // owner row = OWNER_TG
    const admin = cookieFor('admin');

    const del = await w.app.inject({ method: 'DELETE', url: `/api/admins/${OWNER_TG}`, cookies: admin });
    expect(del.statusCode).toBe(409);
    expect(del.json().error).toBe('owner_immutable');

    const setRole = await w.app.inject({
      method: 'PATCH',
      url: `/api/admins/${OWNER_TG}/role`,
      cookies: admin,
      payload: { role: 'operator' },
    });
    expect(setRole.statusCode).toBe(409);
    expect(setRole.json().error).toBe('owner_immutable');
  });

  it('only the owner can transfer ownership; transfer demotes the caller to admin', async () => {
    await loginAdmin(w.app); // owner = OWNER_TG, bound to its tg in the owner session
    const admin = cookieFor('admin', '999');

    // Add a target admin first (via admin session).
    await w.app.inject({
      method: 'POST',
      url: '/api/admins',
      cookies: admin,
      payload: { tgUserId: '200', role: 'admin', label: 'Sara' },
    });

    // A non-owner (admin role) cannot reach transfer-owner at all (403, guard).
    const denied = await w.app.inject({
      method: 'POST',
      url: '/api/admins/transfer-owner',
      cookies: admin,
      payload: { tgUserId: '200' },
    });
    expect(denied.statusCode).toBe(403);

    // The owner transfers to 200; the store demotes the old owner to admin.
    const owner = cookieFor('owner', OWNER_TG);
    const ok = await w.app.inject({
      method: 'POST',
      url: '/api/admins/transfer-owner',
      cookies: owner,
      payload: { tgUserId: '200' },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().owner).toMatchObject({ tgUserId: '200', role: 'owner' });
    expect(ok.json().previous).toMatchObject({ tgUserId: OWNER_TG, role: 'admin' });
  });

  it('an owner-role session without a Telegram identity cannot transfer', async () => {
    await loginAdmin(w.app);
    const ownerNoTg = cookieFor('owner'); // no tg claim
    const res = await w.app.inject({
      method: 'POST',
      url: '/api/admins/transfer-owner',
      cookies: ownerNoTg,
      payload: { tgUserId: '200' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('not_owner');
  });

  it('adding a duplicate Telegram id is a 409 conflict', async () => {
    const admin = cookieFor('admin');
    await w.app.inject({
      method: 'POST',
      url: '/api/admins',
      cookies: admin,
      payload: { tgUserId: '200', role: 'admin', label: 'A' },
    });
    const dup = await w.app.inject({
      method: 'POST',
      url: '/api/admins',
      cookies: admin,
      payload: { tgUserId: '200', role: 'admin', label: 'B' },
    });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error).toBe('already_exists');
  });

  it('a malformed Telegram id is rejected with 400', async () => {
    const admin = cookieFor('admin');
    const res = await w.app.inject({
      method: 'POST',
      url: '/api/admins',
      cookies: admin,
      payload: { tgUserId: 'not-a-number', role: 'admin', label: 'X' },
    });
    expect(res.statusCode).toBe(400);
  });
});
