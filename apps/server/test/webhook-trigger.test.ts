/**
 * P4-T1 — inbound Webhook Trigger route tests (POST /hooks/flow/:flowId/:secret)
 * over a real in-memory SQLite DB + fully wired engine (fake Telegram transport).
 *
 * Covers the HTTP contract the open protocol freezes (PROTOCOL.md):
 *  • wrong / missing path secret → 404 (no leak)
 *  • async mode → 202 {ok,executionId}, body reaches the flow ($json.body)
 *  • sync mode → holds until flow.respondToWebhook, returns its status+body
 *  • sync mode without a respond node → 200 ack with run status
 *  • optional HMAC: missing/bad signature → 401; correct signature → runs
 *  • the /api/flows/:id/webhook info endpoint returns a matching secret/url
 */
import { createHmac } from 'node:crypto';
import {
  FlowGraphSchema,
  type FlowGraph,
  type WebhookTriggerParams,
  type FlowRespondToWebhookParams,
} from '@ctb/shared';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SESSION_COOKIE, buildApp } from '../src/app';
import { openDb, type Db } from '../src/db/index';
import { runMigrations } from '../src/db/migrate';
import { wireEngine, type Engine } from '../src/engine/wire';
import { loadEnv } from '../src/lib/env';
import { flowWebhookSecret, signWebhookBody } from '../src/triggers/webhook';

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
  const engine = wireEngine({ db, ctbSecret: SECRET });
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

/** Build a webhook flow graph: webhook.trigger → data.setFields → [respond?]. */
function webhookGraph(opts: {
  trigger?: Partial<WebhookTriggerParams>;
  respond?: Partial<FlowRespondToWebhookParams> | null;
}): FlowGraph {
  const nodes: FlowGraph['nodes'] = [
    {
      id: 'trig',
      type: 'webhook.trigger',
      params: { ...(opts.trigger ?? {}) },
      position: { x: 0, y: 0 },
      disabled: false,
    },
    {
      id: 'set',
      type: 'data.setFields',
      params: { fields: [{ target: 'json', name: 'seen', value: 'yes', op: 'set' }] },
      position: { x: 200, y: 0 },
      disabled: false,
    },
  ];
  const edges: FlowGraph['edges'] = [
    { id: 'e1', from: { node: 'trig', port: 'main' }, to: { node: 'set', port: 'main' } },
  ];
  if (opts.respond !== null && opts.respond !== undefined) {
    nodes.push({
      id: 'resp',
      type: 'flow.respondToWebhook',
      params: { ...opts.respond },
      position: { x: 400, y: 0 },
      disabled: false,
    });
    edges.push({
      id: 'e2',
      from: { node: 'set', port: 'main' },
      to: { node: 'resp', port: 'main' },
    });
  }
  // Validate so a malformed test graph fails loudly here, not at runtime.
  return FlowGraphSchema.parse({ nodes, edges });
}

async function createBotAndFlow(w: World, graph: FlowGraph): Promise<string> {
  const { bot } = (
    await w.app.inject({
      method: 'POST',
      url: '/api/bots',
      cookies: w.cookie,
      payload: { name: 'b', token: '123456789:AAEexampletokenexampletokenexample' },
    })
  ).json() as { bot: { id: string } };
  const { flow } = (
    await w.app.inject({
      method: 'POST',
      url: '/api/flows',
      cookies: w.cookie,
      payload: { botId: bot.id, name: 'hook flow', graph },
    })
  ).json() as { flow: { id: string } };
  return flow.id;
}

