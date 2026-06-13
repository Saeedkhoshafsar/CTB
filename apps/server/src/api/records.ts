/**
 * Records REST API (PLAN P3.5-T2) — record CRUD + query + file upload/download.
 * Reachable by BOTH roles: admin and operator (the manager). The app-level role
 * guard lets operators reach exactly `/api/records*` and `/api/files*`, so this
 * is the operator's whole world.
 *
 * The query endpoint is a POST that takes the shared `RecordFilter` verbatim
 * (the same shape the store and the `data.collection` node use — invariant I5),
 * so the panel's filter builder, the API and the node can never drift.
 *
 * File upload is a small JSON+base64 body (no multipart runtime dep): the bytes
 * land on local disk via SqliteFileStore and the returned id is what an
 * `image`/`file` record field stores. Download streams the bytes back.
 */
import {
  CreateRecordBodySchema,
  QueryRecordsBodySchema,
  RecordValidationError,
  UpdateRecordBodySchema,
  type RecordPublic,
} from '@ctb/shared';
import { z } from 'zod';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { SessionRole } from '../lib/session';
import { RecordNotFoundError, type SqliteCollectionStore } from '../collections/store';
import { FileNotFoundError, fileToPublic, type SqliteFileStore } from '../collections/file-store';

export interface RecordsApiDeps {
  store: SqliteCollectionStore;
  fileStore: SqliteFileStore;
}

/** Who performed the write — provenance for the recordChanged trigger (§13.6). */
function provenance(req: FastifyRequest): string {
  const role = (req as FastifyRequest & { session?: { role?: SessionRole } }).session?.role;
  return role === 'operator' ? 'operator' : 'admin';
}

const UploadBodySchema = z.object({
  /** Base64-encoded file bytes. */
  data: z.string().min(1),
  mime: z.string().max(255).optional(),
});

export function registerRecordsApi(app: FastifyInstance, deps: RecordsApiDeps): void {
  const { store, fileStore } = deps;

  const requireCollection = (collectionId: string) => store.get(collectionId);

  // ---- records ------------------------------------------------------------

  // List records (simple) — GET with optional limit/offset. For filtered
  // queries use the POST /query endpoint (nested `where` rows don't fit a URL).
  app.get('/api/records/:collectionId', async (req, reply) => {
    const { collectionId } = req.params as { collectionId: string };
    if (!requireCollection(collectionId)) return reply.code(404).send({ error: 'unknown_collection' });
    const { limit, offset } = req.query as { limit?: string; offset?: string };
    const res = store.find(collectionId, {
      ...(limit !== undefined ? { limit: Number(limit) } : {}),
      ...(offset !== undefined ? { offset: Number(offset) } : {}),
    });
    return { records: res.records, total: res.total };
  });

  // Filtered query — POST so the full RecordFilter travels as JSON.
  app.post('/api/records/:collectionId/query', async (req, reply) => {
    const { collectionId } = req.params as { collectionId: string };
    if (!requireCollection(collectionId)) return reply.code(404).send({ error: 'unknown_collection' });
    const parsed = QueryRecordsBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_body', issues: parsed.error.issues });
    }
    try {
      const res = store.find(collectionId, parsed.data);
      return { records: res.records, total: res.total };
    } catch (e) {
      return reply.code(400).send({ error: 'invalid_filter', message: (e as Error).message });
    }
  });

  app.get('/api/records/:collectionId/count', async (req, reply) => {
    const { collectionId } = req.params as { collectionId: string };
    if (!requireCollection(collectionId)) return reply.code(404).send({ error: 'unknown_collection' });
    return { count: store.count(collectionId) };
  });

  app.get('/api/records/:collectionId/:id', async (req, reply) => {
    const { collectionId, id } = req.params as { collectionId: string; id: string };
    if (!requireCollection(collectionId)) return reply.code(404).send({ error: 'unknown_collection' });
    const rec = store.getRecord(id);
    if (!rec || rec.collectionId !== collectionId) return reply.code(404).send({ error: 'not_found' });
    return { record: rec };
  });

  app.post('/api/records/:collectionId', async (req, reply) => {
    const { collectionId } = req.params as { collectionId: string };
    if (!requireCollection(collectionId)) return reply.code(404).send({ error: 'unknown_collection' });
    const parsed = CreateRecordBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_body', issues: parsed.error.issues });
    }
    let rec: RecordPublic;
    try {
      rec = store.insert(collectionId, parsed.data.data, provenance(req));
    } catch (e) {
      if (e instanceof RecordValidationError) {
        return reply.code(422).send({ error: 'validation_failed', fields: e.errors });
      }
      throw e;
    }
    return reply.code(201).send({ record: rec });
  });

  app.patch('/api/records/:collectionId/:id', async (req, reply) => {
    const { collectionId, id } = req.params as { collectionId: string; id: string };
    if (!requireCollection(collectionId)) return reply.code(404).send({ error: 'unknown_collection' });
    const existing = store.getRecord(id);
    if (!existing || existing.collectionId !== collectionId) {
      return reply.code(404).send({ error: 'not_found' });
    }
    const parsed = UpdateRecordBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_body', issues: parsed.error.issues });
    }
    try {
      const rec = store.update(id, parsed.data.data, {
        mode: parsed.data.mode,
        updatedBy: provenance(req),
      });
      return { record: rec };
    } catch (e) {
      if (e instanceof RecordValidationError) {
        return reply.code(422).send({ error: 'validation_failed', fields: e.errors });
      }
      if (e instanceof RecordNotFoundError) return reply.code(404).send({ error: 'not_found' });
      throw e;
    }
  });

  app.delete('/api/records/:collectionId/:id', async (req, reply) => {
    const { collectionId, id } = req.params as { collectionId: string; id: string };
    if (!requireCollection(collectionId)) return reply.code(404).send({ error: 'unknown_collection' });
    const existing = store.getRecord(id);
    if (!existing || existing.collectionId !== collectionId) {
      return reply.code(404).send({ error: 'not_found' });
    }
    store.deleteRecord(id);
    return { ok: true };
  });

  // ---- files --------------------------------------------------------------

  // Upload: JSON { data: base64, mime } scoped to a bot. Returns the file id +
  // download URL an `image`/`file` field then stores.
  app.post('/api/files', async (req, reply) => {
    const { botId } = req.query as { botId?: string };
    if (!botId) return reply.code(400).send({ error: 'botId_required' });
    const parsed = UploadBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_body', issues: parsed.error.issues });
    }
    let bytes: Buffer;
    try {
      bytes = Buffer.from(parsed.data.data, 'base64');
    } catch {
      return reply.code(400).send({ error: 'invalid_base64' });
    }
    if (bytes.length === 0) return reply.code(400).send({ error: 'empty_file' });
    const file = fileStore.putLocal(botId, bytes, parsed.data.mime ?? null);
    return reply.code(201).send({ file });
  });

  // Download: stream the stored bytes back.
  app.get('/api/files/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const { bytes, mime } = fileStore.readLocal(id);
      reply.header('content-type', mime ?? 'application/octet-stream');
      return reply.send(bytes);
    } catch (e) {
      if (e instanceof FileNotFoundError) return reply.code(404).send({ error: 'not_found' });
      throw e;
    }
  });

  app.get('/api/files/:id/meta', async (req, reply) => {
    const { id } = req.params as { id: string };
    const row = fileStore.get(id);
    if (!row) return reply.code(404).send({ error: 'not_found' });
    return { file: fileToPublic(row) };
  });

  app.delete('/api/files/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!fileStore.delete(id)) return reply.code(404).send({ error: 'not_found' });
    return { ok: true };
  });
}
