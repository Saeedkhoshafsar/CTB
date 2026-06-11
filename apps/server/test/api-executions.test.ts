/**
 * P2-T3.5 — executions read API over the REAL wired engine + SQLite.
 *
 * A real conversation (sample-flow fixture via gateway.dispatch) produces
 * executions + exec_logs rows; the API must expose them with the per-step
 * input/output FlowItem snapshots the editor's node detail view consumes.
 */
import { readFileSync } from 'node:fs';
import { destroyDefaultSandboxPool } from '@ctb/sandbox';
import { FlowGraphSchema, type ExecLogEntry, type ExecutionDetail, type ExecutionSummary } from '@ctb/shared';
import type { FastifyInstance } from 'fastify';
import type { Update, UserFromGetMe } from 'grammy/types';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SESSION_COOKIE, buildApp } from '../src/app';
import { openDb, schema, type Db } from '../src/db/index';
import { runMigrations } from '../src/db/migrate';
import { wireEngine, type Engine } from '../src/engine/wire';
import { encrypt, deriveKey } from '../src/lib/crypto';
import { loadEnv } from '../src/lib/env';

const SECRET = 'devsecret0123456';
const TOKEN = '123456789:AAEexampletokenexampletokenexample';
const GRAPH = FlowGraphSchema.parse(
  JSON.parse(
    readFileSync(new URL('../../../packages/shared/test/fixtures/sample-flow.json', import.meta.url), 'utf8'),
  ),
);
const BOT_INFO: UserFromGetMe = {
  id: 42, is_bot: true, first_name: 'TestBot', username: 'test_bot',
  can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: false,
  can_connect_to_business: false, has_main_web_app: false, can_manage_bots: false,
  has_topics_enabled: false, allows_users_to_create_topics: false,
};

afterAll(async () => {
  await destroyDefaultSandboxPool();
});

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
  const app = buildApp({ env, db, engine, logger: false, editorDistDir: '/nonexistent' });

  // seed an active bot + flow, register with a swallow-everything fake transport
  const now = new Date().toISOString();
  db.insert(schema.bots).values({
    id: 'b1', name: 'Demo', tokenEnc: encrypt(TOKEN, deriveKey(SECRET)),
    mode: 'polling', status: 'active', settings: {}, createdAt: now, updatedAt: now,
  }).run();
  db.insert(schema.flows).values({
    id: 'f1', botId: 'b1', name: 'خوش‌آمد', status: 'active',
    graph: GRAPH, version: 1, updatedAt: now,
  }).run();
  engine.gateway.registerBot('b1', TOKEN, {
    botInfo: BOT_INFO,
    callApi: async () => ({ message_id: 1 }),
  });

  const login = await app.inject({
    method: 'POST', url: '/api/auth/login',
    payload: { username: 'admin', password: 'hunter2hunter2' },
  });
  const cookie = { [SESSION_COOKIE]: login.cookies.find((c) => c.name === SESSION_COOKIE)!.value };
  return { app, db, engine, cookie };
}

let updateId = 0;
function tgUpdate(text: string, chatId = 7): Update {
  updateId += 1;
  return {
    update_id: updateId,
    message: {
      message_id: updateId * 10,
      date: 0,
      from: { id: 900, is_bot: false, first_name: 'علی' },
      chat: { id: chatId, type: 'private', first_name: 'علی' },
      text,
    },
  } as unknown as Update;
}

