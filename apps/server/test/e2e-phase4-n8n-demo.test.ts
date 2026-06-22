/**
 * P4-T5 — 🎬 PHASE-4 DEMO as a scripted e2e test (the open-protocol test).
 *
 * The canonical "n8n → CTB (sync)" recipe (PROTOCOL.md §"n8n recipes" #1)
 * driven end to end against a FAKE Telegram transport + in-memory SQLite:
 *
 *   • "n8n" POSTs the flow's inbound Webhook Trigger URL (sync mode), carrying
 *     a `question` and the target `chat_id` in the JSON body. The HTTP request
 *     BLOCKS — n8n is waiting for the user's answer.
 *   • CTB binds the run to that chat (the trigger's `target_chat` =
 *     `$json.body.chat_id`), `tg.sendMessage` asks the user the question, and
 *     `tg.waitForReply` parks the run.
 *   • the user answers in "Telegram" (gateway.dispatch of a raw Update) → the
 *     run RESUMES → `flow.respondToWebhook` returns `{ answer: <the reply> }`.
 *   • the still-open n8n HTTP request unblocks with HTTP 200 + that JSON — the
 *     user's words are now back in n8n.
 *
 * This proves the PLAN Phase-4 demo: "n8n workflow triggers a CTB flow → CTB
 * converses with a user → user's answer returns to n8n (sync webhook)."
 */
import { destroyDefaultSandboxPool } from '@ctb/sandbox';
import { FlowGraphSchema, type FlowGraph } from '@ctb/shared';
import type { FastifyInstance } from 'fastify';
import type { Update, UserFromGetMe } from 'grammy/types';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SESSION_COOKIE, buildApp } from '../src/app';
import { openDb, schema, type Db } from '../src/db/index';
import { runMigrations } from '../src/db/migrate';
import { wireEngine, type Engine } from '../src/engine/wire';
import { loadEnv } from '../src/lib/env';
import { encrypt, deriveKey } from '../src/lib/crypto';
import { flowWebhookSecret } from '../src/triggers/webhook';

const SECRET = 'devsecret0123456';
const TOKEN = '123456789:AAEexampletokenexampletokenexample';
const BOT = 'office-bot';
const FLOW = 'ask-the-user';
const CHAT = 555;

const BOT_INFO: UserFromGetMe = {
  id: 7, is_bot: true, first_name: 'OfficeBot', username: 'office_bot',
  can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: false,
  can_connect_to_business: false, has_main_web_app: false, can_manage_bots: false,
  has_topics_enabled: false, allows_users_to_create_topics: false,
};

afterAll(async () => {
  await destroyDefaultSandboxPool();
});

interface Sent { method: string; payload: Record<string, unknown> }

interface World {
  app: FastifyInstance;
  db: Db;
  engine: Engine;
  sent: Sent[];
  cookie: Record<string, string>;
}

/**
 * The demo flow: Webhook Trigger (sync, bound to body.chat_id) → ask the user →
 * wait for the reply (saved to $vars.answer) → respond to the webhook with it.
 */
const DEMO_GRAPH: FlowGraph = FlowGraphSchema.parse({
  nodes: [
    {
      id: 'trig',
      type: 'webhook.trigger',
      params: { mode: 'sync', sync_timeout: 30, target_chat: '$json.body.chat_id' },
      position: { x: 0, y: 0 },
      disabled: false,
    },
    {
      id: 'ask',
      type: 'tg.sendMessage',
      params: { type: 'text', text: 'Quick question: {{ $json.body.question }}' },
      position: { x: 200, y: 0 },
      disabled: false,
    },
    {
      id: 'wait',
      type: 'tg.waitForReply',
      params: { expect: 'text', save_to: 'answer' },
      position: { x: 400, y: 0 },
      disabled: false,
    },
    {
      id: 'resp',
      type: 'flow.respondToWebhook',
      params: { status: 200, body_type: 'json', body: '{"answer":"{{ $vars.answer }}"}' },
      position: { x: 600, y: 0 },
      disabled: false,
    },
  ],
  edges: [
    { id: 'e1', from: { node: 'trig', port: 'main' }, to: { node: 'ask', port: 'main' } },
    { id: 'e2', from: { node: 'ask', port: 'main' }, to: { node: 'wait', port: 'main' } },
    { id: 'e3', from: { node: 'wait', port: 'reply' }, to: { node: 'resp', port: 'main' } },
  ],
});

