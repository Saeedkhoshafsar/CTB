/**
 * P3.5-T6 — starter-pack gallery endpoints.
 *
 *   • GET  /api/collection-packs         → lists the shipped packs (gallery rows)
 *   • POST /api/collection-packs/import  → creates a pack's collections (skipping
 *     slugs already in use — idempotent) + its flows as DRAFTS, in one call.
 *
 * The import path reuses the SAME store + flow table the panel/API already use
 * (no new validation surface, I5), so we assert against those directly.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';
import { SESSION_COOKIE, buildApp } from '../src/app';
import { openDb, schema, type Db } from '../src/db/index';
import { runMigrations } from '../src/db/migrate';
import { wireEngine } from '../src/engine/wire';
import { loadEnv } from '../src/lib/env';

const SECRET = 'devsecret0123456';
const BOT = 'bot1';

interface World {
  app: FastifyInstance;
  db: Db;
  cookie: Record<string, string>;
}

async function makeWorld(): Promise<World> {
  const dataDir = mkdtempSync(join(tmpdir(), 'ctb-packs-'));
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
  db.insert(schema.bots).values({ id: BOT, name: 'b', tokenEnc: 'enc.x.y', createdAt: now, updatedAt: now }).run();
  // sqlite handed to wireEngine ⇒ the engine owns the collection store, which the
  // collections API (and the import endpoint) share.
  const engine = wireEngine({ db, sqlite, ctbSecret: SECRET, expressionBudgetMs: 5_000 });
  const app = buildApp({ env, db, sqlite, engine, logger: false, editorDistDir: '/nonexistent' });
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'admin', password: 'hunter2hunter2' } });
  expect(res.statusCode).toBe(200);
  const cookie = { [SESSION_COOKIE]: res.cookies.find((c) => c.name === SESSION_COOKIE)!.value };
  return { app, db, cookie };
}

describe('collection-pack gallery API (P3.5-T6)', () => {
  it('GET /api/collection-packs lists the shipped packs (gallery rows, no heavy payload)', async () => {
    const w = await makeWorld();
    const res = await w.app.inject({ method: 'GET', url: '/api/collection-packs', cookies: w.cookie });
    expect(res.statusCode).toBe(200);
    const { packs } = res.json() as {
      packs: { id: string; collectionSlugs: string[]; flowNames: string[]; icon: string }[];
    };
    const shop = packs.find((p) => p.id === 'shop')!;
    expect(shop).toBeTruthy();
    expect(shop.collectionSlugs).toEqual(['catalog', 'orders']);
    expect(shop.flowNames).toHaveLength(2);
    // gallery rows stay light — no schema/graph fields leak into the list
    expect(shop).not.toHaveProperty('collections');
    expect(shop).not.toHaveProperty('flows');
  });

  it('POST import creates the pack collections + flows (drafts) in one call', async () => {
    const w = await makeWorld();
    const res = await w.app.inject({
      method: 'POST',
      url: '/api/collection-packs/import',
      cookies: w.cookie,
      payload: { botId: BOT, packId: 'shop' },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as {
      pack: string;
      collections: { slug: string; id: string }[];
      skippedCollections: string[];
      flows: { id: string; name: string }[];
    };
    expect(body.pack).toBe('shop');
    expect(body.collections.map((c) => c.slug).sort()).toEqual(['catalog', 'orders']);
    expect(body.skippedCollections).toEqual([]);
    expect(body.flows).toHaveLength(2);

    // the collections really landed for the bot
    const list = await w.app.inject({ method: 'GET', url: `/api/collections?botId=${BOT}`, cookies: w.cookie });
    const slugs = (list.json().collections as { slug: string }[]).map((c) => c.slug).sort();
    expect(slugs).toEqual(['catalog', 'orders']);

    // flows were inserted as DRAFTS (operator reviews + activates)
    const flowRows = w.db.select().from(schema.flows).all();
    expect(flowRows).toHaveLength(2);
    expect(flowRows.every((f) => f.status === 'draft')).toBe(true);
    expect(flowRows.every((f) => f.botId === BOT)).toBe(true);
  });

  it('re-importing is idempotent: existing slugs are SKIPPED, not clobbered', async () => {
    const w = await makeWorld();
    await w.app.inject({ method: 'POST', url: '/api/collection-packs/import', cookies: w.cookie, payload: { botId: BOT, packId: 'shop' } });

    // mutate one record so we can prove the second import didn't wipe data
    const cols = (await w.app.inject({ method: 'GET', url: `/api/collections?botId=${BOT}`, cookies: w.cookie })).json()
      .collections as { id: string; slug: string }[];
    const catalogId = cols.find((c) => c.slug === 'catalog')!.id;
    const ins = await w.app.inject({ method: 'POST', url: `/api/records/${catalogId}`, cookies: w.cookie, payload: { data: { name: 'Keep me', price: 1 } } });
    expect(ins.statusCode).toBe(201);

    const second = await w.app.inject({ method: 'POST', url: '/api/collection-packs/import', cookies: w.cookie, payload: { botId: BOT, packId: 'shop' } });
    expect(second.statusCode).toBe(201);
    const body = second.json() as { collections: unknown[]; skippedCollections: string[]; flows: unknown[] };
    expect(body.collections).toEqual([]); // nothing new created
    expect(body.skippedCollections.sort()).toEqual(['catalog', 'orders']);

    // the existing collection (and its data) survived: still ONE catalog, record intact
    const cols2 = (await w.app.inject({ method: 'GET', url: `/api/collections?botId=${BOT}`, cookies: w.cookie })).json()
      .collections as { id: string; slug: string }[];
    expect(cols2.filter((c) => c.slug === 'catalog')).toHaveLength(1);
    const rec = await w.app.inject({ method: 'POST', url: `/api/records/${catalogId}/query`, cookies: w.cookie, payload: {} });
    expect((rec.json().records as unknown[]).length).toBe(1);
  });

  it('rejects an unknown pack id (404) and an unknown bot (400)', async () => {
    const w = await makeWorld();
    const badPack = await w.app.inject({ method: 'POST', url: '/api/collection-packs/import', cookies: w.cookie, payload: { botId: BOT, packId: 'nope' } });
    expect(badPack.statusCode).toBe(404);
    const badBot = await w.app.inject({ method: 'POST', url: '/api/collection-packs/import', cookies: w.cookie, payload: { botId: 'ghost', packId: 'shop' } });
    expect(badBot.statusCode).toBe(400);
  });
});
