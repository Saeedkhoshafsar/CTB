/**
 * P2-T1 — typed API client tests over the in-memory fake server.
 * Verifies: shared-schema pre-validation (I5), error envelopes, token
 * masking visibility (I7: the client never even SEES a token in responses),
 * and the full bots/flows happy paths.
 */
import { describe, expect, it } from 'vitest';
import { ApiClient, ApiError, ClientValidationError } from '../src/api/client';
import { createFakeServer } from './fake-fetch';

const VALID_TOKEN = '123456789:AAEabcdefghijklmnopqrstuvwxy-z12345';

function loggedInClient() {
  const srv = createFakeServer();
  const client = new ApiClient({ fetchImpl: srv.fetch });
  return { srv, client };
}

describe('ApiClient (P2-T1)', () => {
  it('login → me → logout round-trip', async () => {
    const { client } = loggedInClient();
    expect(await client.me()).toBeNull(); // anonymous → null, NOT a throw
    const user = await client.login({ username: 'admin', password: 'pw' });
    expect(user).toEqual({ username: 'admin' });
    expect(await client.me()).toEqual({ username: 'admin' });
    await client.logout();
    expect(await client.me()).toBeNull();
  });

  it('bad credentials → ApiError 401 with envelope', async () => {
    const { client } = loggedInClient();
    await expect(client.login({ username: 'admin', password: 'wrong' })).rejects.toMatchObject({
      name: 'ApiError',
      status: 401,
      body: { error: 'invalid_credentials' },
    });
  });

  it('invalid bot token fails LOCALLY via shared Zod schema — no network call (I5)', async () => {
    const { srv, client } = loggedInClient();
    await client.login({ username: 'admin', password: 'pw' });
    const callsBefore = srv.calls.length;
    await expect(
      client.createBot({ name: 'x', token: 'not-a-token', mode: 'polling', settings: {} }),
    ).rejects.toBeInstanceOf(ClientValidationError);
    expect(srv.calls.length).toBe(callsBefore); // nothing hit the wire
  });

  it('createBot → response carries masked tokenHint, never the token (I7)', async () => {
    const { client } = loggedInClient();
    await client.login({ username: 'admin', password: 'pw' });
    const bot = await client.createBot({
      name: 'ربات من',
      token: VALID_TOKEN,
      mode: 'polling',
      settings: {},
    });
    expect(bot.tokenHint).toMatch(/^123456789:AAE…345$/);
    expect(JSON.stringify(bot)).not.toContain(VALID_TOKEN);
    expect(bot.status).toBe('inactive');
  });

  it('flows CRUD + activate guard surfaces 422 problems', async () => {
    const { client } = loggedInClient();
    await client.login({ username: 'admin', password: 'pw' });
    const bot = await client.createBot({
      name: 'b',
      token: VALID_TOKEN,
      mode: 'polling',
      settings: {},
    });

    const flow = await client.createFlow({
      botId: bot.id,
      name: 'فلوی خالی',
      graph: { nodes: [], edges: [] },
    });
    expect(flow.status).toBe('draft');
    expect(flow.version).toBe(1);

    // empty graph is not activatable — server-style 422 with problems[]
    try {
      await client.activateFlow(flow.id);
      expect.unreachable('activate should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).status).toBe(422);
      expect((err as ApiError).body.problems).toEqual([
        'flow has no enabled trigger node',
      ]);
    }

    expect(await client.listFlows(bot.id)).toHaveLength(1);
    await client.deleteFlow(flow.id);
    expect(await client.listFlows(bot.id)).toHaveLength(0);
  });

  it('runNode (I-T2) sends nodeId + input to the single-node endpoint and returns the run result', async () => {
    const { srv, client } = loggedInClient();
    await client.login({ username: 'admin', password: 'pw' });
    const bot = await client.createBot({ name: 'b', token: VALID_TOKEN, mode: 'polling', settings: {} });
    const flow = await client.createFlow({
      botId: bot.id, name: 'f',
      graph: {
        nodes: [{ id: 'set', type: 'data.setFields', params: {}, position: { x: 0, y: 0 }, disabled: false }],
        edges: [],
      },
    });

    const res = await client.runNode(flow.id, 'set', [{ json: { who: 'علی' } }]);
    expect(res.status).toBe('done');
    expect(res.executionId).toMatch(/^exec/);
    // the wrapper hit the right endpoint with the right body
    expect(srv.runNodeCalls).toEqual([
      { flowId: flow.id, nodeId: 'set', input: [{ json: { who: 'علی' } }] },
    ]);

    // input is optional — omitting it sends no `input` key
    srv.runNodeCalls.length = 0;
    await client.runNode(flow.id, 'set');
    expect(srv.runNodeCalls[0]).toEqual({ flowId: flow.id, nodeId: 'set', input: undefined });

    // unknown node → 404 node_not_found envelope
    await expect(client.runNode(flow.id, 'ghost')).rejects.toMatchObject({
      name: 'ApiError', status: 404, body: { error: 'node_not_found' },
    });
  });

  it('updateFlow persists execution-policy + error-handler settings (P3-T6)', async () => {
    const { client } = loggedInClient();
    await client.login({ username: 'admin', password: 'pw' });
    const bot = await client.createBot({ name: 'b', token: VALID_TOKEN, mode: 'polling', settings: {} });

    const handler = await client.createFlow({ botId: bot.id, name: 'مدیر-خطا', graph: { nodes: [], edges: [] } });
    const flow = await client.createFlow({ botId: bot.id, name: 'اصلی', graph: { nodes: [], edges: [] } });
    // create defaults to { replace, null }
    expect(flow.settings).toEqual({ executionPolicy: 'replace', errorHandlerFlowId: null });

    const updated = await client.updateFlow(flow.id, {
      settings: { executionPolicy: 'queue', errorHandlerFlowId: handler.id },
    });
    expect(updated.settings).toEqual({ executionPolicy: 'queue', errorHandlerFlowId: handler.id });

    // round-trips through GET (stored, not just echoed)
    const fetched = await client.getFlow(flow.id);
    expect(fetched.settings).toEqual({ executionPolicy: 'queue', errorHandlerFlowId: handler.id });
  });

  it('export → import creates a new flow with identical graph + settings (P3-T7)', async () => {
    const { client } = loggedInClient();
    await client.login({ username: 'admin', password: 'pw' });
    const bot = await client.createBot({ name: 'b', token: VALID_TOKEN, mode: 'polling', settings: {} });

    const graph = {
      nodes: [
        { id: 'start', type: 'tg.trigger', params: { event: 'command', command: '/go' }, position: { x: 0, y: 0 }, disabled: false },
        { id: 'msg', type: 'tg.sendMessage', params: { type: 'text', text: 'سلام' }, position: { x: 0, y: 100 }, disabled: false },
      ],
      edges: [{ id: 'e1', from: { node: 'start', port: 'main' }, to: { node: 'msg', port: 'main' } }],
    };
    const flow = await client.createFlow({ botId: bot.id, name: 'منبع', graph });
    await client.updateFlow(flow.id, { settings: { executionPolicy: 'queue', errorHandlerFlowId: null } });

    const exported = await client.exportFlow(flow.id);
    expect(exported.kind).toBe('ctb.flow');
    expect(exported).not.toHaveProperty('id');
    expect(exported.settings.executionPolicy).toBe('queue');

    const imported = await client.importFlow({ botId: bot.id, export: JSON.parse(JSON.stringify(exported)) });
    expect(imported.id).not.toBe(flow.id);
    expect(imported.status).toBe('draft');
    expect(imported.graph).toEqual(flow.graph);
    expect(imported.settings).toEqual({ executionPolicy: 'queue', errorHandlerFlowId: null });
  });

  it('importFlow rejects a non-export body (400 invalid_export)', async () => {
    const { client } = loggedInClient();
    await client.login({ username: 'admin', password: 'pw' });
    const bot = await client.createBot({ name: 'b', token: VALID_TOKEN, mode: 'polling', settings: {} });
    await expect(
      client.importFlow({ botId: bot.id, export: { hello: 'world' } }),
    ).rejects.toMatchObject({ status: 400, body: { error: 'invalid_export' } });
  });

  it('lists generic templates and imports one as a new flow (P3-T7)', async () => {
    const { client } = loggedInClient();
    await client.login({ username: 'admin', password: 'pw' });
    const bot = await client.createBot({ name: 'b', token: VALID_TOKEN, mode: 'polling', settings: {} });

    const templates = await client.listFlowTemplates();
    expect(templates.map((tpl) => tpl.id)).toEqual(['hello', 'feedback', 'quiz', 'faq', 'reminder']);

    const flow = await client.importTemplate({ botId: bot.id, templateId: 'quiz', name: 'آزمون من' });
    expect(flow.name).toBe('آزمون من');
    expect(flow.status).toBe('draft');
    expect(flow.graph.nodes.length).toBeGreaterThan(0);
    expect(await client.listFlows(bot.id)).toHaveLength(1);
  });

  it('unauthenticated API call → ApiError 401', async () => {
    const { client } = loggedInClient();
    await expect(client.listBots()).rejects.toMatchObject({ status: 401 });
  });
});
