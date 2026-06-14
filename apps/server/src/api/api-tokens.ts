/**
 * API-token management (P4-T3) — admin-only CRUD for the bearer tokens that
 * authenticate the public `/api/v1/*` surface (see api/v1.ts + PROTOCOL.md).
 *
 *   GET    /api/api-tokens            → ApiTokenPublic[] (never the secret)
 *   POST   /api/api-tokens            → ApiTokenCreated  (plaintext shown ONCE)
 *   DELETE /api/api-tokens/:id        → { ok:true }      (revoke)
 *
 * The plaintext token is generated server-side, returned exactly once in the
 * create response, and never stored — only its SHA-256 hash + a non-secret
 * display prefix live in the DB. All routes are under /api/ and so are behind
 * the app-level cookie-auth guard (admin/operator); v1 is the only token-auth
 * surface — these management routes are panel-session only.
 */
import { randomUUID } from 'node:crypto';
import {
  CreateApiTokenBodySchema,
  type ApiTokenCreated,
  type ApiTokenPublic,
} from '@ctb/shared';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { Db } from '../db/index';
import { apiTokens, bots } from '../db/schema';
import { generateApiToken } from '../lib/api-token';

type TokenRow = typeof apiTokens.$inferSelect;

function toPublic(row: TokenRow): ApiTokenPublic {
  return {
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    botId: row.botId,
    createdAt: row.createdAt,
    lastUsedAt: row.lastUsedAt,
  };
}

export interface ApiTokensApiDeps {
  db: Db;
  clock?: () => Date;
}

export function registerApiTokensApi(app: FastifyInstance, deps: ApiTokensApiDeps): void {
  const { db } = deps;
  const now = (): string => (deps.clock ?? (() => new Date()))().toISOString();

  app.get('/api/api-tokens', async () => {
    const rows = db.select().from(apiTokens).all();
    return { tokens: rows.map(toPublic) };
  });

  app.post('/api/api-tokens', async (req, reply) => {
    const parsed = CreateApiTokenBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_body', issues: parsed.error.issues });
    }
    const botId = parsed.data.botId ?? null;
    if (botId !== null) {
      const bot = db.select().from(bots).where(eq(bots.id, botId)).get();
      if (!bot) return reply.code(400).send({ error: 'unknown_bot' });
    }

    const gen = generateApiToken();
    const row: TokenRow = {
      id: randomUUID(),
      name: parsed.data.name,
      tokenHash: gen.tokenHash,
      prefix: gen.prefix,
      botId,
      createdAt: now(),
      lastUsedAt: null,
    };
    db.insert(apiTokens).values(row).run();

    // The ONLY time the plaintext token is revealed.
    const created: ApiTokenCreated = { ...toPublic(row), token: gen.token };
    return reply.code(201).send({ apiToken: created });
  });

  app.delete('/api/api-tokens/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const row = db.select().from(apiTokens).where(eq(apiTokens.id, id)).get();
    if (!row) return reply.code(404).send({ error: 'not_found' });
    db.delete(apiTokens).where(eq(apiTokens.id, id)).run();
    return { ok: true };
  });
}
