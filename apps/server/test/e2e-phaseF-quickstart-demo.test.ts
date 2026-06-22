/**
 * 🎬 PLAN3 F-T2 — Phase-F quick-start demo: the "Hello bot" first-run path.
 *
 * F-T1 gave a brand-new user a guided empty state whose PRIMARY call-to-action
 * is "Start from template". F-T2 makes that land somewhere that works in one
 * click: the `hello` template — a minimal `flow.manualTrigger → tg.sendMessage`
 * greeting — must IMPORT, ACTIVATE, and (via the editor's Test-run button) send
 * an actual greeting, with NO chat wiring required from the user.
 *
 * This e2e drives the REAL wired engine + in-memory SQLite + a fake Telegram
 * transport (harness mirrored from e2e-phaseC-authoring-demo) over the SAME
 * panel HTTP routes the editor uses:
 *
 *   1. IMPORT   POST /api/flows/import-template { templateId: 'hello' } → a draft.
 *   2. ACTIVATE POST /api/flows/:id/activate                            → active.
 *   3. TEST RUN POST /api/flows/:id/run (the "Test run" button)         → the
 *               manual trigger seeds $json.chat from its sample, and
 *               tg.sendMessage delivers the greeting to that chat.
 *
 * A second test pins the under-5-minutes promise the docs make: the greeting is
 * sent to the sample chat with the template's exact text — proving the one-click
 * run actually replies, which is the whole point of the quick-start.
 */
import { findFlowTemplate } from '@ctb/shared';
import type { FlowPublic } from '@ctb/shared';
import type { FastifyInstance } from 'fastify';
import type { UserFromGetMe } from 'grammy/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SESSION_COOKIE, buildApp } from '../src/app';
import { openDb, type Db } from '../src/db/index';
import { runMigrations } from '../src/db/migrate';
import { wireEngine, type Engine } from '../src/engine/wire';
import { loadEnv } from '../src/lib/env';

const SECRET = 'devsecret0123456';
const TOKEN = '123456789:AAEexampletokenexampletokenexample';

const BOT_INFO: UserFromGetMe = {
  id: 42, is_bot: true, first_name: 'TestBot', username: 'test_bot',
  can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: false,
  can_connect_to_business: false, has_main_web_app: false, can_manage_bots: false,
  has_topics_enabled: false, allows_users_to_create_topics: false,
};

interface SentCall {
  method: string;
  payload: Record<string, unknown>;
}

interface World {
  app: FastifyInstance;
  db: Db;
  engine: Engine;
  cookie: { [k: string]: string };
  sent: SentCall[];
}

async function makeWorld(): Promise<World> {
  const env = loadEnv({
    CTB_SECRET: SECRET, CTB_ADMIN_PASS: 'hunter2hunter2', NODE_ENV: 'test',
  } as NodeJS.ProcessEnv);
  const { db } = openDb(':memory:');
  runMigrations(db);
  const engine = wireEngine({ db, ctbSecret: SECRET });
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

async function createBot(w: World, name = 'demo-bot'): Promise<string> {
  const { bot } = (
    await w.app.inject({
      method: 'POST', url: '/api/bots', cookies: w.cookie,
      payload: { name, token: TOKEN },
    })
  ).json() as { bot: { id: string } };
  return bot.id;
}

/**
 * Make the bot's (fake) Telegram sender available to the engine WITHOUT the
 * real long-polling loop. The panel "Test run" (`/api/flows/:id/run`) resolves
 * its tg capability via `gateway.get(botId)`, and that handle's sender is built
 * at REGISTER time — `startPolling()` only kicks off `bot.start()`, a
 * fire-and-forget long-poll that, with a fake transport, races to an "Aborted
 * delay" and makes the run flaky. Registering directly gives the same working
 * sender the live gateway uses (same rate-limited TgSender, I6) with none of
 * that polling noise — exactly what a one-click test run needs.
 */
function wireSender(w: World, botId: string): void {
  w.engine.gateway.registerBot(botId, TOKEN, {
    botInfo: BOT_INFO,
    callApi: async (method: string, payload: Record<string, unknown>) => {
      w.sent.push({ method, payload });
      return { message_id: 777 };
    },
  });
}

describe('🎬 Phase-F quick-start demo e2e (F-T2) — the "Hello bot" first run', () => {
  let w: World;
  beforeEach(async () => { w = await makeWorld(); });
  afterEach(async () => { await w.engine.gateway.stopAll(); await w.app.close(); });

  it('import the hello template → activate → Test run sends the greeting', async () => {
    const botId = await createBot(w);
    wireSender(w, botId); // the sendMessage leg goes through the (fake) gateway sender

    // ── 1. IMPORT: the empty-state "Start from template" CTA picks `hello`.
    const importRes = await w.app.inject({
      method: 'POST', url: '/api/flows/import-template', cookies: w.cookie,
      payload: { botId, templateId: 'hello' },
    });
    expect(importRes.statusCode).toBe(201);
    const flow = (importRes.json() as { flow: FlowPublic }).flow;
    // a fresh draft — never auto-activated.
    expect(flow.status).toBe('draft');
    // it really is the minimal two-node greeting.
    expect(flow.graph.nodes.map((n) => n.type)).toEqual(['flow.manualTrigger', 'tg.sendMessage']);

    // ── 2. ACTIVATE: the draft becomes active (it has a trigger, params valid).
    const actRes = await w.app.inject({
      method: 'POST', url: `/api/flows/${flow.id}/activate`, cookies: w.cookie,
    });
    expect(actRes.statusCode).toBe(200);
    expect((actRes.json() as { ok: boolean; status: string }).status).toBe('active');

    // ── 3. TEST RUN: the editor's one-click run. No chat is passed — the manual
    //      trigger's sample seeds $json.chat, so the greeting has somewhere to go.
    const runRes = await w.app.inject({
      method: 'POST', url: `/api/flows/${flow.id}/run`, cookies: w.cookie,
    });
    expect(runRes.statusCode).toBe(200);
    expect((runRes.json() as { status: string }).status).toBe('done');

    // ── The bot actually replied: a sendMessage to the sample chat (123456789).
    const send = w.sent.find((c) => c.method === 'sendMessage');
    expect(send, 'the hello flow sent a Telegram message').toBeTruthy();
    expect(send!.payload.chat_id).toBe(123456789);
  });

  it('the delivered text matches the template greeting exactly (the 5-min promise)', async () => {
    const botId = await createBot(w);
    wireSender(w, botId);

    const flowId = (
      (
        await w.app.inject({
          method: 'POST', url: '/api/flows/import-template', cookies: w.cookie,
          payload: { botId, templateId: 'hello' },
        })
      ).json() as { flow: FlowPublic }
    ).flow.id;
    await w.app.inject({ method: 'POST', url: `/api/flows/${flowId}/activate`, cookies: w.cookie });
    await w.app.inject({ method: 'POST', url: `/api/flows/${flowId}/run`, cookies: w.cookie });

    // The text the user sees is the template's greeting verbatim — the source of
    // truth for the quickstart doc, so this guards the doc against drift.
    const expectedText =
      (findFlowTemplate('hello')!.export.graph.nodes.find((n) => n.type === 'tg.sendMessage')!
        .params as { text: string }).text;
    const send = w.sent.find((c) => c.method === 'sendMessage');
    expect(send!.payload.text).toBe(expectedText);
  });
});
