/**
 * J-T1 (Report B) — live-trigger test run HTTP API:
 *   POST   /api/flows/:id/test-listen          → arm a listen
 *   GET    /api/flows/:id/test-listen/status    → poll the arming
 *   DELETE /api/flows/:id/test-listen           → disarm (Cancel button)
 *
 * Drives the REAL wired engine + in-memory SQLite over the panel HTTP routes
 * the editor uses, and proves:
 *   1. arming a flow with a `tg.trigger` returns 201 + parks a durable listening
 *      execution (status mapped to `listening`);
 *   2. a matching live update through the gateway captures it → status flips to
 *      `captured` and the sender data reached the downstream node;
 *   3. canceling disarms the listen (status → expired);
 *   4. a flow with no enabled tg.trigger → 422 no_telegram_trigger;
 *   5. unknown flow → 404; missing executionId on status → 400.
 *
 * Harness mirrored from api-flows-run-node.test.ts.
 */
import type { FlowPublic, TestListenArmed, TestListenStatus } from '@ctb/shared';
import type { FastifyInstance } from 'fastify';
import type { Update, UserFromGetMe } from 'grammy/types';
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
    await w.app.inject({ method: 'POST', url: '/api/bots', cookies: w.cookie, payload: { name, token: TOKEN } })
  ).json() as { bot: { id: string } };
  return bot.id;
}

/** A flow: tg.trigger(any_message) → data.setFields (records the sender id). */
function listenGraph() {
  return {
    nodes: [
      { id: 'trig', type: 'tg.trigger', params: { event: 'any_message' }, position: { x: 0, y: 0 }, disabled: false },
      {
        id: 'set', type: 'data.setFields',
        params: { fields: [{ target: 'json', name: 'sawUser', value: '{{ $json.user.id }}', op: 'set' }] },
        position: { x: 200, y: 0 }, disabled: false,
      },
    ],
    edges: [{ id: 'e1', from: { node: 'trig', port: 'main' }, to: { node: 'set', port: 'main' } }],
  };
}

/** A flow with only a manual trigger → no enabled tg.trigger. */
function manualOnlyGraph() {
  return {
    nodes: [
      { id: 'm', type: 'flow.manualTrigger', params: {}, position: { x: 0, y: 0 }, disabled: false },
    ],
    edges: [],
  };
}

async function createFlow(w: World, botId: string, graph: unknown): Promise<FlowPublic> {
  return (
    await w.app.inject({ method: 'POST', url: '/api/flows', cookies: w.cookie, payload: { botId, name: 'f', graph } })
  ).json().flow as FlowPublic;
}

function textUpdate(text: string, chatId = 7, updateId = 1): Update {
  return {
    update_id: updateId,
    message: {
      message_id: 10, date: 0,
      from: { id: 555, is_bot: false, first_name: 'سارا' },
      chat: { id: chatId, type: 'private', first_name: 'سارا' },
      text,
    },
  } as unknown as Update;
}

describe('test-listen API — live-trigger test run (J-T1)', () => {
  let w: World;
  beforeEach(async () => { w = await makeWorld(); });
  afterEach(async () => { await w.engine.gateway.stopAll(); await w.app.close(); });

  it('arms a tg.trigger (201) → status listening; a matching update captures it; sender data flows downstream', async () => {
    const botId = await createBot(w);
    const flow = await createFlow(w, botId, listenGraph());

    const armRes = await w.app.inject({
      method: 'POST', url: `/api/flows/${flow.id}/test-listen`, cookies: w.cookie,
    });
    expect(armRes.statusCode).toBe(201);
    const armed = armRes.json() as TestListenArmed;
    expect(armed.flowId).toBe(flow.id);
    expect(armed.botId).toBe(botId);
    expect(armed.nodeId).toBe('trig');

    // poll → still listening
    const s1 = (
      await w.app.inject({ method: 'GET', url: `/api/flows/${flow.id}/test-listen/status?executionId=${armed.executionId}`, cookies: w.cookie })
    ).json() as TestListenStatus;
    expect(s1.state).toBe('listening');

    // a live update arrives through the router (via the engine router directly)
    await w.engine.router.handle(
      (await import('../src/telegram/normalize')).normalizeUpdate(botId, textUpdate('سلام'))!,
    );

    // status flips to captured
    const s2 = (
      await w.app.inject({ method: 'GET', url: `/api/flows/${flow.id}/test-listen/status?executionId=${armed.executionId}`, cookies: w.cookie })
    ).json() as TestListenStatus;
    expect(s2.state).toBe('captured');

    // the captured run reached the setFields node with the real sender id
    const list = (
      await w.app.inject({ method: 'GET', url: `/api/executions?flowId=${flow.id}&limit=1`, cookies: w.cookie })
    ).json() as { executions: { id: string }[] };
    const detail = (
      await w.app.inject({ method: 'GET', url: `/api/executions/${list.executions[0]!.id}`, cookies: w.cookie })
    ).json() as { execution: { logs: { nodeId: string | null; output?: Record<string, Array<{ json: Record<string, unknown> }>> }[] } };
    const setOut = detail.execution.logs.find((l) => l.nodeId === 'set' && l.output);
    expect(setOut!.output!.main![0]!.json.sawUser).toBe(555);
  });

  it('cancel disarms the listen → status expired', async () => {
    const botId = await createBot(w);
    const flow = await createFlow(w, botId, listenGraph());
    const armed = (
      await w.app.inject({ method: 'POST', url: `/api/flows/${flow.id}/test-listen`, cookies: w.cookie })
    ).json() as TestListenArmed;

    const cancel = await w.app.inject({
      method: 'DELETE', url: `/api/flows/${flow.id}/test-listen?executionId=${armed.executionId}`, cookies: w.cookie,
    });
    expect(cancel.statusCode).toBe(200);

    const s = (
      await w.app.inject({ method: 'GET', url: `/api/flows/${flow.id}/test-listen/status?executionId=${armed.executionId}`, cookies: w.cookie })
    ).json() as TestListenStatus;
    expect(s.state).toBe('expired');
  });

  it('422 no_telegram_trigger for a flow without an enabled tg.trigger', async () => {
    const botId = await createBot(w);
    const flow = await createFlow(w, botId, manualOnlyGraph());
    const res = await w.app.inject({
      method: 'POST', url: `/api/flows/${flow.id}/test-listen`, cookies: w.cookie,
    });
    expect(res.statusCode).toBe(422);
    expect((res.json() as { error: string }).error).toBe('no_telegram_trigger');
  });

  it('404 not_found for an unknown flow; 400 when status lacks executionId', async () => {
    const botId = await createBot(w);
    const flow = await createFlow(w, botId, listenGraph());
    const r404 = await w.app.inject({
      method: 'POST', url: '/api/flows/does-not-exist/test-listen', cookies: w.cookie,
    });
    expect(r404.statusCode).toBe(404);

    const r400 = await w.app.inject({
      method: 'GET', url: `/api/flows/${flow.id}/test-listen/status`, cookies: w.cookie,
    });
    expect(r400.statusCode).toBe(400);
  });

  it('status of an unknown executionId → gone', async () => {
    const botId = await createBot(w);
    const flow = await createFlow(w, botId, listenGraph());
    const s = (
      await w.app.inject({ method: 'GET', url: `/api/flows/${flow.id}/test-listen/status?executionId=nope`, cookies: w.cookie })
    ).json() as TestListenStatus;
    expect(s.state).toBe('gone');
  });
});
