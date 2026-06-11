/**
 * In-memory fake of the server's bots+flows+auth API for editor tests.
 * Mirrors the real route semantics (status codes, envelopes, token masking)
 * closely enough to exercise the typed client and stores without a server.
 */
import type { BotPublic, FlowPublic } from '@ctb/shared';
import type { FetchLike } from '../src/api/client';

export interface FakeServer {
  fetch: FetchLike;
  bots: Map<string, BotPublic & { token: string }>;
  flows: Map<string, FlowPublic>;
  loggedIn: boolean;
  calls: { method: string; path: string; body?: unknown }[];
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

let seq = 0;
const uid = (p: string) => `${p}-${++seq}`;

export function createFakeServer(): FakeServer {
  const srv: FakeServer = {
    bots: new Map(),
    flows: new Map(),
    loggedIn: false,
    calls: [],
    fetch: async (input, init) => {
      const method = init?.method ?? 'GET';
      const url = new URL(input, 'http://test');
      const path = url.pathname;
      const body = init?.body ? JSON.parse(init.body as string) : undefined;
      srv.calls.push({ method, path, ...(body !== undefined ? { body } : {}) });

      // ---- auth ----
      if (path === '/api/auth/login' && method === 'POST') {
        if (body?.username === 'admin' && body?.password === 'pw') {
          srv.loggedIn = true;
          return json(200, { ok: true, user: { username: 'admin' } });
        }
        return json(401, { error: 'invalid_credentials' });
      }
      if (path === '/api/auth/logout' && method === 'POST') {
        srv.loggedIn = false;
        return json(200, { ok: true });
      }
      if (path === '/api/auth/me') {
        return srv.loggedIn
          ? json(200, { user: { username: 'admin' } })
          : json(401, { error: 'unauthorized' });
      }

      if (!srv.loggedIn) return json(401, { error: 'unauthorized' });

      // ---- bots ----
      if (path === '/api/bots' && method === 'GET') {
        return json(200, { bots: [...srv.bots.values()].map(({ token: _t, ...pub }) => pub) });
      }
      if (path === '/api/bots' && method === 'POST') {
        const id = uid('bot');
        const ts = new Date().toISOString();
        const [tid = '', rest = ''] = (body.token as string).split(':');
        const bot = {
          id,
          name: body.name,
          token: body.token,
          tokenHint: `${tid}:${rest.slice(0, 3)}…${rest.slice(-3)}`,
          mode: body.mode ?? 'polling',
          status: 'inactive' as const,
          settings: body.settings ?? {},
          createdAt: ts,
          updatedAt: ts,
        };
        srv.bots.set(id, bot);
        const { token: _t, ...pub } = bot;
        return json(201, { bot: pub });
      }
      const botMatch = path.match(/^\/api\/bots\/([^/]+)(\/(start|stop))?$/);
      if (botMatch) {
        const bot = srv.bots.get(botMatch[1]!);
        if (!bot) return json(404, { error: 'not_found' });
        const action = botMatch[3];
        if (action === 'start') {
          bot.status = 'active';
          return json(200, { ok: true });
        }
        if (action === 'stop') {
          bot.status = 'inactive';
          return json(200, { ok: true });
        }
        if (method === 'GET') {
          const { token: _t, ...pub } = bot;
          return json(200, { bot: pub });
        }
        if (method === 'DELETE') {
          srv.bots.delete(bot.id);
          for (const [fid, f] of srv.flows) if (f.botId === bot.id) srv.flows.delete(fid);
          return json(200, { ok: true });
        }
      }

      // ---- flows ----
      if (path === '/api/flows' && method === 'GET') {
        const botId = url.searchParams.get('botId');
        const flows = [...srv.flows.values()].filter((f) => !botId || f.botId === botId);
        return json(200, { flows });
      }
      if (path === '/api/flows' && method === 'POST') {
        if (!srv.bots.has(body.botId)) return json(400, { error: 'unknown_bot' });
        const id = uid('flow');
        const flow: FlowPublic = {
          id,
          botId: body.botId,
          name: body.name,
          status: 'draft',
          graph: body.graph ?? { nodes: [], edges: [] },
          version: 1,
          updatedAt: new Date().toISOString(),
        };
        srv.flows.set(id, flow);
        return json(201, { flow });
      }
      const flowMatch = path.match(/^\/api\/flows\/([^/]+)(\/(activate|deactivate))?$/);
      if (flowMatch) {
        const flow = srv.flows.get(flowMatch[1]!);
        if (!flow) return json(404, { error: 'not_found' });
        const action = flowMatch[3];
        if (action === 'activate') {
          const hasTrigger = flow.graph.nodes.some((n) => n.type === 'tg.trigger' && !n.disabled);
          if (!hasTrigger) {
            return json(422, {
              error: 'not_activatable',
              problems: ['flow has no enabled tg.trigger node'],
            });
          }
          flow.status = 'active';
          return json(200, { ok: true, status: 'active' });
        }
        if (action === 'deactivate') {
          flow.status = 'draft';
          return json(200, { ok: true, status: 'draft' });
        }
        if (method === 'GET') return json(200, { flow });
        if (method === 'DELETE') {
          srv.flows.delete(flow.id);
          return json(200, { ok: true });
        }
      }

      return json(404, { error: 'not_found' });
    },
  };
  return srv;
}
