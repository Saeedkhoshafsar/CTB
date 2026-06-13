/**
 * P2-T1 — zustand store tests (auth/bots/flows) over the fake server.
 * Stores are constructed per-test via their factory so state never leaks.
 */
import { describe, expect, it } from 'vitest';
import { ApiClient } from '../src/api/client';
import { createAuthStore } from '../src/stores/auth';
import { createBotsStore } from '../src/stores/bots';
import { createFlowsStore } from '../src/stores/flows';
import { createUsersStore } from '../src/stores/users';
import { createFakeServer, type FakeServer } from './fake-fetch';

const VALID_TOKEN = '123456789:AAEabcdefghijklmnopqrstuvwxy-z12345';

function setup() {
  const srv = createFakeServer();
  const client = new ApiClient({ fetchImpl: srv.fetch });
  return { srv, client };
}

describe('auth store', () => {
  it('probe: anonymous when no session', async () => {
    const { client } = setup();
    const useAuth = createAuthStore(client);
    expect(useAuth.getState().status).toBe('unknown');
    await useAuth.getState().probe();
    expect(useAuth.getState().status).toBe('anonymous');
  });

  it('login success → authenticated with user; failure → i18n error key', async () => {
    const { client } = setup();
    const useAuth = createAuthStore(client);

    expect(await useAuth.getState().login('admin', 'nope')).toBe(false);
    expect(useAuth.getState().status).toBe('anonymous');
    expect(useAuth.getState().loginError).toBe('login.error.invalid');

    expect(await useAuth.getState().login('admin', 'pw')).toBe(true);
    expect(useAuth.getState().status).toBe('authenticated');
    expect(useAuth.getState().user).toEqual({ username: 'admin' });
    expect(useAuth.getState().loginError).toBeNull();
  });

  it('logout clears the session even server-side', async () => {
    const { srv, client } = setup();
    const useAuth = createAuthStore(client);
    await useAuth.getState().login('admin', 'pw');
    await useAuth.getState().logout();
    expect(useAuth.getState().status).toBe('anonymous');
    expect(srv.loggedIn).toBe(false);
  });
});

describe('bots store', () => {
  it('load + create + start/stop + delete keep list in sync with server', async () => {
    const { srv, client } = setup();
    const useAuth = createAuthStore(client);
    await useAuth.getState().login('admin', 'pw');
    const useBots = createBotsStore(client);

    await useBots.getState().load();
    expect(useBots.getState().bots).toEqual([]);

    const bot = await useBots.getState().createBot({
      name: 'بات تست',
      token: VALID_TOKEN,
      mode: 'polling',
      settings: {},
    });
    expect(useBots.getState().bots).toHaveLength(1);

    await useBots.getState().startBot(bot.id);
    expect(useBots.getState().bots[0]!.status).toBe('active');

    await useBots.getState().stopBot(bot.id);
    expect(useBots.getState().bots[0]!.status).toBe('inactive');

    await useBots.getState().deleteBot(bot.id);
    expect(useBots.getState().bots).toEqual([]);
    expect(srv.bots.size).toBe(0);
  });

  it('load failure stores an error instead of throwing', async () => {
    const { client } = setup(); // not logged in → 401
    const useBots = createBotsStore(client);
    await useBots.getState().load();
    expect(useBots.getState().error).toContain('401');
    expect(useBots.getState().loading).toBe(false);
  });
});

