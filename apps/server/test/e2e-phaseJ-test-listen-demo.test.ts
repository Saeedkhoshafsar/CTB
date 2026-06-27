/**
 * J-T3 (Report B) — 🎬 PHASE-J DEMO: "listen for one live update" end-to-end.
 *
 * The n8n "listen for test event" parity, driven end to end against a FAKE
 * Telegram transport + in-memory SQLite over the SAME panel HTTP routes the
 * editor's "Test run" button uses (POST /api/flows/:id/test-listen).
 *
 * It proves the J-T3 contract: a SINGLE `tg.trigger` node, TWO run modes —
 *
 *   • TEST (listen-for-one): the operator hits "Test run" on a flow whose entry
 *     is a real `tg.trigger` → the editor arms a listen (`POST /test-listen`)
 *     and waits. The next live message is dispatched through the gateway, the
 *     router resumes the armed listen EXACTLY-ONCE, and the REAL sender data
 *     (id / firstName / text) flows to node 2 — asserted via the executions API,
 *     proving the captured item reached the downstream node. Polling
 *     `GET /test-listen/status` flips `listening` → `captured`.
 *
 *   • PRODUCTION (router match): the SAME flow with the SAME `tg.trigger` node
 *     TYPE fires immediately on a normal inbound message (no arming) and replies
 *     to the sender's chat — proving the trial run and the live run share one
 *     trigger node, never swapping it for a Manual trigger.
 *
 * Harness mirrored from e2e-phase4-n8n-demo.test.ts + api-flows-test-listen.test.ts.
 */
import { destroyDefaultSandboxPool } from '@ctb/sandbox';
import type { TestListenArmed, TestListenStatus } from '@ctb/shared';
import type { FastifyInstance } from 'fastify';
import type { Update, UserFromGetMe } from 'grammy/types';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SESSION_COOKIE, buildApp } from '../src/app';
import { openDb, type Db } from '../src/db/index';
import { runMigrations } from '../src/db/migrate';
import { wireEngine, type Engine } from '../src/engine/wire';
import { loadEnv } from '../src/lib/env';

const SECRET = 'devsecret0123456';
const TOKEN = '123456789:AAEexampletokenexampletokenexample';

const BOT_INFO: UserFromGetMe = {
  id: 42, is_bot: true, first_name: 'GreeterBot', username: 'greeter_bot',
  can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: false,
  can_connect_to_business: false, has_main_web_app: false, can_manage_bots: false,
  has_topics_enabled: false, allows_users_to_create_topics: false,
};

afterAll(async () => {
  await destroyDefaultSandboxPool();
});

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
        return { message_id: sent.length, date: 0, chat: { id: payload['chat_id'], type: 'private' } };
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

async function createBot(w: World, name = 'greeter-bot'): Promise<string> {
  const { bot } = (
    await w.app.inject({ method: 'POST', url: '/api/bots', cookies: w.cookie, payload: { name, token: TOKEN } })
  ).json() as { bot: { id: string } };
  // Bring the bot online — POST /api/bots/:id/start is what registers it with
  // the gateway (its rate-limited sender). Without this the bot can receive a
  // dispatch (the router still resolves the flow) but `ctx.tg` is null, so any
  // tg.sendMessage fails with "no sender injected". A real operator always
  // starts a bot before it can reply, so the demo does the same.
  const started = await w.app.inject({ method: 'POST', url: `/api/bots/${bot.id}/start`, cookies: w.cookie });
  expect(started.statusCode).toBe(200);
  return bot.id;
}

/**
 * The demo flow — the smallest flow whose entry is a REAL `tg.trigger`:
 *   tg.trigger(any_message) → data.setFields (records who said what)
 *                           → tg.sendMessage (greets the sender in production)
 *
 * `data.setFields` is chatless-safe, so it runs in BOTH modes and lets the
 * listen capture prove "the sender data reached node 2" via the executions API.
 * `tg.sendMessage` needs a chat, so it only fires on a production run (which is
 * bound to the sender's chat) — exactly the real difference between the modes.
 */