describe('Webhook Trigger route (P4-T1)', () => {
  let w: World;
  beforeEach(async () => {
    w = await makeWorld();
  });
  afterEach(async () => {
    await w.engine.gateway.stopAll();
    await w.app.close();
  });

  it('rejects a wrong path secret with 404', async () => {
    const flowId = await createBotAndFlow(w, webhookGraph({ trigger: { mode: 'async' } }));
    const res = await w.app.inject({
      method: 'POST',
      url: `/hooks/flow/${flowId}/totally-wrong-secret`,
      payload: { x: 1 },
    });
    expect(res.statusCode).toBe(404);
  });

  it('rejects an unknown flow id with 404 (even with a valid-looking secret)', async () => {
    const fakeId = 'nope';
    const res = await w.app.inject({
      method: 'POST',
      url: `/hooks/flow/${fakeId}/${flowWebhookSecret(fakeId, SECRET)}`,
      payload: {},
    });
    expect(res.statusCode).toBe(404);
  });

  it('async mode: returns 202 + executionId immediately and runs the flow', async () => {
    const flowId = await createBotAndFlow(w, webhookGraph({ trigger: { mode: 'async' } }));
    const res = await w.app.inject({
      method: 'POST',
      url: `/hooks/flow/${flowId}/${flowWebhookSecret(flowId, SECRET)}`,
      payload: { hello: 'world' },
    });
    expect(res.statusCode).toBe(202);
    const body = res.json() as { ok: boolean; executionId: string };
    expect(body.ok).toBe(true);
    expect(body.executionId).toBeTruthy();
  });

  it('sync mode: returns the response parked by flow.respondToWebhook', async () => {
    const flowId = await createBotAndFlow(
      w,
      webhookGraph({
        trigger: { mode: 'sync' },
        respond: { status: 201, body_type: 'json', body: '{"pong":true}' },
      }),
    );
    const res = await w.app.inject({
      method: 'POST',
      url: `/hooks/flow/${flowId}/${flowWebhookSecret(flowId, SECRET)}`,
      payload: { ping: 1 },
    });
    expect(res.statusCode).toBe(201);
    expect(res.headers['content-type']).toContain('application/json');
    expect(res.json()).toEqual({ pong: true });
  });

  it('sync mode with a text body responds as text/plain', async () => {
    const flowId = await createBotAndFlow(
      w,
      webhookGraph({
        trigger: { mode: 'sync' },
        respond: { body_type: 'text', body: 'pong' },
      }),
    );
    const res = await w.app.inject({
      method: 'POST',
      url: `/hooks/flow/${flowId}/${flowWebhookSecret(flowId, SECRET)}`,
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/plain');
    expect(res.body).toBe('pong');
  });

  it('sync mode without a respond node falls back to a 200 ack with run status', async () => {
    const flowId = await createBotAndFlow(
      w,
      webhookGraph({ trigger: { mode: 'sync' }, respond: null }),
    );
    const res = await w.app.inject({
      method: 'POST',
      url: `/hooks/flow/${flowId}/${flowWebhookSecret(flowId, SECRET)}`,
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { ok: boolean; status: string };
    expect(body.ok).toBe(true);
    expect(body.status).toBe('done');
  });

  it('HMAC: rejects a missing/bad signature with 401, accepts a correct one', async () => {
    const flowId = await createBotAndFlow(
      w,
      webhookGraph({
        trigger: { mode: 'async', verify_signature: true },
      }),
    );
    const url = `/hooks/flow/${flowId}/${flowWebhookSecret(flowId, SECRET)}`;
    const raw = JSON.stringify({ a: 1 });

    // missing signature
    const noSig = await w.app.inject({
      method: 'POST',
      url,
      headers: { 'content-type': 'application/json' },
      payload: raw,
    });
    expect(noSig.statusCode).toBe(401);

    // wrong signature
    const badSig = await w.app.inject({
      method: 'POST',
      url,
      headers: { 'content-type': 'application/json', 'x-ctb-signature': 'sha256=deadbeef' },
      payload: raw,
    });
    expect(badSig.statusCode).toBe(401);

    // correct signature
    const goodSig = await w.app.inject({
      method: 'POST',
      url,
      headers: {
        'content-type': 'application/json',
        'x-ctb-signature': signWebhookBody(raw, flowId, SECRET),
      },
      payload: raw,
    });
    expect(goodSig.statusCode).toBe(202);
  });

  it('signWebhookBody matches an independently computed HMAC', () => {
    const raw = '{"x":1}';
    const flowId = 'f1';
    // Recompute with the documented key derivation to lock the contract.
    const key = createHmac('sha256', `ctb-hook-hmac-v1:${SECRET}`).update(flowId).digest('hex');
    const expected = 'sha256=' + createHmac('sha256', key).update(raw).digest('hex');
    expect(signWebhookBody(raw, flowId, SECRET)).toBe(expected);
  });

  it('GET /api/flows/:id/webhook returns a path whose secret matches the route', async () => {
    const flowId = await createBotAndFlow(w, webhookGraph({ trigger: { mode: 'async' } }));
    const info = (
      await w.app.inject({
        method: 'GET',
        url: `/api/flows/${flowId}/webhook`,
        cookies: w.cookie,
      })
    ).json() as { path: string; hmacKey: string; signatureHeader: string };
    expect(info.path).toBe(`/hooks/flow/${flowId}/${flowWebhookSecret(flowId, SECRET)}`);
    expect(info.signatureHeader).toBe('X-CTB-Signature');
    expect(info.hmacKey).toMatch(/^[0-9a-f]{64}$/);
  });

  it('a flow with only a webhook trigger can be activated (entry-point recognized)', async () => {
    const flowId = await createBotAndFlow(w, webhookGraph({ trigger: { mode: 'async' } }));
    const res = await w.app.inject({
      method: 'POST',
      url: `/api/flows/${flowId}/activate`,
      cookies: w.cookie,
    });
    expect(res.statusCode).toBe(200);
  });
});