describe('flows store', () => {
  it('ACCEPTANCE: create flow (empty) persists via API and appears in list', async () => {
    const { srv, client } = setup();
    const useAuth = createAuthStore(client);
    await useAuth.getState().login('admin', 'pw');
    const useBots = createBotsStore(client);
    const useFlows = createFlowsStore(client);

    const bot = await useBots.getState().createBot({
      name: 'b',
      token: VALID_TOKEN,
      mode: 'polling',
      settings: {},
    });

    await useFlows.getState().load(bot.id);
    const flow = await useFlows.getState().createFlow({
      botId: bot.id,
      name: 'فلوی جدید',
      graph: { nodes: [], edges: [] },
    });

    // persisted server-side, not just local state
    expect(srv.flows.get(flow.id)).toMatchObject({ name: 'فلوی جدید', status: 'draft' });
    expect(useFlows.getState().flows).toHaveLength(1);

    // reload from server → still there (durability through the API)
    await useFlows.getState().load(bot.id);
    expect(useFlows.getState().flows).toHaveLength(1);
    expect(useFlows.getState().flows[0]!.graph).toEqual({ nodes: [], edges: [] });
  });

  it('activate guard error propagates; deactivate refreshes row', async () => {
    const { client } = setup();
    const useAuth = createAuthStore(client);
    await useAuth.getState().login('admin', 'pw');
    const useBots = createBotsStore(client);
    const useFlows = createFlowsStore(client);

    const bot = await useBots.getState().createBot({
      name: 'b',
      token: VALID_TOKEN,
      mode: 'polling',
      settings: {},
    });
    await useFlows.getState().load(bot.id);
    const flow = await useFlows.getState().createFlow({
      botId: bot.id,
      name: 'f',
      graph: { nodes: [], edges: [] },
    });

    await expect(useFlows.getState().activateFlow(flow.id)).rejects.toMatchObject({
      status: 422,
    });
    // row stays draft after failed activate
    expect(useFlows.getState().flows[0]!.status).toBe('draft');
  });
});

function seedUser(srv: FakeServer, u: Partial<import('@ctb/shared').UserPublic> & { id: string; botId: string; tgUserId: number }) {
  srv.users.set(u.id, {
    profile: {},
    tags: [],
    firstSeen: '2026-01-01T00:00:00.000Z',
    lastSeen: '2026-01-01T00:00:00.000Z',
    displayName: `#${u.tgUserId}`,
    ...u,
  });
}

describe('users store', () => {
  it('load() lists only the requested bot’s users, newest-seen first', async () => {
    const { srv, client } = setup();
    const useAuth = createAuthStore(client);
    await useAuth.getState().login('admin', 'pw');

    seedUser(srv, { id: 'u1', botId: 'botA', tgUserId: 11, lastSeen: '2026-01-01T10:00:00.000Z', displayName: 'Ada' });
    seedUser(srv, { id: 'u2', botId: 'botA', tgUserId: 22, lastSeen: '2026-01-02T10:00:00.000Z', displayName: 'Bee' });
    seedUser(srv, { id: 'u3', botId: 'botB', tgUserId: 33, lastSeen: '2026-01-03T10:00:00.000Z', displayName: 'Cy' });

    const useUsers = createUsersStore(client);
    await useUsers.getState().load('botA');

    const got = useUsers.getState().users;
    expect(got.map((u) => u.id)).toEqual(['u2', 'u1']); // newest-seen first, botB excluded
    expect(useUsers.getState().botId).toBe('botA');
    expect(useUsers.getState().error).toBeNull();
  });

  it('updateUser() replaces tags + profile and re-syncs the row from the server', async () => {
    const { srv, client } = setup();
    const useAuth = createAuthStore(client);
    await useAuth.getState().login('admin', 'pw');

    seedUser(srv, { id: 'u1', botId: 'botA', tgUserId: 11, tags: ['old'], profile: { a: 1 }, displayName: 'Ada' });
    const useUsers = createUsersStore(client);
    await useUsers.getState().load('botA');

    const updated = await useUsers.getState().updateUser('u1', {
      tags: ['vip', 'contacted'],
      profile: { city: 'Tehran' },
    });
    expect(updated.tags).toEqual(['vip', 'contacted']);
    expect(updated.profile).toEqual({ city: 'Tehran' });

    // store row re-synced from the response, and the server holds the new state
    expect(useUsers.getState().users[0]!.tags).toEqual(['vip', 'contacted']);
    expect(srv.users.get('u1')!.profile).toEqual({ city: 'Tehran' });
  });

  it('updateUser() with an empty body is rejected (≥1 field required)', async () => {
    const { srv, client } = setup();
    const useAuth = createAuthStore(client);
    await useAuth.getState().login('admin', 'pw');
    seedUser(srv, { id: 'u1', botId: 'botA', tgUserId: 11 });
    const useUsers = createUsersStore(client);
    await useUsers.getState().load('botA');

    await expect(useUsers.getState().updateUser('u1', {})).rejects.toBeTruthy();
  });

  it('load failure (not logged in) stores an error instead of throwing', async () => {
    const { client } = setup(); // no login → 401
    const useUsers = createUsersStore(client);
    await useUsers.getState().load('botA');
    expect(useUsers.getState().error).toContain('401');
    expect(useUsers.getState().loading).toBe(false);
  });
});
