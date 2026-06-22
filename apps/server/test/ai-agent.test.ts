/**
 * P5-T4 — server side of ai.agent: the agent tool loop running end-to-end
 * through a REAL wired engine + in-memory DB with an INJECTED fetch (no
 * network). This exercises the parts that live in the host, not the node:
 *
 *   - `makeAi` translating CTB tool specs → OpenAI `tools:[{type:'function'}]`
 *     and assistant `toolCalls` / `tool` results → the OpenAI wire shape,
 *   - `parseChatCompletion` extracting `message.tool_calls` into `AiToolCall[]`,
 *   - `makeMcp` answering `tools/list` + `tools/call` so an `mcp` tool source
 *     resolves and runs over the wire,
 *   - the openAiApi + mcpServer secrets staying host-side (I7) — never in the
 *     run response.
 *
 * A single recording fake `fetch` routes by URL: the OpenAI endpoint replays a
 * SCRIPTED SEQUENCE of chat-completions responses (turn 1 asks for a tool, turn
 * 2 answers), and the MCP endpoint answers JSON-RPC `tools/list` / `tools/call`.
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
const OPENAI_BASE = 'https://api.example.com/v1';
const MCP_URL = 'https://mcp.example.com/rpc';

interface FetchCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

/**
 * A recording fake fetch that routes by URL:
 *  - `${OPENAI_BASE}/chat/completions` → replays `openAiScript` in order
 *    (the LAST entry is reused if the loop overruns the script),
 *  - `MCP_URL` → answers JSON-RPC by method (tools/list, tools/call).
 */
function makeRouterFetch(opts: {
  openAiScript: { status: number; body: unknown }[];
  mcpTools?: { name: string; description?: string; inputSchema?: unknown }[];
  mcpCall?: (name: string, args: Record<string, unknown>) => { content: unknown[]; isError?: boolean };
  log: FetchCall[];
}): typeof fetch {
  let openAiTurn = 0;
  return (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[k.toLowerCase()] = v;
    }
    const parsedBody = init?.body ? JSON.parse(String(init.body)) : undefined;
    opts.log.push({ url, method: init?.method ?? 'GET', headers, body: parsedBody });

    if (url === `${OPENAI_BASE}/chat/completions`) {
      const idx = Math.min(openAiTurn, opts.openAiScript.length - 1);
      openAiTurn += 1;
      const resp = opts.openAiScript[idx]!;
      const text = JSON.stringify(resp.body);
      return { status: resp.status, async text() { return text; } } as Response;
    }

    if (url === MCP_URL) {
      const rpc = parsedBody as { id: unknown; method: string; params?: Record<string, unknown> };
      let result: unknown;
      if (rpc.method === 'tools/list') {
        result = { tools: opts.mcpTools ?? [] };
      } else if (rpc.method === 'tools/call') {
        const name = String(rpc.params?.name ?? '');
        const args = (rpc.params?.arguments ?? {}) as Record<string, unknown>;
        result = opts.mcpCall
          ? opts.mcpCall(name, args)
          : { content: [{ type: 'text', text: 'ok' }] };
      } else {
        result = {};
      }
      const text = JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result });
      return { status: 200, async text() { return text; } } as Response;
    }

    throw new Error(`unexpected fetch to ${url}`);
  }) as unknown as typeof fetch;
}

interface World {
  app: FastifyInstance;
  db: Db;
  engine: Engine;
  cookie: { [k: string]: string };
  fetchLog: FetchCall[];
}