describe('executions API (P2-T3.5)', () => {
  let w: World;
  beforeEach(async () => { w = await makeWorld(); });
  afterEach(async () => { await w.engine.gateway.stopAll(); await w.app.close(); });

  it('requires auth (401 without cookie)', async () => {
    const res = await w.app.inject({ method: 'GET', url: '/api/executions' });
    expect(res.statusCode).toBe(401);
  });

  it('lists executions filtered by flowId/status; detail carries step I/O', async () => {
    // run the demo conversation to completion: /start → name → age
    await w.engine.gateway.dispatch('b1', tgUpdate('/start'));
    await w.engine.gateway.dispatch('b1', tgUpdate('علی'));
    await w.engine.gateway.dispatch('b1', tgUpdate('۳۵'));

    const list = await w.app.inject({
      method: 'GET', url: '/api/executions?flowId=f1', cookies: w.cookie,
    });
    expect(list.statusCode).toBe(200);
    const { executions } = list.json() as { executions: ExecutionSummary[] };
    expect(executions).toHaveLength(1);
    expect(executions[0]!.status).toBe('done');
    expect(executions[0]!.chatId).toBe(7);

    // status filter — nothing waiting anymore
    const waiting = await w.app.inject({
      method: 'GET', url: '/api/executions?flowId=f1&status=waiting', cookies: w.cookie,
    });
    expect((waiting.json() as { executions: unknown[] }).executions).toHaveLength(0);

    // detail: per-node "executed" rows expose input/output FlowItems
    const det = await w.app.inject({
      method: 'GET', url: `/api/executions/${executions[0]!.id}`, cookies: w.cookie,
    });
    expect(det.statusCode).toBe(200);
    const { execution } = det.json() as { execution: ExecutionDetail };
    expect(execution.logs.length).toBeGreaterThan(0);

    const executed = execution.logs.filter(
      (l: ExecLogEntry) => l.input !== null && l.nodeId !== null,
    );
    // sample flow executes ≥4 nodes (trigger, ask-name, ask-age, if, greet…)
    expect(executed.length).toBeGreaterThanOrEqual(4);
    for (const row of executed) {
      expect(Array.isArray(row.input)).toBe(true);
      for (const it2 of row.input!) expect(it2).toHaveProperty('json');
    }
    // the IF node routed the adult answer (۳۵→35) out its "true" port
    const ifRow = executed.find((l) => l.nodeId === 'check_adult');
    expect(ifRow).toBeTruthy();
    expect(ifRow!.output && Object.keys(ifRow!.output)).toContain('true');
  });

  it('waiting execution appears in the list with status=waiting', async () => {
    await w.engine.gateway.dispatch('b1', tgUpdate('/start', 99));
    const res = await w.app.inject({
      method: 'GET', url: '/api/executions?status=waiting', cookies: w.cookie,
    });
    const { executions } = res.json() as { executions: ExecutionSummary[] };
    expect(executions).toHaveLength(1);
    expect(executions[0]!.chatId).toBe(99);
  });

  it('detail 404 on unknown id; list 400 on bad status', async () => {
    const nf = await w.app.inject({
      method: 'GET', url: '/api/executions/ghost', cookies: w.cookie,
    });
    expect(nf.statusCode).toBe(404);
    const bad = await w.app.inject({
      method: 'GET', url: '/api/executions?status=banana', cookies: w.cookie,
    });
    expect(bad.statusCode).toBe(400);
  });

  // ── cancel (P2-T5) ─────────────────────────────────────────────────────────

  it('cancels a waiting execution: status flips, wait cleared, audit log row, chat freed', async () => {
    await w.engine.gateway.dispatch('b1', tgUpdate('/start', 55)); // → waiting for name
    const list = await w.app.inject({
      method: 'GET', url: '/api/executions?status=waiting', cookies: w.cookie,
    });
    const { executions } = list.json() as { executions: ExecutionSummary[] };
    expect(executions).toHaveLength(1);
    const id = executions[0]!.id;

    const res = await w.app.inject({
      method: 'POST', url: `/api/executions/${id}/cancel`, cookies: w.cookie,
    });
    expect(res.statusCode).toBe(200);
    const { execution } = res.json() as { ok: true; execution: ExecutionSummary };
    expect(execution.status).toBe('canceled');

    // detail: wait cleared + audit row recorded
    const det = await w.app.inject({
      method: 'GET', url: `/api/executions/${id}`, cookies: w.cookie,
    });
    const { execution: detail } = det.json() as { execution: ExecutionDetail };
    expect(detail.status).toBe('canceled');
    expect(detail.wait).toBeNull();
    expect(detail.logs.some((l) => l.message === 'canceled via inspector')).toBe(true);

    // the chat is genuinely free: a fresh /start opens a NEW execution
    // (the canceled one must not swallow the reply — I4 semantics)
    await w.engine.gateway.dispatch('b1', tgUpdate('/start', 55));
    const after = await w.app.inject({
      method: 'GET', url: '/api/executions?status=waiting', cookies: w.cookie,
    });
    const waiting = (after.json() as { executions: ExecutionSummary[] }).executions;
    expect(waiting).toHaveLength(1);
    expect(waiting[0]!.id).not.toBe(id);
  });

  it('cancel on a finished execution → 409; unknown id → 404; no auth → 401', async () => {
    // finish a conversation
    await w.engine.gateway.dispatch('b1', tgUpdate('/start'));
    await w.engine.gateway.dispatch('b1', tgUpdate('علی'));
    await w.engine.gateway.dispatch('b1', tgUpdate('۳۵'));
    const list = await w.app.inject({
      method: 'GET', url: '/api/executions?status=done', cookies: w.cookie,
    });
    const done = (list.json() as { executions: ExecutionSummary[] }).executions[0]!;

    const conflict = await w.app.inject({
      method: 'POST', url: `/api/executions/${done.id}/cancel`, cookies: w.cookie,
    });
    expect(conflict.statusCode).toBe(409);
    expect((conflict.json() as { status: string }).status).toBe('done');

    const nf = await w.app.inject({
      method: 'POST', url: '/api/executions/ghost/cancel', cookies: w.cookie,
    });
    expect(nf.statusCode).toBe(404);

    const noAuth = await w.app.inject({
      method: 'POST', url: `/api/executions/${done.id}/cancel`,
    });
    expect(noAuth.statusCode).toBe(401);
  });
});
