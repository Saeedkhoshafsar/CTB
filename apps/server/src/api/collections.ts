/**
 * Collections REST API (PLAN P3.5-T2) — CRUD for collection DEFINITIONS
 * (the field schema + display hints). ADMIN ONLY: defining/altering structure
 * is an admin act; the operator (manager) only ever touches records/files via
 * the records API. The app-level role guard already blocks operators from
 * everything outside /api/records & /api/files, so these routes are reachable
 * by admins only — no per-route role check needed here.
 *
 * Collections belong to one bot (ARCHITECTURE §13.7: no cross-bot collections),
 * so list is scoped by `botId` and create validates the bot exists.
 */
import {
  COLLECTION_PACKS,
  CreateCollectionBodySchema,
  ImportPackBodySchema,
  UpdateCollectionBodySchema,
  collectionPackInfo,
  findCollectionPack,
  type CollectionPublic,
  type FlowSettings,
} from '@ctb/shared';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { Db } from '../db/index';
import { bots, flows } from '../db/schema';
import {
  CollectionNotFoundError,
  type SqliteCollectionStore,
} from '../collections/store';

export interface CollectionsApiDeps {
  db: Db;
  store: SqliteCollectionStore;
}

export function registerCollectionsApi(app: FastifyInstance, deps: CollectionsApiDeps): void {
  const { db, store } = deps;

  const botExists = (botId: string): boolean =>
    db.select({ id: bots.id }).from(bots).where(eq(bots.id, botId)).get() !== undefined;

  // List collections for a bot (per-bot — a global list is meaningless §13.7).
  app.get('/api/collections', async (req, reply) => {
    const { botId } = req.query as { botId?: string };
    if (!botId) return reply.code(400).send({ error: 'botId_required' });
    return { collections: store.list(botId) };
  });

  app.get('/api/collections/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const col = store.get(id);
    if (!col) return reply.code(404).send({ error: 'not_found' });
    return { collection: col };
  });

  app.post('/api/collections', async (req, reply) => {
    const { botId } = req.query as { botId?: string };
    if (!botId) return reply.code(400).send({ error: 'botId_required' });
    if (!botExists(botId)) return reply.code(400).send({ error: 'unknown_bot' });
    const parsed = CreateCollectionBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_body', issues: parsed.error.issues });
    }
    let col: CollectionPublic;
    try {
      col = store.define(botId, {
        slug: parsed.data.slug,
        name: parsed.data.name,
        icon: parsed.data.icon ?? null,
        schema: parsed.data.schema,
        ...(parsed.data.display ? { display: parsed.data.display } : {}),
      });
    } catch (e) {
      return reply.code(409).send({ error: 'slug_taken', message: (e as Error).message });
    }
    return reply.code(201).send({ collection: col });
  });

  app.patch('/api/collections/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = UpdateCollectionBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_body', issues: parsed.error.issues });
    }
    try {
      const patch: Parameters<SqliteCollectionStore['updateDefinition']>[1] = {};
      if (parsed.data.name !== undefined) patch.name = parsed.data.name;
      if (parsed.data.icon !== undefined) patch.icon = parsed.data.icon;
      if (parsed.data.schema !== undefined) patch.schema = parsed.data.schema;
      if (parsed.data.display !== undefined) patch.display = parsed.data.display;
      const col = store.updateDefinition(id, patch);
      return { collection: col };
    } catch (e) {
      if (e instanceof CollectionNotFoundError) return reply.code(404).send({ error: 'not_found' });
      throw e;
    }
  });

  app.delete('/api/collections/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      store.deleteDefinition(id);
      return { ok: true };
    } catch (e) {
      if (e instanceof CollectionNotFoundError) return reply.code(404).send({ error: 'not_found' });
      throw e;
    }
  });

  // ---- starter pack gallery (P3.5-T6) -------------------------------------
  //
  // A pack bundles GENERIC collection schemas with the flows that operate on
  // them (the Phase 3.5 "browse → order → notify" demo). The gallery row omits
  // the heavy schema/graph payload; import creates everything in one call.

  app.get('/api/collection-packs', async () => {
    return { packs: COLLECTION_PACKS.map(collectionPackInfo) };
  });

  app.post('/api/collection-packs/import', async (req, reply) => {
    const parsed = ImportPackBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_body', issues: parsed.error.issues });
    }
    const { botId, packId } = parsed.data;
    if (!botExists(botId)) return reply.code(400).send({ error: 'unknown_bot' });

    const pack = findCollectionPack(packId);
    if (!pack) return reply.code(404).send({ error: 'unknown_pack' });

    // Collections first (the flows reference them by slug). A slug already in
    // use is SKIPPED, not an error — re-importing onto a partially set-up bot
    // is idempotent and never clobbers existing operator data.
    const existing = new Set(store.list(botId).map((c) => c.slug));
    const createdCollections: CollectionPublic[] = [];
    const skippedCollections: string[] = [];
    for (const col of pack.collections) {
      if (existing.has(col.body.slug)) {
        skippedCollections.push(col.body.slug);
        continue;
      }
      createdCollections.push(
        store.define(botId, {
          slug: col.body.slug,
          name: col.body.name,
          icon: col.body.icon ?? null,
          schema: col.body.schema,
          ...(col.body.display ? { display: col.body.display } : {}),
        }),
      );
    }

    // Then the flows (imported as DRAFTS — the operator reviews + activates).
    const createdFlows: { id: string; name: string }[] = [];
    for (const f of pack.flows) {
      const settings: FlowSettings = {
        executionPolicy: f.export.settings.executionPolicy,
        errorHandlerFlowId: null,
      };
      const id = randomUUID();
      db.insert(flows)
        .values({
          id,
          botId,
          name: f.export.name,
          status: 'draft',
          graph: f.export.graph,
          settings,
          version: 1,
          updatedAt: new Date().toISOString(),
        })
        .run();
      createdFlows.push({ id, name: f.export.name });
    }

    return reply.code(201).send({
      pack: pack.id,
      collections: createdCollections,
      skippedCollections,
      flows: createdFlows,
    });
  });
}
