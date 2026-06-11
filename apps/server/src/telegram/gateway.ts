/**
 * Telegram gateway (ARCHITECTURE §9, PLAN P1-T5).
 *
 * Owns the bot lifecycle: register token → grammY instance + centralized
 * TgSender; receive updates via webhook (`POST /tg/:botId/:secret`) or
 * long-polling (dev / no-domain setups); normalize every update to a TgEvent
 * and hand it to ONE injected handler (the update router, P1-T6).
 *
 * The gateway never touches the DB and never parses params — it is the edge
 * between Telegram and the engine. Tokens arrive already decrypted (the bots
 * API layer, P1-T8, owns crypto).
 */
import { createHmac } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { Bot } from 'grammy';
import type { Update, UserFromGetMe } from 'grammy/types';
import { safeEqual } from '../lib/session';
import { type TgEvent, normalizeUpdate } from './normalize';
import { type CallApi, type SenderOptions, TgSender } from './sender';

export type TgEventHandler = (event: TgEvent) => Promise<void>;

export interface RegisterBotOptions {
  /** Pre-resolved bot info skips grammY's startup getMe (required in tests). */
  botInfo?: UserFromGetMe;
  /** Sender tuning / fake clock for tests. */
  sender?: SenderOptions;
  /** Test transport — replaces bot.api.raw so e2e tests never hit the network. */
  callApi?: CallApi;
}

export interface BotHandle {
  botId: string;
  bot: Bot;
  sender: TgSender;
  mode: 'idle' | 'polling' | 'webhook';
}

/**
 * Webhook path secret — deterministic per bot, derived from CTB_SECRET so it
 * survives restarts without another DB column. Unguessable per ARCH §11.
 */
export function webhookSecretFor(botId: string, ctbSecret: string): string {
  return createHmac('sha256', `ctb-webhook-v1:${ctbSecret}`).update(botId).digest('base64url');
}

export class TelegramGateway {
  private readonly bots = new Map<string, BotHandle>();
  private readonly ctbSecret: string;
  private handler: TgEventHandler;

  constructor(opts: { ctbSecret: string; handler?: TgEventHandler }) {
    this.ctbSecret = opts.ctbSecret;
    this.handler = opts.handler ?? (async () => undefined);
  }

  /** The update router (P1-T6) plugs itself in here. */
  setHandler(handler: TgEventHandler): void {
    this.handler = handler;
  }

  /** Register a bot. Token must already be decrypted. Idempotent per botId. */
  registerBot(botId: string, token: string, opts: RegisterBotOptions = {}): BotHandle {
    const existing = this.bots.get(botId);
    if (existing) return existing;

    const bot = new Bot(token, opts.botInfo ? { botInfo: opts.botInfo } : undefined);
    const transport: CallApi =
      opts.callApi ??
      ((method, payload) => bot.api.raw[method as keyof typeof bot.api.raw](payload as never));
    const sender = new TgSender(transport, opts.sender);

    // Single catch-all listener: normalize → handler. Errors are contained —
    // a failing flow must never crash the gateway (CLAUDE §7).
    bot.on(['message', 'callback_query'], async (ctx) => {
      await this.dispatch(botId, ctx.update);
    });

    const handle: BotHandle = { botId, bot, sender, mode: 'idle' };
    this.bots.set(botId, handle);
    return handle;
  }

  get(botId: string): BotHandle | undefined {
    return this.bots.get(botId);
  }

  /** Normalize + route one update. Used by both webhook route and polling. */
  async dispatch(botId: string, update: Update): Promise<void> {
    const event = normalizeUpdate(botId, update);
    if (!event) return; // unsupported update kind — dropped by design
    try {
      await this.handler(event);
    } catch (err) {
      // Contain: log via console here; structured exec_logs happen inside the
      // router/executor. The gateway must keep serving the next update.
      // eslint-disable-next-line no-console
      console.error(`[gateway] handler error for bot ${botId}:`, err);
    }
  }

  /** Long-polling mode (dev / no public domain). */
  async startPolling(botId: string): Promise<void> {
    const handle = this.mustGet(botId);
    if (handle.mode === 'polling') return;
    handle.mode = 'polling';
    // bot.start() resolves only when stopped — fire and forget, errors logged.
    void handle.bot.start({ drop_pending_updates: true }).catch((err) => {
      handle.mode = 'idle';
      // eslint-disable-next-line no-console
      console.error(`[gateway] polling crashed for bot ${botId}:`, err);
    });
  }

  /** Webhook mode: register the public URL with Telegram. */
  async enableWebhook(botId: string, publicBaseUrl: string): Promise<string> {
    const handle = this.mustGet(botId);
    const secret = webhookSecretFor(botId, this.ctbSecret);
    const url = `${publicBaseUrl.replace(/\/$/, '')}/tg/${botId}/${secret}`;
    await handle.bot.api.setWebhook(url);
    handle.mode = 'webhook';
    return url;
  }

  async stop(botId: string): Promise<void> {
    const handle = this.bots.get(botId);
    if (!handle) return;
    if (handle.mode === 'polling') {
      // grammY throws if the polling loop never actually started (e.g. it
      // crashed at boot, or tests with a fake transport). stop() must stay
      // idempotent and never propagate that.
      await handle.bot.stop().catch(() => undefined);
    }
    handle.mode = 'idle';
  }

  async stopAll(): Promise<void> {
    for (const id of this.bots.keys()) await this.stop(id);
  }

  /** Validate an incoming webhook path secret (timing-safe). */
  verifyWebhookSecret(botId: string, given: string): boolean {
    return safeEqual(given, webhookSecretFor(botId, this.ctbSecret));
  }

  private mustGet(botId: string): BotHandle {
    const handle = this.bots.get(botId);
    if (!handle) throw new Error(`bot not registered: ${botId}`);
    return handle;
  }
}

/**
 * Fastify route: POST /tg/:botId/:secret — the webhook receiver.
 * Always answers 200 fast (Telegram retries non-200s aggressively); the
 * dispatch itself runs after the reply is sent.
 */
export function registerWebhookRoute(app: FastifyInstance, gateway: TelegramGateway): void {
  app.post<{ Params: { botId: string; secret: string }; Body: Update }>(
    '/tg/:botId/:secret',
    async (req, reply) => {
      const { botId, secret } = req.params;
      const handle = gateway.get(botId);
      if (!handle || !gateway.verifyWebhookSecret(botId, secret)) {
        return reply.code(404).send({ error: 'not_found' });
      }
      // Acknowledge immediately; process out-of-band so slow flows (WAIT,
      // HTTP nodes…) never make Telegram re-deliver the update.
      void gateway.dispatch(botId, req.body).catch(() => undefined);
      return reply.code(200).send({ ok: true });
    },
  );
}
