/**
 * P1-T8 — bots & flows REST API tests over a real in-memory SQLite DB and a
 * fully wired engine (fake Telegram transport — no network).
 * Covers: CRUD, token encryption + masking (I7), graph validation on write
 * (I5), version snapshots, activate guards, bot start/stop via gateway.
 */
import { readFileSync } from 'node:fs';
import { FlowGraphSchema } from '@ctb/shared';
import type { FastifyInstance } from 'fastify';
import type { UserFromGetMe } from 'grammy/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SESSION_COOKIE, buildApp } from '../src/app';
import { openDb, schema, type Db } from '../src/db/index';
import { runMigrations } from '../src/db/migrate';
import { wireEngine, type Engine } from '../src/engine/wire';
import { decrypt, deriveKey } from '../src/lib/crypto';
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
  const app = buildApp({
    env, db, engine, logger: false, editorDistDir: '/nonexistent',
    // grammY must never call getMe / deleteWebhook etc. in tests
    botRegisterOpts: () => ({ botInfo: BOT_INFO, callApi: async () => ({ message_id: 1 }) }),
  });
  const login = await app.inject({
    method: 'POST', url: '/api/auth/login',
    payload: { username: 'admin', password: 'hunter2hunter2' },
  });
  const cookie = { [SESSION_COOKIE]: login.cookies.find((c) => c.name === SESSION_COOKIE)!.value };
  return { app, db, engine, cookie };
}

describe('bots API (P1-T8)', () => {
  let w: World;
  beforeEach(async () => { w = await makeWorld(); });
  afterEach(async () => { await w.engine.gateway.stopAll(); await w.app.close(); });

  it('requires auth (401 without cookie)', async () => {
    const res = await w.app.inject({ method: 'GET', url: '/api/bots' });
    expect(res.statusCode).toBe(401);
  });

  it('create → token encrypted at rest, masked in responses (I7)', async () => {
    const res = await w.app.inject({
      method: 'POST', url: '/api/bots', cookies: w.cookie,
      payload: { name: 'بات تست', token: TOKEN },
    });
    expect(res.statusCode).toBe(201);
    const { bot } = res.json();
    expect(bot.name).toBe('بات تست');
    expect(bot.status).toBe('inactive');
    expect(JSON.stringify(res.json())).not.toContain(TOKEN);
    expect(bot.tokenHint).toMatch(/^123456789:AAE…/);

    const row = w.db.select().from(schema.bots).all()[0]!;
    expect(row.tokenEnc).not.toContain(TOKEN);
    expect(decrypt(row.tokenEnc, deriveKey(SECRET))).toBe(TOKEN);
  });

  it('rejects malformed tokens and bodies', async () => {
    const bad = await w.app.inject({
      method: 'POST', url: '/api/bots', cookies: w.cookie,
      payload: { name: 'x', token: 'not-a-token' },
    });
    expect(bad.statusCode).toBe(400);
  });

  it('list/get/patch/delete round-trip; 404s on unknown id', async () => {
    const created = (await w.app.inject({
      method: 'POST', url: '/api/bots', cookies: w.cookie,
      payload: { name: 'A', token: TOKEN },
    })).json().bot;

    const list = (await w.app.inject({ method: 'GET', url: '/api/bots', cookies: w.cookie })).json();
    expect(list.bots).toHaveLength(1);

    const patched = (await w.app.inject({
      method: 'PATCH', url: `/api/bots/${created.id}`, cookies: w.cookie,
      payload: { name: 'B', mode: 'webhook' },
    })).json().bot;
    expect(patched.name).toBe('B');
    expect(patched.mode).toBe('webhook');

    const del = await w.app.inject({ method: 'DELETE', url: `/api/bots/${created.id}`, cookies: w.cookie });
    expect(del.statusCode).toBe(200);
    expect((await w.app.inject({ method: 'GET', url: `/api/bots/${created.id}`, cookies: w.cookie })).statusCode).toBe(404);
  });

  it('start (polling) registers with the gateway and flips status', async () => {
    const bot = (await w.app.inject({
      method: 'POST', url: '/api/bots', cookies: w.cookie,
      payload: { name: 'A', token: TOKEN },
    })).json().bot;

    const start = await w.app.inject({ method: 'POST', url: `/api/bots/${bot.id}/start`, cookies: w.cookie });
    expect(start.statusCode).toBe(200);
    expect(start.json()).toMatchObject({ ok: true, mode: 'polling' });
    expect(w.engine.gateway.get(bot.id)).toBeDefined();
    const row = w.db.select().from(schema.bots).all()[0]!;
    expect(row.status).toBe('active');

    const stop = await w.app.inject({ method: 'POST', url: `/api/bots/${bot.id}/stop`, cookies: w.cookie });
    expect(stop.statusCode).toBe(200);
    expect(w.db.select().from(schema.bots).all()[0]!.status).toBe('inactive');
  });

  it('webhook mode without CTB_PUBLIC_URL → 400 pointed error', async () => {
    const bot = (await w.app.inject({
      method: 'POST', url: '/api/bots', cookies: w.cookie,
      payload: { name: 'A', token: TOKEN, mode: 'webhook' },
    })).json().bot;
    const start = await w.app.inject({ method: 'POST', url: `/api/bots/${bot.id}/start`, cookies: w.cookie });
    expect(start.statusCode).toBe(400);
    expect(start.json().error).toBe('webhook_mode_requires_public_url');
  });
});

