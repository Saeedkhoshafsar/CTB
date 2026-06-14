/**
 * P3.5-T6 — 🎬 PHASE-3.5 DEMO as a scripted e2e test (the manager test).
 *
 * The FULL production wiring drives the Collections demo end to end, against a
 * FAKE Telegram transport and a real on-disk SQLite file:
 *
 *   • operator builds DATA in the panel (REST): installs the "shop" starter
 *     pack (catalog + orders collections + the two flows), adds catalog items.
 *   • customer browses/orders in "Telegram" (gateway.dispatch of raw Updates):
 *     /shop → pick item (menu) → pick size (menu) → quantity (wait) → an
 *     `orders` record is inserted via the data.collection node.
 *   • 💀 kill the server MID order-conversation (waiting at the quantity
 *     question) — throw away every in-memory object, keep ONLY the SQLite file,
 *     re-wire from scratch, answer → the flow RESUMES and places the order (I4).
 *   • operator flips the order's status to "shipped" in the panel (REST PATCH)
 *     → the `collection.recordChanged` flow fires host-side and the customer
 *     gets a DM about their order — without the operator touching the canvas.
 *
 * Everything is GENERIC (invariant I2): the engine never learns "product" or
 * "order"; those words live only in the pack's template data + node params.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { destroyDefaultSandboxPool } from '@ctb/sandbox';
import { shopPack } from '@ctb/shared';
import type { FlowGraph } from '@ctb/shared';
import type { FastifyInstance } from 'fastify';
import type { Update, UserFromGetMe } from 'grammy/types';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { SESSION_COOKIE, buildApp } from '../src/app';
import { openDb, schema, type Db } from '../src/db/index';
import { runMigrations } from '../src/db/migrate';
import { wireEngine, type Engine } from '../src/engine/wire';
import { loadEnv } from '../src/lib/env';
import { encrypt, deriveKey } from '../src/lib/crypto';

const SECRET = 'devsecret0123456';
const TOKEN = '123456789:AAEexampletokenexampletokenexample';
const BOT = 'shop-bot';
const CHAT = 555;

const BOT_INFO: UserFromGetMe = {
  id: 7, is_bot: true, first_name: 'ShopBot', username: 'shop_bot',
  can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: false,
  can_connect_to_business: false, has_main_web_app: false, can_manage_bots: false,
  has_topics_enabled: false, allows_users_to_create_topics: false,
};

afterAll(async () => {
  await destroyDefaultSandboxPool();
});

interface Sent { method: string; payload: Record<string, unknown> }

interface Server {
  app: FastifyInstance;
  engine: Engine;
  db: Db;
  sqlite: ReturnType<typeof openDb>['sqlite'];
  sent: Sent[];
  cookie: Record<string, string>;
}

/** Boot "a server": open the DB file, build the app + engine (with sqlite so the
 *  collection store + record-event bus wire up), register the bot with a
 *  recording fake transport, log the operator in. */
async function boot(dbPath: string, dataDir: string): Promise<Server> {
  const env = loadEnv({
    CTB_SECRET: SECRET,
    CTB_ADMIN_PASS: 'hunter2hunter2',
    CTB_OPERATOR_PASS: 'managerpass99',
    CTB_DATA_DIR: dataDir,
    NODE_ENV: 'test',
  } as NodeJS.ProcessEnv);
  const { db, sqlite } = openDb(dbPath);
  runMigrations(db);
  const engine = wireEngine({ db, sqlite, ctbSecret: SECRET });
  const sent: Sent[] = [];
  engine.gateway.registerBot(BOT, TOKEN, {
    botInfo: BOT_INFO,
    callApi: async (method, payload) => {
      sent.push({ method, payload: payload as Record<string, unknown> });
      return { message_id: sent.length, date: 0, chat: { id: CHAT, type: 'private' } };
    },
  });
  const app = buildApp({ env, db, sqlite, engine, logger: false, editorDistDir: '/nonexistent' });
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'admin', password: 'hunter2hunter2' } });
  expect(res.statusCode).toBe(200);
  const cookie = { [SESSION_COOKIE]: res.cookies.find((c) => c.name === SESSION_COOKIE)!.value };
  return { app, engine, db, sqlite, sent, cookie };
}

/** Seed only the bot row (a real bot with an encrypted token). */
function seedBot(db: Db): void {
  const now = new Date().toISOString();
  db.insert(schema.bots).values({
    id: BOT, name: 'Shop', tokenEnc: encrypt(TOKEN, deriveKey(SECRET)),
    mode: 'polling', status: 'active', settings: {}, createdAt: now, updatedAt: now,
  }).run();
}

/** Insert one of the pack's flows directly as ACTIVE (operator reviewed it). */
function activateFlow(db: Db, id: string, name: string, graph: FlowGraph): void {
  const now = new Date().toISOString();
  db.insert(schema.flows)
    .values({ id, botId: BOT, name, status: 'active', graph, settings: {}, version: 1, updatedAt: now })
    .run();
}

let updateId = 0;
function textUpdate(text: string): Update {
  updateId += 1;
  return {
    update_id: updateId,
    message: { message_id: updateId * 10, date: 0, from: { id: 900, is_bot: false, first_name: 'Sara' }, chat: { id: CHAT, type: 'private', first_name: 'Sara' }, text },
  } as unknown as Update;
}
/** A button click on a menu — port key "btn:<key>" carries value as callback data. */
function clickUpdate(value: string): Update {
  updateId += 1;
  return {
    update_id: updateId,
    callback_query: {
      id: String(updateId), from: { id: 900, is_bot: false, first_name: 'Sara' },
      message: { message_id: updateId * 10, date: 0, chat: { id: CHAT, type: 'private' }, text: '…' },
      data: value, chat_instance: 'ci',
    },
  } as unknown as Update;
}

