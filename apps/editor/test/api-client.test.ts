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

  it('unauthenticated API call → ApiError 401', async () => {
    const { client } = loggedInClient();
    await expect(client.listBots()).rejects.toMatchObject({ status: 401 });
  });
});