async function makeWorld(fetchImpl: typeof fetch, fetchLog: FetchCall[]): Promise<World> {
  const env = loadEnv({ CTB_SECRET: SECRET, CTB_ADMIN_PASS: 'hunter2hunter2', NODE_ENV: 'test' } as NodeJS.ProcessEnv);
  const { db } = openDb(':memory:');
  runMigrations(db);
  const engine = wireEngine({ db, ctbSecret: SECRET, fetchImpl, expressionBudgetMs: 5_000 });
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

async function createCredential(w: World, name: string, data: unknown): Promise<string> {
  const res = await w.app.inject({
    method: 'POST', url: '/api/credentials', cookies: w.cookie, payload: { name, data },
  });
  expect(res.statusCode).toBe(201);
  return res.json().credential.id as string;
}

async function createFlow(w: World, botId: string, graph: unknown): Promise<string> {
  const res = await w.app.inject({
    method: 'POST', url: '/api/flows', cookies: w.cookie, payload: { botId, name: 'agent flow', graph },
  });
  expect(res.statusCode).toBe(201);
  return res.json().flow.id as string;
}

/** flow.manualTrigger → ai.agent (with an MCP tool source). */
function agentFlowGraph(openAiCredId: string, mcpCredId: string) {
  return {
    nodes: [
      { id: 'trig', type: 'flow.manualTrigger', params: { sample: '{}' } },
      {
        id: 'agent',
        type: 'ai.agent',
        params: {
          credentialId: openAiCredId,
          model: 'gpt-4o-mini',
          system_prompt: 'You are a weather assistant.',
          user_prompt: 'What is the weather in Tehran?',
          tools: [{ type: 'mcp', credentialId: mcpCredId }],
          max_steps: 6,
          max_tool_calls: 12,
          max_tokens_total: 0,
          save_as: 'agent',
        },
      },
    ],
    edges: [{ id: 'e1', from: { node: 'trig', port: 'main' }, to: { node: 'agent', port: 'main' } }],
  };
}

/** Pull the agent node's output item out of the execution logs. */
async function readAgentOutput(w: World, executionId: string): Promise<{
  reply: string; steps: number; toolCalls: number; stopReason: string;
  usage: { totalTokens?: number };
}> {
  const detail = await w.app.inject({
    method: 'GET', url: `/api/executions/${executionId}`, cookies: w.cookie,
  });
  const logs = detail.json().execution.logs as {
    nodeId: string | null;
    output: Record<string, { json: Record<string, unknown> }[]> | null;
  }[];
  const row = logs.find((l) => l.nodeId === 'agent' && l.output);
  expect(row).toBeTruthy();
  return row!.output!.main![0]!.json.agent as {
    reply: string; steps: number; toolCalls: number; stopReason: string;
    usage: { totalTokens?: number };
  };
}

const TURN1_TOOLCALL = {
  status: 200,
  body: {
    choices: [{
      message: {
        content: '',
        tool_calls: [{
          id: 'call_abc',
          type: 'function',
          function: { name: 'get_weather', arguments: '{"city":"Tehran"}' },
        }],
      },
    }],
    usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 },
    model: 'gpt-4o-mini',
  },
};

const TURN2_FINAL = {
  status: 200,
  body: {
    choices: [{ message: { content: 'It is 25°C and sunny in Tehran.' } }],
    usage: { prompt_tokens: 40, completion_tokens: 10, total_tokens: 50 },
    model: 'gpt-4o-mini',
  },
};