function greetGraph() {
  return {
    nodes: [
      { id: 'trig', type: 'tg.trigger', params: { event: 'any_message' }, position: { x: 0, y: 0 }, disabled: false },
      {
        id: 'seen', type: 'data.setFields',
        params: {
          fields: [
            { target: 'json', name: 'sawUserId', value: '{{ $json.user.id }}', op: 'set' },
            { target: 'json', name: 'sawName', value: '{{ $json.user.firstName }}', op: 'set' },
            { target: 'json', name: 'sawText', value: '{{ $json.text }}', op: 'set' },
          ],
        },
        position: { x: 220, y: 0 }, disabled: false,
      },
      {
        id: 'reply', type: 'tg.sendMessage',
        params: { type: 'text', text: 'سلام {{ $json.sawName }}! گفتی: {{ $json.sawText }}' },
        position: { x: 440, y: 0 }, disabled: false,
      },
    ],
    edges: [
      { id: 'e1', from: { node: 'trig', port: 'main' }, to: { node: 'seen', port: 'main' } },
      { id: 'e2', from: { node: 'seen', port: 'main' }, to: { node: 'reply', port: 'main' } },
    ],
  };
}

async function createActiveFlow(w: World, botId: string, graph: unknown = greetGraph()): Promise<string> {
  const created = (
    await w.app.inject({ method: 'POST', url: '/api/flows', cookies: w.cookie, payload: { botId, name: 'greet', graph } })
  ).json() as { flow: { id: string } };
  const id = created.flow.id;
  await w.app.inject({ method: 'POST', url: `/api/flows/${id}/activate`, cookies: w.cookie });
  return id;
}

let updateId = 0;
function textUpdate(text: string, fromId = 555, firstName = 'سارا', chatId = 7): Update {
  updateId += 1;
  return {
    update_id: updateId,
    message: {
      message_id: updateId * 10, date: 0,
      from: { id: fromId, is_bot: false, first_name: firstName },
      chat: { id: chatId, type: 'private', first_name: firstName },
      text,
    },
  } as unknown as Update;
}

function commandUpdate(text: string, fromId = 555, chatId = 7): Update {
  updateId += 1;
  return {
    update_id: updateId,
    message: {
      message_id: updateId * 10, date: 0,
      from: { id: fromId, is_bot: false, first_name: 'سارا' },
      chat: { id: chatId, type: 'private', first_name: 'سارا' },
      text,
      entities: [{ type: 'bot_command', offset: 0, length: text.length }],
    },
  } as unknown as Update;
}

const sentTexts = (w: World): string[] =>
  w.sent.filter((m) => m.method === 'sendMessage').map((m) => String(m.payload['text'] ?? ''));

async function status(w: World, flowId: string, executionId: string): Promise<TestListenStatus['state']> {
  return (
    (await w.app.inject({
      method: 'GET',
      url: `/api/flows/${flowId}/test-listen/status?executionId=${encodeURIComponent(executionId)}`,
      cookies: w.cookie,
    })).json() as TestListenStatus
  ).state;
}

/** Read the latest execution's per-node output snapshot for `nodeId`. */
async function nodeOutput(w: World, flowId: string, nodeId: string): Promise<Record<string, unknown> | undefined> {
  const list = (
    await w.app.inject({ method: 'GET', url: `/api/executions?flowId=${flowId}&limit=1`, cookies: w.cookie })
  ).json() as { executions: { id: string }[] };
  if (!list.executions[0]) return undefined;
  const detail = (
    await w.app.inject({ method: 'GET', url: `/api/executions/${list.executions[0].id}`, cookies: w.cookie })
  ).json() as { execution: { logs: { nodeId: string | null; output?: Record<string, Array<{ json: Record<string, unknown> }>> }[] } };
  const row = detail.execution.logs.find((l) => l.nodeId === nodeId && l.output);
  return row?.output?.['main']?.[0]?.json;
}

