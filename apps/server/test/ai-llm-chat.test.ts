/**
 * P5-T1 — server side of ai.llmChat: the `makeAi` capability wired into the
 * engine, exercised end-to-end through a real wired engine + in-memory DB with
 * an INJECTED fetch (no network).
 *
 * We create an `openAiApi` credential (encrypted at rest — I7), build a
 * flow.manualTrigger → ai.llmChat flow, run it, and assert:
 *   - the host POSTed to `${baseUrl}/chat/completions` with the right
 *     Authorization header + body (model/messages),
 *   - the decrypted key is used by the host but never surfaces in the response,
 *   - the LLM reply lands on the node's output item under `save_as`,
 *   - a non-2xx provider response fails the run honestly,
 *   - a wrong-type credential is rejected with a clear error.
 */
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

/** A recording fake fetch. Returns a scripted chat-completions response. */
interface FetchLog {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}
function makeFakeFetch(
  resp: { status: number; body: unknown },
  log: FetchLog[],
): typeof fetch {
  return (async (input: unknown, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[k.toLowerCase()] = v;
    }
    log.push({
      url: String(input),
      method: init?.method ?? 'GET',
      headers,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    const text = JSON.stringify(resp.body);
    return {
      status: resp.status,
      async text() {
        return text;
      },
    } as Response;
  }) as unknown as typeof fetch;
}

interface World {
  app: FastifyInstance;
  db: Db;
  engine: Engine;
  cookie: { [k: string]: string };
  fetchLog: FetchLog[];
}

async function makeWorld(resp: { status: number; body: unknown }): Promise<World> {
  const env = loadEnv({ CTB_SECRET: SECRET, CTB_ADMIN_PASS: 'hunter2hunter2', NODE_ENV: 'test' } as NodeJS.ProcessEnv);
  const { db } = openDb(':memory:');
  runMigrations(db);
  const fetchLog: FetchLog[] = [];
  const engine = wireEngine({ db, ctbSecret: SECRET, fetchImpl: makeFakeFetch(resp, fetchLog), expressionBudgetMs: 5_000 });
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
  const res = await w.app.inject({
    method: 'POST', url: '/api/bots', cookies: w.cookie, payload: { name: 'bot', token: TOKEN },
  });
  expect(res.statusCode).toBe(201);
  return res.json().bot.id as string;
}

async function createCredential(w: World, data: unknown): Promise<string> {
  const res = await w.app.inject({
    method: 'POST', url: '/api/credentials', cookies: w.cookie, payload: { name: 'llm', data },
  });
  expect(res.statusCode).toBe(201);
  return res.json().credential.id as string;
}

async function createFlow(w: World, botId: string, graph: unknown): Promise<string> {
  const res = await w.app.inject({
    method: 'POST', url: '/api/flows', cookies: w.cookie, payload: { botId, name: 'ai flow', graph },
  });
  expect(res.statusCode).toBe(201);
  return res.json().flow.id as string;
}

function aiFlowGraph(credentialId: string) {
  return {
    nodes: [
      { id: 'trig', type: 'flow.manualTrigger', params: { sample: '{}' } },
      {
        id: 'llm',
        type: 'ai.llmChat',
        params: {
          credentialId,
          model: 'gpt-4o-mini',
          system_prompt: 'You are terse.',
          user_prompt: 'Say hi',
          temperature: 0.2,
          save_as: 'ai',
        },
      },
    ],
    edges: [{ id: 'e1', from: { node: 'trig', port: 'main' }, to: { node: 'llm', port: 'main' } }],
  };
}

const OK_BODY = {
  choices: [{ message: { content: 'Hi.' } }],
  usage: { prompt_tokens: 11, completion_tokens: 2, total_tokens: 13 },
  model: 'gpt-4o-mini',
};

describe('ai.llmChat via wired engine (P5-T1)', () => {
  let w: World;
  afterEach(async () => { await w.engine.gateway.stopAll(); await w.app.close(); });

  it('POSTs to /chat/completions with bearer auth + body, and merges the reply', async () => {
    w = await makeWorld({ status: 200, body: OK_BODY });
    const botId = await createBot(w);
    const credId = await createCredential(w, {
      type: 'openAiApi', baseUrl: 'https://api.example.com/v1', apiKey: 'sk-secret-xyz',
    });
    const flowId = await createFlow(w, botId, aiFlowGraph(credId));

    const res = await w.app.inject({ method: 'POST', url: `/api/flows/${flowId}/run`, cookies: w.cookie });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('done');

    // The host hit the OpenAI-compatible endpoint exactly once.
    expect(w.fetchLog).toHaveLength(1);
    const call = w.fetchLog[0]!;
    expect(call.url).toBe('https://api.example.com/v1/chat/completions');
    expect(call.method).toBe('POST');
    expect(call.headers.authorization).toBe('Bearer sk-secret-xyz');
    expect(call.headers['content-type']).toBe('application/json');
    const reqBody = call.body as { model: string; temperature: number; messages: unknown[] };
    expect(reqBody.model).toBe('gpt-4o-mini');
    expect(reqBody.temperature).toBe(0.2);
    expect(reqBody.messages).toEqual([
      { role: 'system', content: 'You are terse.' },
      { role: 'user', content: 'Say hi' },
    ]);

    // The secret never appears in the run response (I7).
    expect(JSON.stringify(body)).not.toContain('sk-secret-xyz');

    // The reply + usage landed on the node output.
    const detail = await w.app.inject({
      method: 'GET', url: `/api/executions/${body.executionId}`, cookies: w.cookie,
    });
    const logs = detail.json().execution.logs as {
      nodeId: string | null;
      output: Record<string, { json: Record<string, unknown> }[]> | null;
    }[];
    const llmRow = logs.find((l) => l.nodeId === 'llm' && l.output);
    expect(llmRow).toBeTruthy();
    const outItem = llmRow!.output!.main![0]!.json as {
      ai: { reply: string; usage: { totalTokens?: number }; model?: string };
    };
    expect(outItem.ai.reply).toBe('Hi.');
    expect(outItem.ai.usage.totalTokens).toBe(13);
    expect(outItem.ai.model).toBe('gpt-4o-mini');
  });

  it('fails the run when the provider returns a non-2xx status', async () => {
    w = await makeWorld({ status: 401, body: { error: { message: 'bad key' } } });
    const botId = await createBot(w);
    const credId = await createCredential(w, {
      type: 'openAiApi', baseUrl: 'https://api.example.com/v1', apiKey: 'sk-bad',
    });
    const flowId = await createFlow(w, botId, aiFlowGraph(credId));
    const res = await w.app.inject({ method: 'POST', url: `/api/flows/${flowId}/run`, cookies: w.cookie });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('error');
    expect(body.error).toMatch(/HTTP 401/);
  });

  it('rejects a credential that is not an openAiApi type', async () => {
    w = await makeWorld({ status: 200, body: OK_BODY });
    const botId = await createBot(w);
    const credId = await createCredential(w, { type: 'httpBearerAuth', token: 'tok_abcdefghij' });
    const flowId = await createFlow(w, botId, aiFlowGraph(credId));
    const res = await w.app.inject({ method: 'POST', url: `/api/flows/${flowId}/run`, cookies: w.cookie });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('error');
    expect(body.error).toMatch(/not an OpenAI-compatible/);
    expect(w.fetchLog).toHaveLength(0); // never reached the network
  });
});