const sentTexts = (sent: Sent[]): string[] => sent.filter((m) => m.method === 'sendMessage').map((m) => String(m.payload.text ?? ''));
const lastText = (sent: Sent[]): string => sentTexts(sent).at(-1) ?? '';

const browseGraph = shopPack.flows.find((f) => f.id === 'browse-and-order')!.export.graph as unknown as FlowGraph;
const notifyGraph = shopPack.flows.find((f) => f.id === 'notify-on-status')!.export.graph as unknown as FlowGraph;

async function addCatalogItem(s: Server, catalogId: string, data: Record<string, unknown>): Promise<void> {
  const res = await s.app.inject({ method: 'POST', url: `/api/records/${catalogId}`, cookies: s.cookie, payload: { data } });
  expect(res.statusCode).toBe(201);
}

describe('🎬 Phase-3.5 demo e2e (P3.5-T6, the manager test)', () => {
  let dir: string;
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  it('operator builds data → customer orders (with mid-order RESTART) → operator ships → customer notified', async () => {
    dir = mkdtempSync(join(tmpdir(), 'ctb-shop-'));
    const dbPath = join(dir, 'ctb.sqlite');

    // ── server #1 ──
    const s1 = await boot(dbPath, dir);
    seedBot(s1.db);

    // ── operator builds DATA in the panel (REST): install the starter pack ──
    const imp = await s1.app.inject({ method: 'POST', url: '/api/collection-packs/import', cookies: s1.cookie, payload: { botId: BOT, packId: 'shop' } });
    expect(imp.statusCode).toBe(201);
    const body = imp.json() as { collections: { slug: string; id: string }[]; flows: { id: string; name: string }[] };
    const catalogId = body.collections.find((c) => c.slug === 'catalog')!.id;
    const ordersId = body.collections.find((c) => c.slug === 'orders')!.id;
    expect(body.flows).toHaveLength(2);

    // Import created the flows as DRAFTS; operator reviews & activates. We mark
    // them active directly (activation validation is covered elsewhere) using
    // the SAME graphs the pack shipped.
    activateFlow(s1.db, 'flow-browse', 'Browse & order', browseGraph);
    activateFlow(s1.db, 'flow-notify', 'Notify on status change', notifyGraph);

    // operator adds two catalog items in the panel
    await addCatalogItem(s1, catalogId, { name: 'Item A', price: 10, stock: 5, size: 'M', status: 'available' });
    await addCatalogItem(s1, catalogId, { name: 'Item B', price: 20, stock: 3, size: 'L', status: 'available' });

    // ── customer browses & orders in "Telegram" ──
    await s1.engine.gateway.dispatch(BOT, textUpdate('/shop'));
    expect(lastText(s1.sent)).toContain('What would you like to order?');

    await s1.engine.gateway.dispatch(BOT, clickUpdate('a')); // pick item A → stash → ask size
    expect(lastText(s1.sent)).toContain('Which size?');

    // button keys are lowercase ('s'/'m'/'l'); the carried VALUE is 'M' (what
    // lands in the KV cart + the order's `size`).
    await s1.engine.gateway.dispatch(BOT, clickUpdate('m')); // pick size → stash → ask quantity
    expect(lastText(s1.sent)).toContain('How many?');

    // ── 💀 kill server #1 mid order-conversation (waiting at the quantity ask) ──
    await s1.engine.gateway.stopAll();
    s1.sqlite.close();
    await s1.app.close();

    // ── server #2: fresh process — only the SQLite file survives ──
    const s2 = await boot(dbPath, dir);

    // no order yet — the customer hasn't answered the quantity question
    const before = s2.db.select().from(schema.executions).all();
    expect(before.some((e) => e.status === 'waiting')).toBe(true);
    const ordersCountBefore = await s2.app.inject({ method: 'GET', url: `/api/records/${ordersId}/count`, cookies: s2.cookie });
    expect(ordersCountBefore.json().count).toBe(0);

    // customer answers the quantity → flow resumes on the NEW server and inserts the order
    await s2.engine.gateway.dispatch(BOT, textUpdate('2'));
    expect(lastText(s2.sent)).toContain('Order placed');

    // the order landed in the orders collection with the resumed conversation's data
    const ordersAfter = await s2.app.inject({ method: 'POST', url: `/api/records/${ordersId}/query`, cookies: s2.cookie, payload: {} });
    const rows = ordersAfter.json().records as { id: string; data: Record<string, unknown> }[];
    expect(rows).toHaveLength(1);
    const order = rows[0]!;
    expect(order.data).toMatchObject({ item_id: 'a', size: 'M', quantity: 2, status: 'new', customer_chat_id: String(CHAT) });

    // ── operator flips the order status to "shipped" in the panel (REST) ──
    const sentBeforeShip = s2.sent.length;
    const patch = await s2.app.inject({ method: 'PATCH', url: `/api/records/${ordersId}/${order.id}`, cookies: s2.cookie, payload: { data: { status: 'shipped' } } });
    expect(patch.statusCode).toBe(200);

    // the recordChanged(status) flow fired host-side → customer got a DM. The
    // chat id was resolved from the record's stored string via coerceChatId, so
    // it lands on the wire as a number (Telegram's chat_id type).
    const newMsgs = s2.sent.slice(sentBeforeShip).filter((m) => m.method === 'sendMessage');
    expect(newMsgs).toHaveLength(1);
    expect(newMsgs[0]!.payload.chat_id).toBe(CHAT);
    expect(String(newMsgs[0]!.payload.text)).toContain('shipped');

    await s2.engine.gateway.stopAll();
    s2.sqlite.close();
    await s2.app.close();
  });
});