describe('ai.agent via wired engine (P5-T4)', () => {
  let w: World;
  afterEach(async () => { await w.engine.gateway.stopAll(); await w.app.close(); });

  it('runs the MCP tool loop: lists tools, passes function specs, calls the tool, feeds the result back, answers', async () => {
    const log: FetchCall[] = [];
    const fetchImpl = makeRouterFetch({
      openAiScript: [TURN1_TOOLCALL, TURN2_FINAL],
      mcpTools: [{
        name: 'get_weather',
        description: 'Get current weather for a city',
        inputSchema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
      }],
      mcpCall: (name, args) => ({
        content: [{ type: 'text', text: `weather(${name}): ${JSON.stringify(args)} → 25C sunny` }],
      }),
      log,
    });
    w = await makeWorld(fetchImpl, log);
    const botId = await createBot(w);
    const openAiId = await createCredential(w, 'llm', {
      type: 'openAiApi', baseUrl: OPENAI_BASE, apiKey: 'sk-secret-xyz',
    });
    const mcpId = await createCredential(w, 'mcp', {
      type: 'mcpServer', url: MCP_URL, apiKey: 'mcp-secret-key',
    });
    const flowId = await createFlow(w, botId, agentFlowGraph(openAiId, mcpId));

    const res = await w.app.inject({ method: 'POST', url: `/api/flows/${flowId}/run`, cookies: w.cookie });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('done');

    // The fetch sequence: tools/list → chat (turn 1) → tools/call → chat (turn 2).
    const openAiCalls = log.filter((c) => c.url === `${OPENAI_BASE}/chat/completions`);
    const mcpCalls = log.filter((c) => c.url === MCP_URL);
    expect(openAiCalls).toHaveLength(2);
    expect(mcpCalls).toHaveLength(2);
    expect((mcpCalls[0]!.body as { method: string }).method).toBe('tools/list');
    expect((mcpCalls[1]!.body as { method: string }).method).toBe('tools/call');
    // The MCP call carried the model's chosen arguments.
    expect((mcpCalls[1]!.body as { params: { name: string; arguments: unknown } }).params).toEqual({
      name: 'get_weather',
      arguments: { city: 'Tehran' },
    });

    // Turn 1 advertised the MCP tool to the provider as an OpenAI function tool.
    const turn1Body = openAiCalls[0]!.body as {
      tools?: { type: string; function: { name: string; parameters: unknown } }[];
      messages: { role: string; content: string }[];
    };
    expect(turn1Body.tools).toHaveLength(1);
    expect(turn1Body.tools![0]!.type).toBe('function');
    expect(turn1Body.tools![0]!.function.name).toBe('get_weather');
    expect(turn1Body.tools![0]!.function.parameters).toEqual({
      type: 'object', properties: { city: { type: 'string' } }, required: ['city'],
    });

    // Turn 2 replayed the assistant tool-call turn + the tool result in wire shape.
    const turn2Body = openAiCalls[1]!.body as {
      messages: {
        role: string; content: string;
        tool_calls?: { id: string; type: string; function: { name: string; arguments: string } }[];
        tool_call_id?: string;
      }[];
    };
    const assistantTurn = turn2Body.messages.find((m) => m.role === 'assistant');
    expect(assistantTurn?.tool_calls?.[0]).toEqual({
      id: 'call_abc',
      type: 'function',
      function: { name: 'get_weather', arguments: '{"city":"Tehran"}' },
    });
    const toolTurn = turn2Body.messages.find((m) => m.role === 'tool');
    expect(toolTurn?.tool_call_id).toBe('call_abc');
    expect(toolTurn?.content).toContain('25C sunny');

    // The agent's final answer + bookkeeping landed on the output item.
    const agent = await readAgentOutput(w, body.executionId);
    expect(agent.reply).toBe('It is 25°C and sunny in Tehran.');
    expect(agent.steps).toBe(2);
    expect(agent.toolCalls).toBe(1);
    expect(agent.stopReason).toBe('final');
    expect(agent.usage.totalTokens).toBe(75); // 25 + 50

    // Neither secret leaked into the run response (I7).
    expect(JSON.stringify(body)).not.toContain('sk-secret-xyz');
    expect(JSON.stringify(body)).not.toContain('mcp-secret-key');
    // The provider got the bearer of the openAiApi key; MCP got its own.
    expect(openAiCalls[0]!.headers.authorization).toBe('Bearer sk-secret-xyz');
    expect(mcpCalls[0]!.headers.authorization).toBe('Bearer mcp-secret-key');
  });

  it('answers directly with no tool calls (plain chat path through the agent loop)', async () => {
    const log: FetchCall[] = [];
    const fetchImpl = makeRouterFetch({
      openAiScript: [{
        status: 200,
        body: {
          choices: [{ message: { content: 'Hello!' } }],
          usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
          model: 'gpt-4o-mini',
        },
      }],
      mcpTools: [{ name: 'noop' }],
      log,
    });
    w = await makeWorld(fetchImpl, log);
    const botId = await createBot(w);
    const openAiId = await createCredential(w, 'llm', {
      type: 'openAiApi', baseUrl: OPENAI_BASE, apiKey: 'sk-secret-xyz',
    });
    const mcpId = await createCredential(w, 'mcp', { type: 'mcpServer', url: MCP_URL });
    const flowId = await createFlow(w, botId, agentFlowGraph(openAiId, mcpId));

    const res = await w.app.inject({ method: 'POST', url: `/api/flows/${flowId}/run`, cookies: w.cookie });
    const body = res.json();
    expect(body.status).toBe('done');

    const openAiCalls = log.filter((c) => c.url === `${OPENAI_BASE}/chat/completions`);
    expect(openAiCalls).toHaveLength(1); // one LLM turn, no follow-up

    const agent = await readAgentOutput(w, body.executionId);
    expect(agent.reply).toBe('Hello!');
    expect(agent.steps).toBe(1);
    expect(agent.toolCalls).toBe(0);
    expect(agent.stopReason).toBe('final');
  });

  it('fails the run when the provider returns a non-2xx status', async () => {
    const log: FetchCall[] = [];
    const fetchImpl = makeRouterFetch({
      openAiScript: [{ status: 401, body: { error: { message: 'bad key' } } }],
      mcpTools: [],
      log,
    });
    w = await makeWorld(fetchImpl, log);
    const botId = await createBot(w);
    const openAiId = await createCredential(w, 'llm', {
      type: 'openAiApi', baseUrl: OPENAI_BASE, apiKey: 'sk-bad',
    });
    const mcpId = await createCredential(w, 'mcp', { type: 'mcpServer', url: MCP_URL });
    const flowId = await createFlow(w, botId, agentFlowGraph(openAiId, mcpId));

    const res = await w.app.inject({ method: 'POST', url: `/api/flows/${flowId}/run`, cookies: w.cookie });
    const body = res.json();
    expect(body.status).toBe('error');
    expect(body.error).toMatch(/HTTP 401/);
  });

  it('surfaces an MCP tool error back to the model as an error string, not a node failure', async () => {
    const log: FetchCall[] = [];
    const fetchImpl = makeRouterFetch({
      // turn 1 asks for the tool; turn 2 (after the error) gives a final reply.
      openAiScript: [TURN1_TOOLCALL, {
        status: 200,
        body: {
          choices: [{ message: { content: 'Sorry, the weather service is unavailable.' } }],
          usage: { total_tokens: 30 },
          model: 'gpt-4o-mini',
        },
      }],
      mcpTools: [{ name: 'get_weather', description: 'weather' }],
      mcpCall: () => ({ content: [{ type: 'text', text: 'upstream timeout' }], isError: true }),
      log,
    });
    w = await makeWorld(fetchImpl, log);
    const botId = await createBot(w);
    const openAiId = await createCredential(w, 'llm', {
      type: 'openAiApi', baseUrl: OPENAI_BASE, apiKey: 'sk-secret-xyz',
    });
    const mcpId = await createCredential(w, 'mcp', { type: 'mcpServer', url: MCP_URL });
    const flowId = await createFlow(w, botId, agentFlowGraph(openAiId, mcpId));

    const res = await w.app.inject({ method: 'POST', url: `/api/flows/${flowId}/run`, cookies: w.cookie });
    const body = res.json();
    expect(body.status).toBe('done'); // tool error did NOT fail the node

    // The error reached the model as a tool result string.
    const openAiCalls = log.filter((c) => c.url === `${OPENAI_BASE}/chat/completions`);
    const turn2Body = openAiCalls[1]!.body as { messages: { role: string; content: string }[] };
    const toolTurn = turn2Body.messages.find((m) => m.role === 'tool');
    expect(toolTurn?.content).toMatch(/error:.*upstream timeout/);

    const agent = await readAgentOutput(w, body.executionId);
    expect(agent.reply).toBe('Sorry, the weather service is unavailable.');
    expect(agent.toolCalls).toBe(1);
    expect(agent.stopReason).toBe('final');
  });
});
