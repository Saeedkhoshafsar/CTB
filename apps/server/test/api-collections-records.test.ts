/**
 * P3.5-T2 — Collections + Records REST API and the operator role.
 *
 * Covers every acceptance criterion:
 *   • operator can CRUD records but gets 403 on /api/bots, /api/flows
 *   • admin can do both (define collections AND CRUD records)
 *   • uploaded image is retrievable
 *   • filter query parity with the store (where/sort/limit/operators)
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SESSION_COOKIE, buildApp } from '../src/app';
import { openDb, type Db } from '../src/db/index';
import { bots as botsTable } from '../src/db/schema';
import { runMigrations } from '../src/db/migrate';
import { wireEngine, type Engine } from '../src/engine/wire';
import { loadEnv } from '../src/lib/env';

const SECRET = 'devsecret0123456';
const BOT = 'bot1';

interface World {
  app: FastifyInstance;
  db: Db;
  engine: Engine;
  adminCookie: Record<string, string>;
  operatorCookie: Record<string, string>;
}

async function login(app: FastifyInstance, username: string, password: string): Promise<Record<string, string>> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password } });
  expect(res.statusCode).toBe(200);
  return { [SESSION_COOKIE]: res.cookies.find((c) => c.name === SESSION_COOKIE)!.value };
}

async function makeWorld(): Promise<World> {
  const dataDir = mkdtempSync(join(tmpdir(), 'ctb-files-'));
  const env = loadEnv({
    CTB_SECRET: SECRET,
    CTB_ADMIN_PASS: 'hunter2hunter2',
    CTB_OPERATOR_PASS: 'managerpass99',
    CTB_DATA_DIR: dataDir,
    NODE_ENV: 'test',
  } as NodeJS.ProcessEnv);
  const { db, sqlite } = openDb(':memory:');
  runMigrations(db);
  const now = new Date().toISOString();
  db.insert(botsTable).values({ id: BOT, name: 'b', tokenEnc: 'enc.x.y', createdAt: now, updatedAt: now }).run();
  const engine = wireEngine({ db, ctbSecret: SECRET });
  const app = buildApp({ env, db, sqlite, engine, logger: false, editorDistDir: '/nonexistent' });
  const adminCookie = await login(app, 'admin', 'hunter2hunter2');
  const operatorCookie = await login(app, 'operator', 'managerpass99');
  return { app, db, engine, adminCookie, operatorCookie };
}

const productsSchema = {
  fields: [
    { key: 'title', type: 'text', required: true, indexed: true },
    { key: 'price', type: 'number', indexed: true },
    { key: 'status', type: 'select', options: [{ value: 'draft' }, { value: 'published' }], default: 'draft' },
    {
      key: 'variants',
      type: 'group',
      fields: [
        { key: 'color', type: 'select', options: [{ value: 'red' }, { value: 'blue' }] },
        { key: 'stock', type: 'number', default: 0 },
      ],
    },
  ],
};

async function defineProducts(w: World): Promise<string> {
  const res = await w.app.inject({
    method: 'POST',
    url: `/api/collections?botId=${BOT}`,
    cookies: w.adminCookie,
    payload: { slug: 'products', name: 'Products', schema: productsSchema },
  });
  expect(res.statusCode).toBe(201);
  return res.json().collection.id as string;
}

describe('auth & roles (P3.5-T2)', () => {
  let w: World;
  beforeEach(async () => { w = await makeWorld(); });
  afterEach(async () => { await w.engine.gateway.stopAll(); await w.app.close(); });

  it('login returns the role for admin and operator', async () => {
    const me = await w.app.inject({ method: 'GET', url: '/api/auth/me', cookies: w.adminCookie });
    expect(me.json().user.role).toBe('admin');
    const meOp = await w.app.inject({ method: 'GET', url: '/api/auth/me', cookies: w.operatorCookie });
    expect(meOp.json().user.role).toBe('operator');
  });

  it('operator gets 403 on /api/bots and /api/flows and /api/collections', async () => {
    for (const url of ['/api/bots', '/api/flows', `/api/collections?botId=${BOT}`]) {
      const res = await w.app.inject({ method: 'GET', url, cookies: w.operatorCookie });
      expect(res.statusCode, url).toBe(403);
    }
  });

  it('admin can reach /api/bots and /api/collections', async () => {
    const bots = await w.app.inject({ method: 'GET', url: '/api/bots', cookies: w.adminCookie });
    expect(bots.statusCode).toBe(200);
    const cols = await w.app.inject({ method: 'GET', url: `/api/collections?botId=${BOT}`, cookies: w.adminCookie });
    expect(cols.statusCode).toBe(200);
  });

  it('unauthenticated requests are 401', async () => {
    const res = await w.app.inject({ method: 'GET', url: `/api/collections?botId=${BOT}` });
    expect(res.statusCode).toBe(401);
  });
});

describe('collections definition API (admin)', () => {
  let w: World;
  beforeEach(async () => { w = await makeWorld(); });
  afterEach(async () => { await w.engine.gateway.stopAll(); await w.app.close(); });

  it('create → list → get → patch → delete', async () => {
    const id = await defineProducts(w);
    const list = await w.app.inject({ method: 'GET', url: `/api/collections?botId=${BOT}`, cookies: w.adminCookie });
    expect(list.json().collections).toHaveLength(1);

    const patch = await w.app.inject({
      method: 'PATCH', url: `/api/collections/${id}`, cookies: w.adminCookie,
      payload: { name: 'Catalogue' },
    });
    expect(patch.json().collection.name).toBe('Catalogue');

    const del = await w.app.inject({ method: 'DELETE', url: `/api/collections/${id}`, cookies: w.adminCookie });
    expect(del.statusCode).toBe(200);
    const after = await w.app.inject({ method: 'GET', url: `/api/collections?botId=${BOT}`, cookies: w.adminCookie });
    expect(after.json().collections).toHaveLength(0);
  });

  it('rejects an unknown bot and a duplicate slug', async () => {
    await defineProducts(w);
    const dup = await w.app.inject({
      method: 'POST', url: `/api/collections?botId=${BOT}`, cookies: w.adminCookie,
      payload: { slug: 'products', name: 'Again', schema: productsSchema },
    });
    expect(dup.statusCode).toBe(409);
    const badBot = await w.app.inject({
      method: 'POST', url: `/api/collections?botId=nope`, cookies: w.adminCookie,
      payload: { slug: 'x', name: 'X', schema: productsSchema },
    });
    expect(badBot.statusCode).toBe(400);
    expect(badBot.json().error).toBe('unknown_bot');
  });
});

describe('records API (admin + operator)', () => {
  let w: World;
  let colId: string;
  beforeEach(async () => { w = await makeWorld(); colId = await defineProducts(w); });
  afterEach(async () => { await w.engine.gateway.stopAll(); await w.app.close(); });

  it('operator can CRUD records', async () => {
    // create
    const create = await w.app.inject({
      method: 'POST', url: `/api/records/${colId}`, cookies: w.operatorCookie,
      payload: { data: { title: 'Mug', price: '12', variants: [{ color: 'red', stock: '3' }] } },
    });
    expect(create.statusCode).toBe(201);
    const rec = create.json().record;
    expect(rec.data).toMatchObject({ title: 'Mug', price: 12, status: 'draft', variants: [{ color: 'red', stock: 3 }] });
    expect(rec.createdBy).toBe('operator'); // provenance

    // read
    const read = await w.app.inject({ method: 'GET', url: `/api/records/${colId}/${rec.id}`, cookies: w.operatorCookie });
    expect(read.json().record.data.title).toBe('Mug');

    // update (merge)
    const upd = await w.app.inject({
      method: 'PATCH', url: `/api/records/${colId}/${rec.id}`, cookies: w.operatorCookie,
      payload: { data: { price: 99 } },
    });
    expect(upd.json().record.data.price).toBe(99);
    expect(upd.json().record.data.title).toBe('Mug');

    // delete
    const del = await w.app.inject({ method: 'DELETE', url: `/api/records/${colId}/${rec.id}`, cookies: w.operatorCookie });
    expect(del.statusCode).toBe(200);
    const gone = await w.app.inject({ method: 'GET', url: `/api/records/${colId}/${rec.id}`, cookies: w.operatorCookie });
    expect(gone.statusCode).toBe(404);
  });

  it('admin can create records too (provenance=admin)', async () => {
    const res = await w.app.inject({
      method: 'POST', url: `/api/records/${colId}`, cookies: w.adminCookie,
      payload: { data: { title: 'Pen' } },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().record.createdBy).toBe('admin');
  });

  it('invalid write → 422 with field-level errors', async () => {
    const res = await w.app.inject({
      method: 'POST', url: `/api/records/${colId}`, cookies: w.operatorCookie,
      payload: { data: { price: -1, status: 'bogus' } }, // title missing + bad option
    });
    expect(res.statusCode).toBe(422);
    const fields = res.json().fields as { path: string }[];
    expect(fields.map((f) => f.path)).toContain('title');
    expect(fields.map((f) => f.path)).toContain('status');
  });

  it('filter query parity: where + sort + limit + count', async () => {
    const seed = async (data: Record<string, unknown>) =>
      w.app.inject({ method: 'POST', url: `/api/records/${colId}`, cookies: w.operatorCookie, payload: { data } });
    await seed({ title: 'A', price: 30, status: 'published' });
    await seed({ title: 'B', price: 10, status: 'published' });
    await seed({ title: 'C', price: 20, status: 'draft' });

    const q = await w.app.inject({
      method: 'POST', url: `/api/records/${colId}/query`, cookies: w.operatorCookie,
      payload: {
        where: [{ field: 'status', op: 'eq', value: 'published' }],
        sort: [{ field: 'price', dir: 'asc' }],
        limit: 1,
      },
    });
    expect(q.statusCode).toBe(200);
    expect(q.json().total).toBe(2);
    expect(q.json().records).toHaveLength(1);
    expect(q.json().records[0].data.title).toBe('B'); // cheapest published

    const cnt = await w.app.inject({ method: 'GET', url: `/api/records/${colId}/count`, cookies: w.operatorCookie });
    expect(cnt.json().count).toBe(3);

    // gt / contains operators
    const gt = await w.app.inject({
      method: 'POST', url: `/api/records/${colId}/query`, cookies: w.operatorCookie,
      payload: { where: [{ field: 'price', op: 'gt', value: 15 }] },
    });
    expect(gt.json().total).toBe(2);
  });

  it('records on an unknown collection → 404', async () => {
    const res = await w.app.inject({ method: 'GET', url: `/api/records/nope`, cookies: w.operatorCookie });
    expect(res.statusCode).toBe(404);
  });
});

describe('file upload + retrieval', () => {
  let w: World;
  beforeEach(async () => { w = await makeWorld(); });
  afterEach(async () => { await w.engine.gateway.stopAll(); await w.app.close(); });

  it('operator uploads a file and retrieves identical bytes', async () => {
    // a tiny 1x1 PNG (binary), base64-encoded
    const pngBase64 =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const up = await w.app.inject({
      method: 'POST', url: `/api/files?botId=${BOT}`, cookies: w.operatorCookie,
      payload: { data: pngBase64, mime: 'image/png' },
    });
    expect(up.statusCode).toBe(201);
    const file = up.json().file;
    expect(file.kind).toBe('local');
    expect(file.mime).toBe('image/png');
    expect(file.url).toBe(`/api/files/${file.id}`);

    const dl = await w.app.inject({ method: 'GET', url: `/api/files/${file.id}`, cookies: w.operatorCookie });
    expect(dl.statusCode).toBe(200);
    expect(dl.headers['content-type']).toContain('image/png');
    expect(dl.rawPayload.toString('base64')).toBe(pngBase64); // byte-identical round-trip
  });

  it('rejects an empty file and a missing botId', async () => {
    const noBot = await w.app.inject({
      method: 'POST', url: `/api/files`, cookies: w.adminCookie, payload: { data: 'AAAA' },
    });
    expect(noBot.statusCode).toBe(400);
    const empty = await w.app.inject({
      method: 'POST', url: `/api/files?botId=${BOT}`, cookies: w.adminCookie, payload: { data: '' },
    });
    expect(empty.statusCode).toBe(400);
  });

  it('downloading an unknown file → 404', async () => {
    const res = await w.app.inject({ method: 'GET', url: `/api/files/nope`, cookies: w.adminCookie });
    expect(res.statusCode).toBe(404);
  });
});

describe('operator without configured password cannot log in', () => {
  it('401 when CTB_OPERATOR_PASS is unset', async () => {
    const env = loadEnv({ CTB_SECRET: SECRET, CTB_ADMIN_PASS: 'hunter2hunter2', NODE_ENV: 'test' } as NodeJS.ProcessEnv);
    const { db, sqlite } = openDb(':memory:');
    runMigrations(db);
    const engine = wireEngine({ db, ctbSecret: SECRET });
    const app = buildApp({ env, db, sqlite, engine, logger: false, editorDistDir: '/nonexistent' });
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'operator', password: 'operator' } });
    expect(res.statusCode).toBe(401);
    await engine.gateway.stopAll();
    await app.close();
  });
});
