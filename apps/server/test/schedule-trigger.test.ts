/**
 * P4-T2 — Scheduler tests (schedule.trigger) over a real in-memory SQLite DB +
 * fully wired engine. The cron timing itself is croner's job; we drive the
 * Scheduler deterministically via `fire()` and assert the run side-effects,
 * plus verify `reconcile()` tracks the active-flow set.
 *
 * Covers:
 *  • reconcile arms one job per enabled schedule.trigger in an ACTIVE flow only
 *  • deactivation tears the job down (via the flows-API onFlowsChanged)
 *  • fire() on a plain schedule starts ONE chatless run (chatId null)
 *  • fire() with for_each_user fans out one run per known user, chat = tg id
 *  • the trigger item carries { now, cron, scheduled:true }
 *  • an invalid cron string is skipped (never crashes reconcile)
 */
import {
  FlowGraphSchema,
  type FlowGraph,
  type ScheduleTriggerParams,
} from '@ctb/shared';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SESSION_COOKIE, buildApp } from '../src/app';
import { openDb, type Db } from '../src/db/index';
import { executions } from '../src/db/schema';
import { runMigrations } from '../src/db/migrate';
import { wireEngine, type Engine } from '../src/engine/wire';
import { loadEnv } from '../src/lib/env';

const SECRET = 'devsecret0123456';

interface World {
  app: FastifyInstance;
  db: Db;
  engine: Engine;
  cookie: { [k: string]: string };
}

async function makeWorld(): Promise<World> {
  const env = loadEnv({
    CTB_SECRET: SECRET,
    CTB_ADMIN_PASS: 'hunter2hunter2',
    NODE_ENV: 'test',
  } as NodeJS.ProcessEnv);
  const { db } = openDb(':memory:');
  runMigrations(db);
  const engine = wireEngine({ db, ctbSecret: SECRET, expressionBudgetMs: 5_000 });
  const app = buildApp({ env, db, engine, logger: false, editorDistDir: '/nonexistent' });
  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username: 'admin', password: 'hunter2hunter2' },
  });
  const cookie = {
    [SESSION_COOKIE]: login.cookies.find((c) => c.name === SESSION_COOKIE)!.value,
  };
  return { app, db, engine, cookie };
}

/** schedule.trigger → data.setFields (records the fire so runs are observable). */
function scheduleGraph(trigger: Partial<ScheduleTriggerParams> = {}): FlowGraph {
  return FlowGraphSchema.parse({
    nodes: [
      {
        id: 'trig',
        type: 'schedule.trigger',
        params: { ...trigger },
        position: { x: 0, y: 0 },
        disabled: false,
      },
      {
        id: 'set',
        type: 'data.setFields',
        params: { fields: [{ target: 'json', name: 'ran', value: 'yes', op: 'set' }] },
        position: { x: 200, y: 0 },
        disabled: false,
      },
    ],
    edges: [{ id: 'e1', from: { node: 'trig', port: 'main' }, to: { node: 'set', port: 'main' } }],
  });
}

async function createBot(w: World): Promise<string> {
  const { bot } = (
    await w.app.inject({
      method: 'POST',
      url: '/api/bots',
      cookies: w.cookie,
      payload: { name: 'b', token: '123456789:AAEexampletokenexampletokenexample' },
    })
  ).json() as { bot: { id: string } };
  return bot.id;
}

async function createFlow(w: World, botId: string, graph: FlowGraph): Promise<string> {
  const { flow } = (
    await w.app.inject({
      method: 'POST',
      url: '/api/flows',
      cookies: w.cookie,
      payload: { botId, name: 'sched flow', graph },
    })
  ).json() as { flow: { id: string } };
  return flow.id;
}

async function activate(w: World, flowId: string): Promise<number> {
  const res = await w.app.inject({
    method: 'POST',
    url: `/api/flows/${flowId}/activate`,
    cookies: w.cookie,
  });
  return res.statusCode;
}

function runsFor(w: World, flowId: string) {
  return w.db.select().from(executions).where(eq(executions.flowId, flowId)).all();
}

