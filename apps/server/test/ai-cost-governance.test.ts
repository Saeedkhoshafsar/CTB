/**
 * PD-T2 — agent cost governance: the per-run `ctx.ai.chat` wrapper ENFORCES the
 * bot's daily AI budget (fail-closed) and METERS reported usage into the
 * `ai_usage` ledger, surfaced by the panel API. Exercised end-to-end through a
 * real wired engine + in-memory DB with an INJECTED fetch (no network).
 *
 * Asserts:
 *   - a successful llmChat writes one ai_usage row (today + all-time totals climb,
 *     per-credential breakdown aggregates),
 *   - PUT /ai-budget persists into bots.settings.aiBudget and GET /ai-usage echoes it,
 *   - once the daily call cap is hit, the next run is refused BEFORE the provider
 *     call (fail-closed: no extra fetch, run errors with a clear message),
 *   - the daily token cap behaves the same way,
 *   - `0` caps mean unlimited.
 */
import type { FastifyInstance } from 'fastify';
import type { UserFromGetMe } from 'grammy/types';
import { afterEach, describe, expect, it } from 'vitest';
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

interface FetchLog { url: string }
/** A counting fake fetch returning a fixed chat-completions body with usage. */
function makeFakeFetch(usage: { prompt: number; completion: number; total: number }, log: FetchLog[]): typeof fetch {
  return (async (input: unknown) => {
    log.push({ url: String(input) });
    const text = JSON.stringify({
      choices: [{ message: { content: 'Hi.' } }],
      usage: { prompt_tokens: usage.prompt, completion_tokens: usage.completion, total_tokens: usage.total },
      model: 'gpt-4o-mini',
    });
    return { status: 200, async text() { return text; } } as Response;
  }) as unknown as typeof fetch;
}

interface World {
  app: FastifyInstance;
  db: Db;
  engine: Engine;
  cookie: { [k: string]: string };
  fetchLog: FetchLog[];
}

async function makeWorld(usage = { prompt: 11, completion: 2, total: 13 }): Promise<World> {
  const env = loadEnv({ CTB_SECRET: SECRET, CTB_ADMIN_PASS: 'hunter2hunter2', NODE_ENV: 'test' } as NodeJS.ProcessEnv);
  const { db } = openDb(':memory:');
  runMigrations(db);
  const fetchLog: FetchLog[] = [];
  const engine = wireEngine({ db, ctbSecret: SECRET, fetchImpl: makeFakeFetch(usage, fetchLog), expressionBudgetMs: 5_000 });
  const app = buildApp({
    env, db, engine, logger: false, editorDistDir: '/nonexistent',
    botRegisterOpts: () => ({ botInfo: BOT_INFO, callApi: async () => ({ message_id: 1 }) }),
  });
  const login = await app.inject({
    method: 'POST', url: '/api/auth/login',
    payload: { username: 'admin', password: 'hunter2hunter2' },
  });
  const cookie = { [SESSION_COOKIE]: login.cookies.find((c) => c.name === SESSION_COOKIE)!.value };
  return { app, db, engine, cookie, fetchLog };
}

async function createBot(w: World): Promise<string> {
  const res = await w.app.inject({ method: 'POST', url: '/api/bots', cookies: w.cookie, payload: { name: 'bot', token: TOKEN } });
  expect(res.statusCode).toBe(201);
  return res.json().bot.id as string;
}

async function createCredential(w: World, name = 'llm'): Promise<string> {
  const res = await w.app.inject({
    method: 'POST', url: '/api/credentials', cookies: w.cookie,
    payload: { name, data: { type: 'openAiApi', baseUrl: 'https://api.example.com/v1', apiKey: `sk-${name}` } },
  });
  expect(res.statusCode).toBe(201);
  return res.json().credential.id as string;
}

async function createFlow(w: World, botId: string, credentialId: string): Promise<string> {
  const graph = {
    nodes: [
      { id: 'trig', type: 'flow.manualTrigger', params: { sample: '{}' } },
      {
        id: 'llm', type: 'ai.llmChat',
        params: { credentialId, model: 'gpt-4o-mini', system_prompt: 'be terse', user_prompt: 'hi', save_as: 'ai' },
      },
    ],
    edges: [{ id: 'e1', from: { node: 'trig', port: 'main' }, to: { node: 'llm', port: 'main' } }],
  };
  const res = await w.app.inject({ method: 'POST', url: '/api/flows', cookies: w.cookie, payload: { botId, name: 'ai flow', graph } });
  expect(res.statusCode).toBe(201);
  return res.json().flow.id as string;
}

async function run(w: World, flowId: string): Promise<{ status: string; error?: string }> {
  const res = await w.app.inject({ method: 'POST', url: `/api/flows/${flowId}/run`, cookies: w.cookie });
  expect(res.statusCode).toBe(200);
  return res.json();
}

async function usageSummary(w: World, botId: string) {
  const res = await w.app.inject({ method: 'GET', url: `/api/bots/${botId}/ai-usage`, cookies: w.cookie });
  expect(res.statusCode).toBe(200);
  return res.json().usage as {
    budget: { maxTokensPerRun: number; maxTokensPerDay: number; maxCallsPerDay: number };
    today: { calls: number; totalTokens: number };
    allTime: { calls: number; totalTokens: number };
    byCredential: { credentialId: string; calls: number; totalTokens: number }[];
  };
}

