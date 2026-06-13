/**
 * Credentials REST API (PLAN P3-T4) — CRUD for stored secrets used by nodes
 * (HTTP Request auth in v1). The secret payload is AES-256-GCM encrypted at
 * rest (invariant I7) and NEVER returned by any endpoint — responses expose
 * only a `*Public` projection with a masked `hint`.
 *
 * Type is immutable after creation: an update may rename and/or replace the
 * secret, but `data.type` must match the stored type so a node's bound
 * `credentialId` never silently changes auth shape. Delete + recreate to
 * change type.
 *
 * All routes live under /api/ and are covered by the app-level auth guard.
 */
import { randomUUID } from 'node:crypto';
import {
  CreateCredentialBodySchema,
  UpdateCredentialBodySchema,
  credentialHint,
  type CredentialData,
  type CredentialPublic,
} from '@ctb/shared';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { Db } from '../db/index';
import { credentials } from '../db/schema';
import { decrypt, encrypt } from '../lib/crypto';

type CredentialRow = typeof credentials.$inferSelect;

/** Public projection — the secret NEVER leaves the server (I7). */
function toPublic(row: CredentialRow, key: Buffer): CredentialPublic {
  let hint = '(undecryptable)';
  try {
    const data = JSON.parse(decrypt(row.dataEnc, key)) as CredentialData;
    hint = credentialHint(data);
  } catch {
    /* leave the undecryptable marker */
  }
  return {
    id: row.id,
    name: row.name,
    type: row.type as CredentialPublic['type'],
    hint,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export interface CredentialsApiDeps {
  db: Db;
  key: Buffer;
  clock?: () => Date;
}

export function registerCredentialsApi(app: FastifyInstance, deps: CredentialsApiDeps): void {
  const { db, key } = deps;
  const now = (): string => (deps.clock ?? (() => new Date()))().toISOString();

  app.get('/api/credentials', async () => {
    const rows = db.select().from(credentials).all();
    return { credentials: rows.map((r) => toPublic(r, key)) };
  });

  app.get('/api/credentials/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const row = db.select().from(credentials).where(eq(credentials.id, id)).get();
    if (!row) return reply.code(404).send({ error: 'not_found' });
    return { credential: toPublic(row, key) };
  });

  app.post('/api/credentials', async (req, reply) => {
    const parsed = CreateCredentialBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_body', issues: parsed.error.issues });
    }
    const ts = now();
    const row: CredentialRow = {
      id: randomUUID(),
      name: parsed.data.name,
      type: parsed.data.data.type,
      dataEnc: encrypt(JSON.stringify(parsed.data.data), key),
      createdAt: ts,
      updatedAt: ts,
    };
    db.insert(credentials).values(row).run();
    return reply.code(201).send({ credential: toPublic(row, key) });
  });

  app.patch('/api/credentials/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = UpdateCredentialBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_body', issues: parsed.error.issues });
    }
    const row = db.select().from(credentials).where(eq(credentials.id, id)).get();
    if (!row) return reply.code(404).send({ error: 'not_found' });

    // Type is immutable — replacing the secret must keep the same shape so any
    // node bound to this credentialId never silently changes auth method.
    if (parsed.data.data !== undefined && parsed.data.data.type !== row.type) {
      return reply.code(400).send({ error: 'type_immutable' });
    }

    const patch: Partial<CredentialRow> = { updatedAt: now() };
    if (parsed.data.name !== undefined) patch.name = parsed.data.name;
    if (parsed.data.data !== undefined) patch.dataEnc = encrypt(JSON.stringify(parsed.data.data), key);
    db.update(credentials).set(patch).where(eq(credentials.id, id)).run();

    const updated = db.select().from(credentials).where(eq(credentials.id, id)).get()!;
    return { credential: toPublic(updated, key) };
  });

  app.delete('/api/credentials/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const row = db.select().from(credentials).where(eq(credentials.id, id)).get();
    if (!row) return reply.code(404).send({ error: 'not_found' });
    db.delete(credentials).where(eq(credentials.id, id)).run();
    return { ok: true };
  });
}