describe('flows API (P1-T8)', () => {
  let w: World;
  let botId: string;
  beforeEach(async () => {
    w = await makeWorld();
    botId = (await w.app.inject({
      method: 'POST', url: '/api/bots', cookies: w.cookie,
      payload: { name: 'A', token: TOKEN },
    })).json().bot.id;
  });
  afterEach(async () => { await w.engine.gateway.stopAll(); await w.app.close(); });

  it('create defaults to draft + empty graph; unknown bot rejected', async () => {
    const res = await w.app.inject({
      method: 'POST', url: '/api/flows', cookies: w.cookie,
      payload: { botId, name: 'فلو ۱' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().flow).toMatchObject({ status: 'draft', version: 1, graph: { nodes: [], edges: [] } });

    const bad = await w.app.inject({
      method: 'POST', url: '/api/flows', cookies: w.cookie,
      payload: { botId: 'nope', name: 'x' },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toBe('unknown_bot');
  });

  it('graph writes are schema-validated (I5) — dangling edge rejected', async () => {
    const res = await w.app.inject({
      method: 'POST', url: '/api/flows', cookies: w.cookie,
      payload: {
        botId, name: 'bad',
        graph: { nodes: [{ id: 'a', type: 'tg.trigger', params: {} }], edges: [{ id: 'e', from: { node: 'a', port: 'main' }, to: { node: 'ghost', port: 'main' } }] },
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it('graph update bumps version and snapshots the old one', async () => {
    const flow = (await w.app.inject({
      method: 'POST', url: '/api/flows', cookies: w.cookie,
      payload: { botId, name: 'f', graph: GRAPH },
    })).json().flow;

    const updated = (await w.app.inject({
      method: 'PATCH', url: `/api/flows/${flow.id}`, cookies: w.cookie,
      payload: { graph: { nodes: [{ id: 't', type: 'tg.trigger', params: { event: 'any_message' } }], edges: [] } },
    })).json().flow;
    expect(updated.version).toBe(2);

    const versions = w.db.select().from(schema.flowVersions).all();
    expect(versions).toHaveLength(1);
    expect(versions[0]).toMatchObject({ flowId: flow.id, version: 1 });
    expect(versions[0]!.graph).toEqual(GRAPH); // the outgoing graph was snapshotted
  });

  it('activate requires an enabled trigger; deactivate returns to draft', async () => {
    const empty = (await w.app.inject({
      method: 'POST', url: '/api/flows', cookies: w.cookie,
      payload: { botId, name: 'empty' },
    })).json().flow;
    const blocked = await w.app.inject({ method: 'POST', url: `/api/flows/${empty.id}/activate`, cookies: w.cookie });
    expect(blocked.statusCode).toBe(422);
    expect(blocked.json().problems[0]).toContain('trigger');

    const good = (await w.app.inject({
      method: 'POST', url: '/api/flows', cookies: w.cookie,
      payload: { botId, name: 'good', graph: GRAPH },
    })).json().flow;
    const act = await w.app.inject({ method: 'POST', url: `/api/flows/${good.id}/activate`, cookies: w.cookie });
    expect(act.statusCode).toBe(200);
    expect(w.db.select().from(schema.flows).all().find((f) => f.id === good.id)!.status).toBe('active');

    const deact = await w.app.inject({ method: 'POST', url: `/api/flows/${good.id}/deactivate`, cookies: w.cookie });
    expect(deact.statusCode).toBe(200);
    expect(w.db.select().from(schema.flows).all().find((f) => f.id === good.id)!.status).toBe('draft');
  });

  it('deleting a bot cascades its flows', async () => {
    await w.app.inject({
      method: 'POST', url: '/api/flows', cookies: w.cookie,
      payload: { botId, name: 'f', graph: GRAPH },
    });
    await w.app.inject({ method: 'DELETE', url: `/api/bots/${botId}`, cookies: w.cookie });
    expect(w.db.select().from(schema.flows).all()).toHaveLength(0);
  });

  // ── P3-T6: execution-policy + error-handler flow settings ──────────────────

  it('create defaults settings to { replace, null }', async () => {
    const flow = (await w.app.inject({
      method: 'POST', url: '/api/flows', cookies: w.cookie,
      payload: { botId, name: 'set' },
    })).json().flow;
    expect(flow.settings).toEqual({ executionPolicy: 'replace', errorHandlerFlowId: null });
  });

  it('PATCH settings persists policy + a same-bot error-handler', async () => {
    const target = (await w.app.inject({
      method: 'POST', url: '/api/flows', cookies: w.cookie, payload: { botId, name: 'handler' },
    })).json().flow;
    const flow = (await w.app.inject({
      method: 'POST', url: '/api/flows', cookies: w.cookie, payload: { botId, name: 'main' },
    })).json().flow;

    const patched = (await w.app.inject({
      method: 'PATCH', url: `/api/flows/${flow.id}`, cookies: w.cookie,
      payload: { settings: { executionPolicy: 'queue', errorHandlerFlowId: target.id } },
    })).json().flow;
    expect(patched.settings).toEqual({ executionPolicy: 'queue', errorHandlerFlowId: target.id });

    // round-trips through GET (stored, not just echoed)
    const fetched = (await w.app.inject({
      method: 'GET', url: `/api/flows/${flow.id}`, cookies: w.cookie,
    })).json().flow;
    expect(fetched.settings).toEqual({ executionPolicy: 'queue', errorHandlerFlowId: target.id });
    // settings change does NOT bump the graph version
    expect(fetched.version).toBe(flow.version);
  });

  it('rejects an error-handler pointing at itself (error_handler_self)', async () => {
    const flow = (await w.app.inject({
      method: 'POST', url: '/api/flows', cookies: w.cookie, payload: { botId, name: 'self' },
    })).json().flow;
    const res = await w.app.inject({
      method: 'PATCH', url: `/api/flows/${flow.id}`, cookies: w.cookie,
      payload: { settings: { executionPolicy: 'replace', errorHandlerFlowId: flow.id } },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('error_handler_self');
  });

  it('rejects an error-handler from another bot (error_handler_not_same_bot)', async () => {
    const otherBotId = (await w.app.inject({
      method: 'POST', url: '/api/bots', cookies: w.cookie, payload: { name: 'B', token: TOKEN },
    })).json().bot.id;
    const otherFlow = (await w.app.inject({
      method: 'POST', url: '/api/flows', cookies: w.cookie, payload: { botId: otherBotId, name: 'foreign' },
    })).json().flow;
    const flow = (await w.app.inject({
      method: 'POST', url: '/api/flows', cookies: w.cookie, payload: { botId, name: 'cross' },
    })).json().flow;

    const res = await w.app.inject({
      method: 'PATCH', url: `/api/flows/${flow.id}`, cookies: w.cookie,
      payload: { settings: { executionPolicy: 'replace', errorHandlerFlowId: otherFlow.id } },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('error_handler_not_same_bot');

    // an unknown id is likewise rejected (not_same_bot covers missing too)
    const unknown = await w.app.inject({
      method: 'PATCH', url: `/api/flows/${flow.id}`, cookies: w.cookie,
      payload: { settings: { executionPolicy: 'replace', errorHandlerFlowId: 'does-not-exist' } },
    });
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json().error).toBe('error_handler_not_same_bot');
  });

  // ── P3-T7: import / export + starter template gallery ──────────────────────

  it('export → import yields identical graph + settings (acceptance)', async () => {
    // a flow with a non-default policy so we can prove settings survive too
    const flow = (await w.app.inject({
      method: 'POST', url: '/api/flows', cookies: w.cookie,
      payload: { botId, name: 'Source flow', graph: GRAPH },
    })).json().flow;
    await w.app.inject({
      method: 'PATCH', url: `/api/flows/${flow.id}`, cookies: w.cookie,
      payload: { settings: { executionPolicy: 'queue', errorHandlerFlowId: null } },
    });

    const exp = (await w.app.inject({
      method: 'GET', url: `/api/flows/${flow.id}/export`, cookies: w.cookie,
    })).json().export;
    expect(exp.kind).toBe('ctb.flow');
    expect(exp.name).toBe('Source flow');
    expect(exp).not.toHaveProperty('id');
    expect(exp).not.toHaveProperty('botId');
    expect(exp.settings.executionPolicy).toBe('queue');

    // re-import as a NEW flow (round-trip through JSON, as a download would)
    const imp = await w.app.inject({
      method: 'POST', url: '/api/flows/import', cookies: w.cookie,
      payload: { botId, export: JSON.parse(JSON.stringify(exp)) },
    });
    expect(imp.statusCode).toBe(201);
    const imported = imp.json().flow;

    expect(imported.id).not.toBe(flow.id); // a brand-new flow
    expect(imported.status).toBe('draft');
    expect(imported.version).toBe(1);
    expect(imported.graph).toEqual(GRAPH); // identical semantics
    expect(imported.settings).toEqual({ executionPolicy: 'queue', errorHandlerFlowId: null });
  });

  it('export drops the un-portable errorHandlerFlowId (→ null)', async () => {
    const handler = (await w.app.inject({
      method: 'POST', url: '/api/flows', cookies: w.cookie, payload: { botId, name: 'handler' },
    })).json().flow;
    const flow = (await w.app.inject({
      method: 'POST', url: '/api/flows', cookies: w.cookie, payload: { botId, name: 'main', graph: GRAPH },
    })).json().flow;
    await w.app.inject({
      method: 'PATCH', url: `/api/flows/${flow.id}`, cookies: w.cookie,
      payload: { settings: { executionPolicy: 'replace', errorHandlerFlowId: handler.id } },
    });

    const exp = (await w.app.inject({
      method: 'GET', url: `/api/flows/${flow.id}/export`, cookies: w.cookie,
    })).json().export;
    expect(exp.settings.errorHandlerFlowId).toBeNull();
  });

  it('import rejects an unknown bot and a non-export body', async () => {
    const exp = (await w.app.inject({
      method: 'POST', url: '/api/flows', cookies: w.cookie, payload: { botId, name: 'x', graph: GRAPH },
    })).json().flow;
    const envelope = (await w.app.inject({
      method: 'GET', url: `/api/flows/${exp.id}/export`, cookies: w.cookie,
    })).json().export;

    const badBot = await w.app.inject({
      method: 'POST', url: '/api/flows/import', cookies: w.cookie,
      payload: { botId: 'nope', export: envelope },
    });
    expect(badBot.statusCode).toBe(400);
    expect(badBot.json().error).toBe('unknown_bot');

    const badEnv = await w.app.inject({
      method: 'POST', url: '/api/flows/import', cookies: w.cookie,
      payload: { botId, export: { hello: 'world' } },
    });
    expect(badEnv.statusCode).toBe(400);
    expect(badEnv.json().error).toBe('invalid_export');
  });

  it('export of a missing flow is 404', async () => {
    const res = await w.app.inject({ method: 'GET', url: '/api/flows/does-not-exist/export', cookies: w.cookie });
    expect(res.statusCode).toBe(404);
  });

  it('lists generic starter templates and imports one as a new flow', async () => {
    const list = await w.app.inject({ method: 'GET', url: '/api/flow-templates', cookies: w.cookie });
    expect(list.statusCode).toBe(200);
    const templates = list.json().templates as { id: string; name: string; nodeCount: number }[];
    expect(templates.map((t) => t.id)).toEqual(['hello', 'feedback', 'quiz', 'faq', 'reminder']);

    const imp = await w.app.inject({
      method: 'POST', url: '/api/flows/import-template', cookies: w.cookie,
      payload: { botId, templateId: 'feedback', name: 'My feedback' },
    });
    expect(imp.statusCode).toBe(201);
    const flow = imp.json().flow;
    expect(flow.name).toBe('My feedback');
    expect(flow.botId).toBe(botId);
    expect(flow.status).toBe('draft');
    expect(flow.graph.nodes.length).toBeGreaterThan(0);
    // it persisted
    expect(w.db.select().from(schema.flows).all().some((f) => f.id === flow.id)).toBe(true);
  });

  it('import-template rejects an unknown template id (404)', async () => {
    const res = await w.app.inject({
      method: 'POST', url: '/api/flows/import-template', cookies: w.cookie,
      payload: { botId, templateId: 'no-such-template' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('unknown_template');
  });
});

describe('flow lifecycle: versions + rollback + activation problems (P2-T4)', () => {
  let w: World;
  let botId: string;
  beforeEach(async () => {
    w = await makeWorld();
    botId = (await w.app.inject({
      method: 'POST', url: '/api/bots', cookies: w.cookie,
      payload: { name: 'A', token: TOKEN },
    })).json().bot.id;
  });
  afterEach(async () => { await w.engine.gateway.stopAll(); await w.app.close(); });

  // parsed through the schema so defaults (disabled:false) match what the
  // server stores — graph PATCH bodies get FlowGraphSchema'd on write
  const V2_GRAPH = FlowGraphSchema.parse({
    nodes: [{ id: 't', type: 'tg.trigger', params: { event: 'any_message' }, position: { x: 0, y: 0 } }],
    edges: [],
  });

  async function makeFlowWithHistory(): Promise<string> {
    const flow = (await w.app.inject({
      method: 'POST', url: '/api/flows', cookies: w.cookie,
      payload: { botId, name: 'f', graph: GRAPH },
    })).json().flow;
    // bump to v2 — v1 (the full sample flow) becomes a snapshot
    await w.app.inject({
      method: 'PATCH', url: `/api/flows/${flow.id}`, cookies: w.cookie,
      payload: { graph: V2_GRAPH },
    });
    return flow.id as string;
  }

  it('GET /versions lists snapshots newest-first with node/edge counts', async () => {
    const id = await makeFlowWithHistory();
    const res = await w.app.inject({ method: 'GET', url: `/api/flows/${id}/versions`, cookies: w.cookie });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.current).toBe(2);
    expect(body.versions).toHaveLength(1);
    expect(body.versions[0]).toMatchObject({
      version: 1,
      nodeCount: GRAPH.nodes.length,
      edgeCount: GRAPH.edges.length,
    });

    const missing = await w.app.inject({ method: 'GET', url: '/api/flows/nope/versions', cookies: w.cookie });
    expect(missing.statusCode).toBe(404);
  });

  it('rollback restores the older graph, bumps version, and is itself undoable', async () => {
    const id = await makeFlowWithHistory();
    const res = await w.app.inject({
      method: 'POST', url: `/api/flows/${id}/rollback`, cookies: w.cookie,
      payload: { version: 1 },
    });
    expect(res.statusCode).toBe(200);
    const { flow } = res.json();
    expect(flow.version).toBe(3);
    expect(flow.graph).toEqual(GRAPH); // acceptance: rollback restores older graph

    // the outgoing v2 graph was snapshotted → rollback of the rollback works
    const versions = (await w.app.inject({
      method: 'GET', url: `/api/flows/${id}/versions`, cookies: w.cookie,
    })).json();
    expect(versions.versions.map((v: { version: number }) => v.version)).toEqual([2, 1]);

    const back = await w.app.inject({
      method: 'POST', url: `/api/flows/${id}/rollback`, cookies: w.cookie,
      payload: { version: 2 },
    });
    expect(back.json().flow.graph).toEqual(V2_GRAPH);
  });

  it('rollback rejects unknown versions and bad bodies', async () => {
    const id = await makeFlowWithHistory();
    const unknown = await w.app.inject({
      method: 'POST', url: `/api/flows/${id}/rollback`, cookies: w.cookie,
      payload: { version: 99 },
    });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json().error).toBe('version_not_found');

    const bad = await w.app.inject({
      method: 'POST', url: `/api/flows/${id}/rollback`, cookies: w.cookie,
      payload: { version: 'one' },
    });
    expect(bad.statusCode).toBe(400);
  });

  it('activation validates node params against the registry → 422 with nodeProblems', async () => {
    // tg.sendMessage type=text REQUIRES non-empty text (real registry schema)
    const flow = (await w.app.inject({
      method: 'POST', url: '/api/flows', cookies: w.cookie,
      payload: {
        botId, name: 'bad-params',
        graph: {
          nodes: [
            { id: 't', type: 'tg.trigger', params: { event: 'any_message' }, position: { x: 0, y: 0 } },
            { id: 's', type: 'tg.sendMessage', params: {}, position: { x: 200, y: 0 } },
          ],
          edges: [{ id: 'e1', from: { node: 't', port: 'main' }, to: { node: 's', port: 'main' } }],
        },
      },
    })).json().flow;

    const res = await w.app.inject({ method: 'POST', url: `/api/flows/${flow.id}/activate`, cookies: w.cookie });
    expect(res.statusCode).toBe(422);
    const body = res.json();
    expect(body.error).toBe('not_activatable');
    // structured problems point the canvas at the offending node
    expect(body.nodeProblems).toEqual([
      expect.objectContaining({ nodeId: 's' }),
    ]);
    expect(body.problems[0]).toContain('s: ');

    // fix the param → activates
    await w.app.inject({
      method: 'PATCH', url: `/api/flows/${flow.id}`, cookies: w.cookie,
      payload: {
        graph: {
          nodes: [
            { id: 't', type: 'tg.trigger', params: { event: 'any_message' }, position: { x: 0, y: 0 } },
            { id: 's', type: 'tg.sendMessage', params: { text: 'سلام' }, position: { x: 200, y: 0 } },
          ],
          edges: [{ id: 'e1', from: { node: 't', port: 'main' }, to: { node: 's', port: 'main' } }],
        },
      },
    });
    const ok = await w.app.inject({ method: 'POST', url: `/api/flows/${flow.id}/activate`, cookies: w.cookie });
    expect(ok.statusCode).toBe(200);
  });

  it('expression params are not judged at activation time', async () => {
    const flow = (await w.app.inject({
      method: 'POST', url: '/api/flows', cookies: w.cookie,
      payload: {
        botId, name: 'expr',
        graph: {
          nodes: [
            { id: 't', type: 'tg.trigger', params: { event: 'any_message' }, position: { x: 0, y: 0 } },
            // text is an expression — static validation must not block it
            { id: 's', type: 'tg.sendMessage', params: { text: '{{ $vars.greeting }}' }, position: { x: 200, y: 0 } },
          ],
          edges: [{ id: 'e1', from: { node: 't', port: 'main' }, to: { node: 's', port: 'main' } }],
        },
      },
    })).json().flow;
    const res = await w.app.inject({ method: 'POST', url: `/api/flows/${flow.id}/activate`, cookies: w.cookie });
    expect(res.statusCode).toBe(200);
  });
});
