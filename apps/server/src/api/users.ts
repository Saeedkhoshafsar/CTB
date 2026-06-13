/**
 * Users REST API (P3-T5) — the Users page backend. Lists/reads the per-bot
 * end-user records the router upserts (the `users` table), and lets an admin
 * edit the GENERIC bits: `tags` (labels) and the free-form `profile` bag. No
 * domain field is ever baked in (invariant I2) — the panel just renders
 * whatever keys the flows have written.
 *
 * Routes are scoped by `botId` (query on the list; derived from the row on
 * read/patch). All live under /api/ and are covered by the app-level auth guard.
 */
import { UpdateUserBodySchema, userDisplayName, type CtbUser, type UserPublic } from '@ctb/shared';
import type { FastifyInstance } from 'fastify';
import type { SqliteUserStore } from '../engine/user-store';

function toPublic(botId: string, u: CtbUser, id: string): UserPublic {
  return {
    id,
    botId,
    tgUserId: u.tgUserId,
    profile: u.profile,
    tags: u.tags,
    firstSeen: u.firstSeen,
    lastSeen: u.lastSeen,
    displayName: userDisplayName(u),
  };
}

export interface UsersApiDeps {
  userStore: SqliteUserStore;
}

export function registerUsersApi(app: FastifyInstance, deps: UsersApiDeps): void {
  const { userStore } = deps;

  // List users for a bot (newest-seen first). botId is required — users are
  // always per-bot; a global list would be meaningless across bots.
  app.get('/api/users', async (req, reply) => {
    const { botId, limit, offset } = req.query as {
      botId?: string;
      limit?: string;
      offset?: string;
    };
    if (!botId) return reply.code(400).send({ error: 'botId_required' });
    const rows = userStore.list(botId, {
      ...(limit !== undefined ? { limit: Number(limit) } : {}),
      ...(offset !== undefined ? { offset: Number(offset) } : {}),
    });
    return { users: rows.map((r) => toPublic(botId, r.user, r.id)) };
  });

  app.get('/api/users/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const found = userStore.getById(id);
    if (!found) return reply.code(404).send({ error: 'not_found' });
    return { user: toPublic(found.botId, found.user, id) };
  });

  // PATCH tags and/or profile (panel edits). Both optional, ≥1 required.
  app.patch('/api/users/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = UpdateUserBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_body', issues: parsed.error.issues });
    }
    const found = userStore.getById(id);
    if (!found) return reply.code(404).send({ error: 'not_found' });

    let updated = found.user;
    if (parsed.data.profile !== undefined) {
      updated = userStore.replaceProfile(found.botId, found.user.tgUserId, parsed.data.profile);
    }
    if (parsed.data.tags !== undefined) {
      updated = userStore.setTags(found.botId, found.user.tgUserId, parsed.data.tags);
    }
    return { user: toPublic(found.botId, updated, id) };
  });
}
