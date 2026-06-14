/**
 * Instance-webhook management (P4-T4) — admin-only CRUD for the OUTBOUND
 * webhooks CTB POSTs when events fire (PROTOCOL.md §Outbound). Distinct from
 * the inbound webhook trigger (triggers/webhook.ts) and the v1 token surface.
 *
 *   GET    /api/instance-webhooks          → InstanceWebhookPublic[]
 *   POST   /api/instance-webhooks          → { webhook: InstanceWebhookPublic } (201)
 *   PATCH  /api/instance-webhooks/:id       → { webhook: InstanceWebhookPublic }
 *   DELETE /api/instance-webhooks/:id       → { ok:true }
 *
 * The `secret` (HMAC signing key) is WRITE-ONLY: it is accepted on create/update
 * but never returned — the public projection exposes only `hasSecret` (I7). All
 * routes sit under /api/ and so are behind the panel cookie-auth guard.
 */
import { randomUUID } from 'node:crypto';
import {
  CreateInstanceWebhookBodySchema,
  UpdateInstanceWebhookBodySchema,
  type InstanceWebhookPublic,
  type OutboundEventName,
} from '@ctb/shared';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { Db } from '../db/index';
import { bots, instanceWebhooks } from '../db/schema';

type WebhookRow = typeof instanceWebhooks.$inferSelect;

function toPublic(row: WebhookRow): InstanceWebhookPublic {
  return {
    id: row.id,
    name: row.name,
    url: row.url,
    hasSecret: row.secret !== null && row.secret !== '',
    events: row.events as OutboundEventName[],
    botId: row.botId,
    active: row.active,
    createdAt: row.createdAt,
    lastFiredAt: row.lastFiredAt,
    lastError: row.lastError,
  };
}

export interface InstanceWebhooksApiDeps {
  db: Db;
  clock?: () => Date;
}

export function registerInstanceWebhooksApi(
  app: FastifyInstance,
  deps: InstanceWebhooksApiDeps,
): void {
  const { db } = deps;
  const now = (): string => (deps.clock ?? (() => new Date()))().toISOString();

  app.get('/api/instance-webhooks', async () => {
    const rows = db.select().from(instanceWebhooks).all();
    return { webhooks: rows.map(toPublic) };
  });

  app.post('/api/instance-webhooks', async (req, reply) => {
    const parsed = CreateInstanceWebhookBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_body', issues: parsed.error.issues });
    }
    const botId = parsed.data.botId ?? null;
    if (botId !== null) {
      const bot = db.select().from(bots).where(eq(bots.id, botId)).get();
      if (!bot) return reply.code(400).send({ error: 'unknown_bot' });
    }

    const row: WebhookRow = {
      id: randomUUID(),
      name: parsed.data.name,
      url: parsed.data.url,
      secret: parsed.data.secret ?? null,
      events: parsed.data.events,
      botId,
      active: parsed.data.active ?? true,
      createdAt: now(),
      lastFiredAt: null,
      lastError: null,
    };
    db.insert(instanceWebhooks).values(row).run();
    return reply.code(201).send({ webhook: toPublic(row) });
  });

  app.patch('/api/instance-webhooks/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = UpdateInstanceWebhookBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_body', issues: parsed.error.issues });
    }
    const existing = db.select().from(instanceWebhooks).where(eq(instanceWebhooks.id, id)).get();
    if (!existing) return reply.code(404).send({ error: 'not_found' });

    const d = parsed.data;
    if (d.botId !== undefined && d.botId !== null) {
      const bot = db.select().from(bots).where(eq(bots.id, d.botId)).get();
      if (!bot) return reply.code(400).send({ error: 'unknown_bot' });
    }

    // Build a partial patch — only set keys the caller actually sent. `secret`
    // and `botId` are nullable (explicit null clears them); the others are
    // value-only optionals.
    const patch: Partial<WebhookRow> = {};
    if (d.name !== undefined) patch.name = d.name;
    if (d.url !== undefined) patch.url = d.url;
    if (d.secret !== undefined) patch.secret = d.secret ?? null;
    if (d.events !== undefined) patch.events = d.events;
    if (d.botId !== undefined) patch.botId = d.botId ?? null;
    if (d.active !== undefined) patch.active = d.active;

    db.update(instanceWebhooks).set(patch).where(eq(instanceWebhooks.id, id)).run();
    const updated = db.select().from(instanceWebhooks).where(eq(instanceWebhooks.id, id)).get();
    return { webhook: toPublic(updated as WebhookRow) };
  });

  app.delete('/api/instance-webhooks/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const row = db.select().from(instanceWebhooks).where(eq(instanceWebhooks.id, id)).get();
    if (!row) return reply.code(404).send({ error: 'not_found' });
    db.delete(instanceWebhooks).where(eq(instanceWebhooks.id, id)).run();
    return { ok: true };
  });
}