async function makeWorld(): Promise<World> {
  const env = loadEnv({
    CTB_SECRET: SECRET, CTB_ADMIN_PASS: 'hunter2hunter2', NODE_ENV: 'test',
  } as NodeJS.ProcessEnv);
  const { db } = openDb(':memory:');
  runMigrations(db);
  const engine = wireEngine({ db, ctbSecret: SECRET, expressionBudgetMs: 5_000 });

  const now = new Date().toISOString();
  db.insert(schema.bots).values({
    id: BOT, name: 'Office', tokenEnc: encrypt(TOKEN, deriveKey(SECRET)),
    mode: 'polling', status: 'active', settings: {}, createdAt: now, updatedAt: now,
  }).run();
  db.insert(schema.flows).values({
    id: FLOW, botId: BOT, name: 'Ask the user', status: 'active',
    graph: DEMO_GRAPH, version: 1, updatedAt: now,
  }).run();

  const sent: Sent[] = [];
  engine.gateway.registerBot(BOT, TOKEN, {
    botInfo: BOT_INFO,
    callApi: async (method, payload) => {
      sent.push({ method, payload: payload as Record<string, unknown> });
      return { message_id: sent.length, date: 0, chat: { id: CHAT, type: 'private' } };
    },
  });

  const login = await app_login(buildApp({ env, db, engine, logger: false, editorDistDir: '/nonexistent' }));
  return { ...login, db, engine, sent };
}

async function app_login(app: FastifyInstance): Promise<{ app: FastifyInstance; cookie: Record<string, string> }> {
  const res = await app.inject({
    method: 'POST', url: '/api/auth/login',
    payload: { username: 'admin', password: 'hunter2hunter2' },
  });
  expect(res.statusCode).toBe(200);
  return { app, cookie: { [SESSION_COOKIE]: res.cookies.find((c) => c.name === SESSION_COOKIE)!.value } };
}

let updateId = 0;
function textUpdate(text: string): Update {
  updateId += 1;
  return {
    update_id: updateId,
    message: {
      message_id: updateId * 10, date: 0,
      from: { id: 900, is_bot: false, first_name: 'Sara' },
      chat: { id: CHAT, type: 'private', first_name: 'Sara' },
      text,
    },
  } as unknown as Update;
}

const sentTexts = (sent: Sent[]): string[] =>
  sent.filter((m) => m.method === 'sendMessage').map((m) => String(m.payload.text ?? ''));

/** Wait until `pred()` is true (polling), so we don't await the parked request. */
async function until(pred: () => boolean, tries = 100): Promise<void> {
  for (let i = 0; i < tries; i++) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('condition not reached in time');
}

describe('🎬 Phase-4 demo e2e (P4-T5, n8n → CTB sync)', () => {
  let w: World;
  beforeEach(async () => { w = await makeWorld(); });
  afterEach(async () => { await w.engine.gateway.stopAll(); await w.app.close(); });

  it('n8n triggers the flow → CTB asks the user → the user\'s answer returns over the sync webhook', async () => {
    const url = `/hooks/flow/${FLOW}/${flowWebhookSecret(FLOW, SECRET)}`;

    // ── "n8n" fires the sync webhook and WAITS (don't await yet) ──
    const n8nCall = w.app.inject({
      method: 'POST',
      url,
      payload: { chat_id: CHAT, question: 'Approve invoice #42?' },
    });

    // ── CTB binds the run to the chat and asks the user in "Telegram" ──
    await until(() => sentTexts(w.sent).some((t) => t.includes('Approve invoice #42?')));
    expect(sentTexts(w.sent).at(-1)).toContain('Quick question: Approve invoice #42?');

    // ── the user answers → the run resumes → respondToWebhook fires ──
    await w.engine.gateway.dispatch(BOT, textUpdate('Yes, approved.'));

    // ── the still-open n8n request unblocks with the user's words ──
    const res = await n8nCall;
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/json');
    expect(res.json()).toEqual({ answer: 'Yes, approved.' });
  });

  it('the run is bound to the right chat: target_chat resolves from the body', async () => {
    const url = `/hooks/flow/${FLOW}/${flowWebhookSecret(FLOW, SECRET)}`;
    const n8nCall = w.app.inject({
      method: 'POST', url,
      payload: { chat_id: CHAT, question: 'Ready?' },
    });
    await until(() => sentTexts(w.sent).length > 0);

    // every outbound Telegram call went to the chat n8n named in the body
    const chats = w.sent.filter((m) => m.method === 'sendMessage').map((m) => m.payload.chat_id);
    expect(chats.every((c) => c === CHAT)).toBe(true);

    await w.engine.gateway.dispatch(BOT, textUpdate('Go'));
    const res = await n8nCall;
    expect(res.json()).toEqual({ answer: 'Go' });
  });
});
