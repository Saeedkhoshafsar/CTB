/**
 * P1-T5 — TelegramGateway tests: registration, webhook route + secret
 * validation, dispatch → handler with normalized events, error containment.
 * No network: grammY Bot is constructed with botInfo (skips getMe) and we
 * never start polling; updates are injected via gateway.dispatch / the route.
 */
import Fastify, { type FastifyInstance } from 'fastify';
import type { Update, UserFromGetMe } from 'grammy/types';
import { afterEach, describe, expect, it } from 'vitest';
import type { TgEvent } from '../src/telegram/normalize';
import { TelegramGateway, registerWebhookRoute, webhookSecretFor } from '../src/telegram/gateway';

const SECRET = 'devsecret0123456';
const BOT_INFO: UserFromGetMe = {
  id: 42,
  is_bot: true,
  first_name: 'TestBot',
  username: 'test_bot',
  can_join_groups: true,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
  can_connect_to_business: false,
  has_main_web_app: false,
  can_manage_bots: false,
  has_topics_enabled: false,
  allows_users_to_create_topics: false,
};

function textUpdate(text: string, updateId = 1): Update {
  return {
    update_id: updateId,
    message: {
      message_id: 10,
      date: 0,
      from: { id: 111, is_bot: false, first_name: 'سعید' },
      chat: { id: 111, type: 'private', first_name: 'سعید' },
      text,
    },
  } as unknown as Update;
}

describe('TelegramGateway (P1-T5)', () => {
  let app: FastifyInstance | null = null;
  afterEach(async () => {
    if (app) await app.close();
    app = null;
  });

  it('registerBot is idempotent and exposes a sender', () => {
    const gw = new TelegramGateway({ ctbSecret: SECRET });
    const h1 = gw.registerBot('b1', 'token123:abc', { botInfo: BOT_INFO });
    const h2 = gw.registerBot('b1', 'token123:abc', { botInfo: BOT_INFO });
    expect(h1).toBe(h2);
    expect(h1.sender).toBeDefined();
    expect(h1.mode).toBe('idle');
    expect(gw.get('b1')).toBe(h1);
    expect(gw.get('nope')).toBeUndefined();
  });

  it('dispatch normalizes and forwards to the handler', async () => {
    const events: TgEvent[] = [];
    const gw = new TelegramGateway({ ctbSecret: SECRET });
    gw.setHandler(async (ev) => {
      events.push(ev);
    });
    gw.registerBot('b1', 'token123:abc', { botInfo: BOT_INFO });
    await gw.dispatch('b1', textUpdate('/start go'));
    await gw.dispatch('b1', textUpdate('سلام', 2));
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ kind: 'command', command: 'start', payload: 'go', botId: 'b1' });
    expect(events[1]).toMatchObject({ kind: 'text', text: 'سلام' });
  });

  it('handler errors are contained — gateway keeps serving', async () => {
    let calls = 0;
    const gw = new TelegramGateway({ ctbSecret: SECRET });
    gw.setHandler(async () => {
      calls += 1;
      throw new Error('flow exploded');
    });
    gw.registerBot('b1', 'token123:abc', { botInfo: BOT_INFO });
    await expect(gw.dispatch('b1', textUpdate('a'))).resolves.toBeUndefined();
    await expect(gw.dispatch('b1', textUpdate('b', 2))).resolves.toBeUndefined();
    expect(calls).toBe(2);
  });

  it('unsupported updates are dropped silently (handler not called)', async () => {
    let calls = 0;
    const gw = new TelegramGateway({ ctbSecret: SECRET });
    gw.setHandler(async () => {
      calls += 1;
    });
    gw.registerBot('b1', 'token123:abc', { botInfo: BOT_INFO });
    await gw.dispatch('b1', { update_id: 1 } as Update); // empty update
    expect(calls).toBe(0);
  });

  it('webhookSecretFor is deterministic and bot-specific', () => {
    const s1 = webhookSecretFor('b1', SECRET);
    expect(webhookSecretFor('b1', SECRET)).toBe(s1);
    expect(webhookSecretFor('b2', SECRET)).not.toBe(s1);
    expect(webhookSecretFor('b1', 'othersecret012345')).not.toBe(s1);
  });

  it('webhook route: 200 + dispatch on valid secret; 404 on bad secret/bot', async () => {
    const events: TgEvent[] = [];
    const gw = new TelegramGateway({ ctbSecret: SECRET });
    gw.setHandler(async (ev) => {
      events.push(ev);
    });
    gw.registerBot('b1', 'token123:abc', { botInfo: BOT_INFO });

    app = Fastify({ logger: false });
    registerWebhookRoute(app, gw);
    const secret = webhookSecretFor('b1', SECRET);

    const ok = await app.inject({
      method: 'POST',
      url: `/tg/b1/${secret}`,
      payload: textUpdate('/start'),
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ ok: true });
    // dispatch is fired post-reply; give the microtask queue a tick
    await new Promise((r) => setImmediate(r));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: 'command', command: 'start' });

    const badSecret = await app.inject({
      method: 'POST',
      url: '/tg/b1/wrong-secret',
      payload: textUpdate('x', 2),
    });
    expect(badSecret.statusCode).toBe(404);

    const badBot = await app.inject({
      method: 'POST',
      url: `/tg/unknown/${secret}`,
      payload: textUpdate('x', 3),
    });
    expect(badBot.statusCode).toBe(404);

    await new Promise((r) => setImmediate(r));
    expect(events).toHaveLength(1); // rejected requests never dispatched
  });

  it('stop() on an idle bot is a no-op; stopAll() never throws', async () => {
    const gw = new TelegramGateway({ ctbSecret: SECRET });
    gw.registerBot('b1', 'token123:abc', { botInfo: BOT_INFO });
    await expect(gw.stop('b1')).resolves.toBeUndefined();
    await expect(gw.stop('missing')).resolves.toBeUndefined();
    await expect(gw.stopAll()).resolves.toBeUndefined();
  });
});