async function setBudget(w: World, botId: string, budget: Record<string, number>): Promise<number> {
  const res = await w.app.inject({ method: 'PUT', url: `/api/bots/${botId}/ai-budget`, cookies: w.cookie, payload: budget });
  return res.statusCode;
}

describe('AI cost governance (PD-T2)', () => {
  let w: World;
  afterEach(async () => { await w.engine.gateway.stopAll(); await w.app.close(); });

  it('meters one ai_usage row per successful llmChat and surfaces it in the panel', async () => {
    w = await makeWorld();
    const botId = await createBot(w);
    const credId = await createCredential(w);
    const flowId = await createFlow(w, botId, credId);

    // No usage before any run.
    let s = await usageSummary(w, botId);
    expect(s.today).toEqual({ calls: 0, totalTokens: 0 });
    expect(s.byCredential).toEqual([]);

    expect((await run(w, flowId)).status).toBe('done');
    expect((await run(w, flowId)).status).toBe('done');

    s = await usageSummary(w, botId);
    expect(s.today).toEqual({ calls: 2, totalTokens: 26 });
    expect(s.allTime).toEqual({ calls: 2, totalTokens: 26 });
    expect(s.byCredential).toHaveLength(1);
    expect(s.byCredential[0]).toMatchObject({ credentialId: credId, calls: 2, totalTokens: 26 });
  });

  it('aggregates spend per credential', async () => {
    w = await makeWorld();
    const botId = await createBot(w);
    const credA = await createCredential(w, 'a');
    const credB = await createCredential(w, 'b');
    const flowA = await createFlow(w, botId, credA);
    const flowB = await createFlow(w, botId, credB);

    await run(w, flowA);
    await run(w, flowB);
    await run(w, flowB);

    const s = await usageSummary(w, botId);
    expect(s.today.calls).toBe(3);
    // Ordered most-spent first; credB has 2 calls (26 tokens) vs credA 1 (13).
    expect(s.byCredential.map((c) => c.credentialId)).toEqual([credB, credA]);
    expect(s.byCredential[0]).toMatchObject({ credentialId: credB, calls: 2, totalTokens: 26 });
    expect(s.byCredential[1]).toMatchObject({ credentialId: credA, calls: 1, totalTokens: 13 });
  });

  it('PUT /ai-budget persists into settings and GET /ai-usage echoes it', async () => {
    w = await makeWorld();
    const botId = await createBot(w);
    expect(await setBudget(w, botId, { maxTokensPerRun: 100, maxTokensPerDay: 500, maxCallsPerDay: 5 })).toBe(200);
    const s = await usageSummary(w, botId);
    expect(s.budget).toEqual({ maxTokensPerRun: 100, maxTokensPerDay: 500, maxCallsPerDay: 5 });

    // The bot's settings JSON now carries aiBudget.
    const bot = (await w.app.inject({ method: 'GET', url: `/api/bots/${botId}`, cookies: w.cookie })).json().bot;
    expect((bot.settings as { aiBudget?: unknown }).aiBudget).toEqual({ maxTokensPerRun: 100, maxTokensPerDay: 500, maxCallsPerDay: 5 });
  });

  it('enforces the daily CALL cap fail-closed (no extra provider call)', async () => {
    w = await makeWorld();
    const botId = await createBot(w);
    const credId = await createCredential(w);
    const flowId = await createFlow(w, botId, credId);
    await setBudget(w, botId, { maxTokensPerRun: 0, maxTokensPerDay: 0, maxCallsPerDay: 2 });

    expect((await run(w, flowId)).status).toBe('done');
    expect((await run(w, flowId)).status).toBe('done');
    expect(w.fetchLog).toHaveLength(2);

    const blocked = await run(w, flowId);
    expect(blocked.status).toBe('error');
    expect(blocked.error).toMatch(/daily call budget exceeded/i);
    // Fail-closed: the third run never reached the provider.
    expect(w.fetchLog).toHaveLength(2);
  });

  it('enforces the daily TOKEN cap fail-closed', async () => {
    w = await makeWorld({ prompt: 10, completion: 10, total: 20 });
    const botId = await createBot(w);
    const credId = await createCredential(w);
    const flowId = await createFlow(w, botId, credId);
    await setBudget(w, botId, { maxTokensPerRun: 0, maxTokensPerDay: 25, maxCallsPerDay: 0 });

    // First run spends 20 tokens (under 25) → allowed.
    expect((await run(w, flowId)).status).toBe('done');
    expect(w.fetchLog).toHaveLength(1);

    // Second run sees today(20) < 25 so it is allowed and pushes to 40; the
    // third sees 40 >= 25 → refused.
    expect((await run(w, flowId)).status).toBe('done');
    const blocked = await run(w, flowId);
    expect(blocked.status).toBe('error');
    expect(blocked.error).toMatch(/daily token budget exceeded/i);
    expect(w.fetchLog).toHaveLength(2);
  });

  it('treats 0 caps as unlimited', async () => {
    w = await makeWorld();
    const botId = await createBot(w);
    const credId = await createCredential(w);
    const flowId = await createFlow(w, botId, credId);
    await setBudget(w, botId, { maxTokensPerRun: 0, maxTokensPerDay: 0, maxCallsPerDay: 0 });
    for (let i = 0; i < 5; i++) expect((await run(w, flowId)).status).toBe('done');
    expect(w.fetchLog).toHaveLength(5);
    expect((await usageSummary(w, botId)).today.calls).toBe(5);
  });
});