async function until(pred: () => boolean, tries = 200): Promise<void> {
  for (let i = 0; i < tries; i++) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('condition not reached in time');
}

describe('🎬 Phase-J demo e2e (J-T3) — one tg.trigger node, two run modes', () => {
  let w: World;
  beforeEach(async () => { w = await makeWorld(); });
  afterEach(async () => { await w.engine.gateway.stopAll(); await w.app.close(); });

  it('TEST mode: "Test run" arms the tg.trigger → the next live message captures it → the sender data reached node 2', async () => {
    const botId = await createBot(w);
    const flowId = await createActiveFlow(w, botId);

    // ── the editor's "Test run" arms the flow's tg.trigger for ONE capture ──
    const armRes = await w.app.inject({ method: 'POST', url: `/api/flows/${flowId}/test-listen`, cookies: w.cookie });
    expect(armRes.statusCode).toBe(201);
    const armed = armRes.json() as TestListenArmed;
    expect(armed.nodeId).toBe('trig');

    // still listening — nothing captured yet
    expect(await status(w, flowId, armed.executionId)).toBe('listening');

    // ── the operator sends ONE real message to the bot (through the gateway) ──
    // dispatch awaits the full router → resume → run, so the capture is complete.
    await w.engine.gateway.dispatch(botId, textUpdate('قهرمان', 555, 'سارا'));

    // ── polling now reports the capture ──
    expect(await status(w, flowId, armed.executionId)).toBe('captured');

    // ── node 2 (data.setFields) ran with the REAL captured sender data ──
    const seen = await nodeOutput(w, flowId, 'seen');
    expect(seen).toBeTruthy();
    expect(seen!['sawUserId']).toBe(555);
    expect(seen!['sawName']).toBe('سارا');
    expect(seen!['sawText']).toBe('قهرمان');
  });

  it('PRODUCTION mode: the SAME tg.trigger node fires on a live message (no arming) → bot replies to the sender', async () => {
    const botId = await createBot(w);
    await createActiveFlow(w, botId);

    // no test-listen arm — a plain inbound message fires the live flow at once,
    // bound to the sender's chat, so tg.sendMessage actually replies.
    await w.engine.gateway.dispatch(botId, textUpdate('بدون_تست', 555, 'رضا'));

    await until(() => sentTexts(w).length > 0);
    expect(sentTexts(w).at(-1)).toBe('سلام رضا! گفتی: بدون_تست');
    const lastSend = w.sent.filter((m) => m.method === 'sendMessage').at(-1)!;
    expect(lastSend.payload['chat_id']).toBe(7); // delivered to the sender's chat
  });

  it('a non-matching update does NOT consume the arming (it keeps listening until a match)', async () => {
    const botId = await createBot(w);
    // a flow that only listens for the /start command
    const flowId = await createActiveFlow(w, botId, {
      nodes: [
        { id: 'trig', type: 'tg.trigger', params: { event: 'command', command: 'start' }, position: { x: 0, y: 0 }, disabled: false },
        { id: 'seen', type: 'data.setFields', params: { fields: [{ target: 'json', name: 'cmd', value: '{{ $json.command }}', op: 'set' }] }, position: { x: 220, y: 0 }, disabled: false },
      ],
      edges: [{ id: 'e1', from: { node: 'trig', port: 'main' }, to: { node: 'seen', port: 'main' } }],
    });

    const armed = (
      await w.app.inject({ method: 'POST', url: `/api/flows/${flowId}/test-listen`, cookies: w.cookie })
    ).json() as TestListenArmed;

    // a plain text message does not match `command:start` → arming untouched
    await w.engine.gateway.dispatch(botId, textUpdate('یک پیام معمولی'));
    expect(await status(w, flowId, armed.executionId)).toBe('listening');

    // the matching /start command now captures it
    await w.engine.gateway.dispatch(botId, commandUpdate('/start'));
    expect(await status(w, flowId, armed.executionId)).toBe('captured');
    expect((await nodeOutput(w, flowId, 'seen'))!['cmd']).toBe('start');
  });
});
