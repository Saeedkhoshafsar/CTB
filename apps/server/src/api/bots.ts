/**
 * Bots REST API (PLAN P1-T8) — CRUD for Telegram bot registrations.
 *
 * The token is AES-256-GCM encrypted at rest (invariant I7) and NEVER returned
 * by any endpoint — responses expose only a masked hint ("1234567890:AAE…xyz").
 * Start/stop wires the bot into the TelegramGateway (polling or webhook).
 *
 * All routes live under /api/ and are covered by the app-level auth guard.
 */
import { randomUUID } from 'node:crypto';
import {
  CreateBotBodySchema,
  SetBotAiBudgetBodySchema,
  UpdateBotBodySchema,
  readBotAiBudget,
} from '@ctb/shared';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { Db } from '../db/index';
import { bots } from '../db/schema';
import { decrypt, encrypt } from '../lib/crypto';
import type { SqliteAiUsageStore } from '../engine/ai-usage-store';
import type { TelegramGateway } from '../telegram/gateway';

// Body schemas live in @ctb/shared (P2-T1) so the editor's typed client
// validates against the exact same contract (invariant I5).

type BotRow = typeof bots.$inferSelect;

/** Public projection — token NEVER leaves the server (I7). */
function toPublic(row: BotRow, key: Buffer): Record<string, unknown> {
  let tokenHint = '';
  try {
    const token = decrypt(row.tokenEnc, key);
    const [id = '', rest = ''] = token.split(':');
    tokenHint = `${id}:${rest.slice(0, 3)}…${rest.slice(-3)}`;
  } catch {
    tokenHint = '(undecryptable)';
  }
  return {
    id: row.id,
    name: row.name,
    tokenHint,
    mode: row.mode,
    status: row.status,
    settings: row.settings,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export interface BotsApiDeps {
  db: Db;
  key: Buffer;
  gateway: TelegramGateway;
  /** AI spend ledger (PD-T2) — powers GET /ai-usage; budget lives in bots.settings. */
  aiUsageStore?: SqliteAiUsageStore;
  /** Public base URL for webhook registration (env CTB_PUBLIC_URL). */
  publicUrl?: string | undefined;
  /** Registration extras for tests (botInfo / fake transport). */
  registerOpts?: (botId: string) => import('../telegram/gateway').RegisterBotOptions;
  clock?: () => Date;
}

export function registerBotsApi(app: FastifyInstance, deps: BotsApiDeps): void {
  const { db, key, gateway } = deps;
  const now = (): string => (deps.clock ?? (() => new Date()))().toISOString();

  app.get('/api/bots', async () => {
    const rows = db.select().from(bots).all();
    return { bots: rows.map((r) => toPublic(r, key)) };
  });

  app.get('/api/bots/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const row = db.select().from(bots).where(eq(bots.id, id)).get();
    if (!row) return reply.code(404).send({ error: 'not_found' });
    return { bot: toPublic(row, key) };
  });

  app.post('/api/bots', async (req, reply) => {
    const parsed = CreateBotBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_body', issues: parsed.error.issues });
    }
    const ts = now();
    const row: BotRow = {
      id: randomUUID(),
      name: parsed.data.name,
      tokenEnc: encrypt(parsed.data.token, key),
      mode: parsed.data.mode,
      status: 'inactive',
      settings: parsed.data.settings,
      createdAt: ts,
      updatedAt: ts,
    };
    db.insert(bots).values(row).run();
    return reply.code(201).send({ bot: toPublic(row, key) });
  });

  app.patch('/api/bots/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = UpdateBotBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_body', issues: parsed.error.issues });
    }
    const row = db.select().from(bots).where(eq(bots.id, id)).get();
    if (!row) return reply.code(404).send({ error: 'not_found' });

    const patch: Partial<BotRow> = { updatedAt: now() };
    if (parsed.data.name !== undefined) patch.name = parsed.data.name;
    if (parsed.data.mode !== undefined) patch.mode = parsed.data.mode;
    if (parsed.data.settings !== undefined) patch.settings = parsed.data.settings;
    if (parsed.data.token !== undefined) patch.tokenEnc = encrypt(parsed.data.token, key);
    db.update(bots).set(patch).where(eq(bots.id, id)).run();

    const updated = db.select().from(bots).where(eq(bots.id, id)).get()!;
    return { bot: toPublic(updated, key) };
  });

  app.delete('/api/bots/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const row = db.select().from(bots).where(eq(bots.id, id)).get();
    if (!row) return reply.code(404).send({ error: 'not_found' });
    await gateway.stop(id);
    db.delete(bots).where(eq(bots.id, id)).run(); // flows/executions cascade
    return { ok: true };
  });

  /** Start receiving updates: registers with the gateway, polling or webhook. */
  app.post('/api/bots/:id/start', async (req, reply) => {
    const { id } = req.params as { id: string };
    const row = db.select().from(bots).where(eq(bots.id, id)).get();
    if (!row) return reply.code(404).send({ error: 'not_found' });

    let token: string;
    try {
      token = decrypt(row.tokenEnc, key);
    } catch {
      return reply.code(500).send({ error: 'token_undecryptable' });
    }

    try {
      gateway.registerBot(id, token, deps.registerOpts?.(id) ?? {});
      let webhookUrl: string | undefined;
      if (row.mode === 'webhook') {
        if (!deps.publicUrl) {
          return reply.code(400).send({ error: 'webhook_mode_requires_public_url' });
        }
        webhookUrl = await gateway.enableWebhook(id, deps.publicUrl);
      } else {
        await gateway.startPolling(id);
      }
      db.update(bots).set({ status: 'active', updatedAt: now() }).where(eq(bots.id, id)).run();
      return { ok: true, mode: row.mode, ...(webhookUrl ? { webhookUrl } : {}) };
    } catch (err) {
      db.update(bots).set({ status: 'error', updatedAt: now() }).where(eq(bots.id, id)).run();
      req.log.error({ err }, `failed to start bot ${id}`);
      return reply.code(502).send({ error: 'bot_start_failed' });
    }
  });

  app.post('/api/bots/:id/stop', async (req, reply) => {
    const { id } = req.params as { id: string };
    const row = db.select().from(bots).where(eq(bots.id, id)).get();
    if (!row) return reply.code(404).send({ error: 'not_found' });
    await gateway.stop(id);
    db.update(bots).set({ status: 'inactive', updatedAt: now() }).where(eq(bots.id, id)).run();
    return { ok: true };
  });

  // ---- AI cost governance (PD-T2) -----------------------------------------

  /**
   * GET the bot's AI spend summary — its budget (from bots.settings.aiBudget),
   * today's + all-time call/token totals, and per-credential breakdown. Powers
   * the panel's AI-usage view. Returns an empty summary when no ledger is wired.
   */
  app.get('/api/bots/:id/ai-usage', async (req, reply) => {
    const { id } = req.params as { id: string };
    const row = db.select().from(bots).where(eq(bots.id, id)).get();
    if (!row) return reply.code(404).send({ error: 'not_found' });
    const budget = readBotAiBudget((row.settings ?? {}) as Record<string, unknown>);
    if (!deps.aiUsageStore) {
      return {
        usage: {
          budget,
          today: { calls: 0, totalTokens: 0 },
          allTime: { calls: 0, totalTokens: 0 },
          byCredential: [],
        },
      };
    }
    return { usage: deps.aiUsageStore.summary(id, budget) };
  });

  /**
   * PUT the bot's AI budget — daily token/call caps + per-run token cap, stored
   * as `aiBudget` inside the bot's free `settings` JSON (no config migration).
   * `0` on any field means unlimited. The per-run `ctx.ai.chat` wrapper reads
   * this on the next call (fail-closed once a daily cap is hit).
   */
  app.put('/api/bots/:id/ai-budget', async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = SetBotAiBudgetBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_body', issues: parsed.error.issues });
    }
    const row = db.select().from(bots).where(eq(bots.id, id)).get();
    if (!row) return reply.code(404).send({ error: 'not_found' });
    const settings = { ...((row.settings ?? {}) as Record<string, unknown>), aiBudget: parsed.data };
    db.update(bots).set({ settings, updatedAt: now() }).where(eq(bots.id, id)).run();
    return { budget: parsed.data };
  });
}