describe('Scheduler (P4-T2)', () => {
  let w: World;
  beforeEach(async () => {
    w = await makeWorld();
  });
  afterEach(async () => {
    w.engine.scheduler.stop();
    await w.engine.gateway.stopAll();
    await w.app.close();
  });

  it('arms one cron job per enabled schedule.trigger in an ACTIVE flow only', async () => {
    const botId = await createBot(w);
    const flowId = await createFlow(w, botId, scheduleGraph({ cron: '0 9 * * *' }));

    // Draft → not scheduled yet.
    await w.engine.scheduler.reconcile();
    expect(w.engine.scheduler.jobCount).toBe(0);

    // Activate → the flows API fires onFlowsChanged → reconcile arms the job.
    expect(await activate(w, flowId)).toBe(200);
    await w.engine.scheduler.reconcile();
    expect(w.engine.scheduler.jobCount).toBe(1);
  });

  it('tears the job down when the flow is deactivated', async () => {
    const botId = await createBot(w);
    const flowId = await createFlow(w, botId, scheduleGraph());
    await activate(w, flowId);
    await w.engine.scheduler.reconcile();
    expect(w.engine.scheduler.jobCount).toBe(1);

    await w.app.inject({
      method: 'POST',
      url: `/api/flows/${flowId}/deactivate`,
      cookies: w.cookie,
    });
    await w.engine.scheduler.reconcile();
    expect(w.engine.scheduler.jobCount).toBe(0);
  });

  it('fire() starts ONE chatless run (chatId null) for a plain schedule', async () => {
    const botId = await createBot(w);
    const flowId = await createFlow(w, botId, scheduleGraph({ cron: '* * * * *' }));
    await activate(w, flowId);
    await w.engine.scheduler.reconcile();

    await w.engine.scheduler.fire(botId, flowId, 'trig');

    const runs = runsFor(w, flowId);
    expect(runs.length).toBe(1);
    expect(runs[0]!.chatId).toBeNull();
    expect(runs[0]!.status).toBe('done');
  });

  it('drives the whole flow from the trigger item (both nodes step)', async () => {
    const botId = await createBot(w);
    const flowId = await createFlow(w, botId, scheduleGraph({ cron: '15 8 * * *' }));
    await activate(w, flowId);
    await w.engine.scheduler.fire(botId, flowId, 'trig');

    const runs = runsFor(w, flowId);
    expect(runs.length).toBe(1);
    // The seed item (built by the Scheduler with now/cron/scheduled) flowed
    // through trigger → data.setFields: a completed run that stepped both nodes.
    expect(runs[0]!.status).toBe('done');
    const state = runs[0]!.state as { steps?: number };
    expect(state.steps).toBe(2);
  });

  it('for_each_user fans out one run per known user, chat = the tg id', async () => {
    const botId = await createBot(w);
    const flowId = await createFlow(
      w,
      botId,
      scheduleGraph({ cron: '0 9 * * *', for_each_user: true, rate_per_min: 0 }),
    );
    await activate(w, flowId);

    // Three known users for this bot.
    w.engine.userStore.touch(botId, 1001, { firstName: 'A' });
    w.engine.userStore.touch(botId, 1002, { firstName: 'B' });
    w.engine.userStore.touch(botId, 1003, { firstName: 'C' });

    await w.engine.scheduler.fire(botId, flowId, 'trig');

    const runs = runsFor(w, flowId);
    expect(runs.length).toBe(3);
    const chatIds = runs.map((r) => r.chatId).sort((a, b) => (a ?? 0) - (b ?? 0));
    expect(chatIds).toEqual([1001, 1002, 1003]);
    // every fan-out run carries the user's id and finished.
    for (const r of runs) {
      expect(r.userId).toBe(String(r.chatId));
      expect(r.status).toBe('done');
    }
  });

  it('for_each_user with no known users starts nothing', async () => {
    const botId = await createBot(w);
    const flowId = await createFlow(
      w,
      botId,
      scheduleGraph({ for_each_user: true, rate_per_min: 0 }),
    );
    await activate(w, flowId);
    await w.engine.scheduler.fire(botId, flowId, 'trig');
    expect(runsFor(w, flowId).length).toBe(0);
  });

  it('skips an invalid cron string without crashing reconcile', async () => {
    const botId = await createBot(w);
    // Activation validates params (schema), not cron syntax — a syntactically
    // valid string that croner rejects must be skipped, not throw.
    const flowId = await createFlow(w, botId, scheduleGraph({ cron: 'not-a-cron' }));
    await activate(w, flowId);
    await expect(w.engine.scheduler.reconcile()).resolves.toBeUndefined();
    expect(w.engine.scheduler.jobCount).toBe(0);
  });
});
