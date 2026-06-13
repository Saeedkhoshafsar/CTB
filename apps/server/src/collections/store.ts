/**
 * SqliteCollectionStore (P3.5-T1) — the host-side data layer for Collections
 * (ARCHITECTURE §13). It owns BOTH halves the contract demands:
 *
 *   1. collection definitions  (the `collections` table: slug, name, schema JSON)
 *   2. records                 (the `records` table: one JSON `data` document
 *                               per row, validated against the collection's
 *                               schema on every write — §13.3)
 *
 * Records are JSON documents, never dynamic DDL (§13.3). Queries therefore
 * compile the shared `RecordFilter` into SQLite `json_extract` SQL via ONE
 * builder here (§13.4) — the same filter shape the REST API and the
 * `data.collection` node use. Hot fields flagged `indexed` in the schema get a
 * real SQLite **expression index** on `json_extract(data,'$.key')`, created/
 * dropped to match the schema on define/update.
 *
 * Validation is delegated to the PURE `validateRecord` in @ctb/shared so the
 * server, the API and the node can never disagree (invariant I5). Schema edits
 * are additive-safe: old records are defaulted on read (`applyDefaults`) and
 * lazily re-validated on their next write.
 *
 * The store talks to raw `better-sqlite3` for the json_extract reads + index
 * DDL (Drizzle has no first-class json_extract path) and uses Drizzle for the
 * plain typed CRUD on the two tables. Both share the one connection.
 */
import { randomUUID } from 'node:crypto';
import type BetterSqlite3 from 'better-sqlite3';
import {
  applyDefaults,
  indexedFields,
  validateRecord,
  type CollectionDisplay,
  type CollectionPublic,
  type CollectionSchemaDoc,
  type RecordFilter,
  type RecordPublic,
  type WhereRow,
} from '@ctb/shared';
import { and, eq } from 'drizzle-orm';
import type { Db } from '../db/index';
import { collections, records } from '../db/schema';

type CollectionRow = typeof collections.$inferSelect;
type RecordRow = typeof records.$inferSelect;

/** Raised when an operation targets a slug/id that does not exist. */
export class CollectionNotFoundError extends Error {
  constructor(ref: string) {
    super(`collection not found: ${ref}`);
    this.name = 'CollectionNotFoundError';
  }
}
export class RecordNotFoundError extends Error {
  constructor(id: string) {
    super(`record not found: ${id}`);
    this.name = 'RecordNotFoundError';
  }
}
/** A multi-row delete attempted without the explicit `confirmMany` guard. */
export class MultiDeleteGuardError extends Error {
  constructor(readonly count: number) {
    super(`refusing to delete ${count} records without confirmMany`);
    this.name = 'MultiDeleteGuardError';
  }
}

export interface DefineCollectionInput {
  slug: string;
  name: string;
  icon?: string | null;
  schema: CollectionSchemaDoc;
  display?: CollectionDisplay;
}

export interface ListRecordsResult {
  records: RecordPublic[];
  /** Total matching rows ignoring limit/offset (for pagination). */
  total: number;
}

function rowToCollection(row: CollectionRow): CollectionPublic {
  return {
    id: row.id,
    botId: row.botId,
    slug: row.slug,
    name: row.name,
    icon: row.icon ?? null,
    schema: row.schema as CollectionSchemaDoc,
    display: (row.display as CollectionDisplay) ?? {},
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export class SqliteCollectionStore {
  constructor(
    private readonly db: Db,
    private readonly sqlite: BetterSqlite3.Database,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  private now(): string {
    return this.clock().toISOString();
  }

  // -------------------------------------------------------------------------
  // collection definitions
  // -------------------------------------------------------------------------

  /** Create a collection + its computed indexes. Throws on duplicate slug. */
  define(botId: string, input: DefineCollectionInput): CollectionPublic {
    const ts = this.now();
    const existing = this.findRow(botId, input.slug);
    if (existing) throw new Error(`collection slug already exists: ${input.slug}`);
    const row: CollectionRow = {
      id: randomUUID(),
      botId,
      slug: input.slug,
      name: input.name,
      icon: input.icon ?? null,
      schema: input.schema,
      display: input.display ?? {},
      version: 1,
      createdAt: ts,
      updatedAt: ts,
    };
    this.db.insert(collections).values(row).run();
    this.syncIndexes(row.id, input.schema);
    return rowToCollection(row);
  }

  /** Update name/icon/display and/or the field schema. Re-syncs indexes. */
  updateDefinition(
    id: string,
    patch: { name?: string; icon?: string | null; schema?: CollectionSchemaDoc; display?: CollectionDisplay },
  ): CollectionPublic {
    const row = this.db.select().from(collections).where(eq(collections.id, id)).get();
    if (!row) throw new CollectionNotFoundError(id);
    const next: Partial<CollectionRow> = { updatedAt: this.now() };
    if (patch.name !== undefined) next.name = patch.name;
    if (patch.icon !== undefined) next.icon = patch.icon;
    if (patch.display !== undefined) next.display = patch.display;
    if (patch.schema !== undefined) {
      next.schema = patch.schema;
      next.version = row.version + 1;
    }
    this.db.update(collections).set(next).where(eq(collections.id, id)).run();
    if (patch.schema !== undefined) this.syncIndexes(id, patch.schema);
    const updated = { ...row, ...next } as CollectionRow;
    return rowToCollection(updated);
  }

  /** Drop a collection, its records (FK cascade) and its computed indexes. */
  deleteDefinition(id: string): void {
    const row = this.db.select().from(collections).where(eq(collections.id, id)).get();
    if (!row) throw new CollectionNotFoundError(id);
    this.dropIndexes(id, row.schema as CollectionSchemaDoc);
    this.db.delete(collections).where(eq(collections.id, id)).run();
  }

  list(botId: string): CollectionPublic[] {
    return this.db
      .select()
      .from(collections)
      .where(eq(collections.botId, botId))
      .all()
      .map(rowToCollection);
  }

  get(id: string): CollectionPublic | null {
    const row = this.db.select().from(collections).where(eq(collections.id, id)).get();
    return row ? rowToCollection(row) : null;
  }

  getBySlug(botId: string, slug: string): CollectionPublic | null {
    const row = this.findRow(botId, slug);
    return row ? rowToCollection(row) : null;
  }

  private findRow(botId: string, slug: string): CollectionRow | undefined {
    return this.db
      .select()
      .from(collections)
      .where(and(eq(collections.botId, botId), eq(collections.slug, slug)))
      .get();
  }

  private requireRow(collectionId: string): CollectionRow {
    const row = this.db.select().from(collections).where(eq(collections.id, collectionId)).get();
    if (!row) throw new CollectionNotFoundError(collectionId);
    return row;
  }

  // -------------------------------------------------------------------------
  // computed indexes (SQLite expression indexes on json_extract)
  // -------------------------------------------------------------------------

  /** Stable index name for a (collection, field) pair. */
  private indexName(collectionId: string, key: string): string {
    return `recidx_${collectionId.replace(/-/g, '')}_${key}`;
  }

  /** Create the indexes the schema asks for; drop any that are no longer wanted. */
  private syncIndexes(collectionId: string, schema: CollectionSchemaDoc): void {
    const wanted = new Map(
      indexedFields(schema).map((f) => [this.indexName(collectionId, f.key), f.key] as const),
    );
    // Drop stale indexes for this collection that are not in `wanted`.
    const prefix = `recidx_${collectionId.replace(/-/g, '')}_`;
    const rows = this.sqlite
      .prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name LIKE ?`)
      .all(`${prefix}%`) as { name: string }[];
    for (const { name } of rows) {
      if (!wanted.has(name)) this.sqlite.exec(`DROP INDEX IF EXISTS "${name}"`);
    }
    // Create wanted indexes (partial: scoped to this collection's rows).
    for (const [name, key] of wanted) {
      this.sqlite.exec(
        `CREATE INDEX IF NOT EXISTS "${name}" ON records (json_extract(data, '$.${key}')) ` +
          `WHERE collection_id = '${collectionId}'`,
      );
    }
  }

  private dropIndexes(collectionId: string, _schema: CollectionSchemaDoc): void {
    const prefix = `recidx_${collectionId.replace(/-/g, '')}_`;
    const rows = this.sqlite
      .prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name LIKE ?`)
      .all(`${prefix}%`) as { name: string }[];
    for (const { name } of rows) this.sqlite.exec(`DROP INDEX IF EXISTS "${name}"`);
  }

  /** Index names currently defined for a collection — used by tests. */
  indexNamesFor(collectionId: string): string[] {
    const prefix = `recidx_${collectionId.replace(/-/g, '')}_`;
    return (
      this.sqlite
        .prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name LIKE ?`)
        .all(`${prefix}%`) as { name: string }[]
    ).map((r) => r.name);
  }

  // -------------------------------------------------------------------------
  // records
  // -------------------------------------------------------------------------

  insert(collectionId: string, data: unknown, createdBy = 'admin'): RecordPublic {
    const col = this.requireRow(collectionId);
    const clean = validateRecord(col.schema as CollectionSchemaDoc, data);
    const ts = this.now();
    const row: RecordRow = {
      id: randomUUID(),
      collectionId,
      data: clean,
      createdAt: ts,
      updatedAt: ts,
      createdBy,
    };
    this.db.insert(records).values(row).run();
    return this.rowToRecord(row, col.schema as CollectionSchemaDoc);
  }

  getRecord(id: string): RecordPublic | null {
    const row = this.db.select().from(records).where(eq(records.id, id)).get();
    if (!row) return null;
    const col = this.requireRow(row.collectionId);
    return this.rowToRecord(row, col.schema as CollectionSchemaDoc);
  }

  /**
   * Update a record. `mode: 'merge'` (default) shallow-merges top-level fields;
   * `mode: 'replace'` validates the patch as a full document. The merged result
   * is re-validated against the (possibly newer) schema — lazy migrate on write.
   */
  update(
    id: string,
    patch: Record<string, unknown>,
    opts: { mode?: 'merge' | 'replace'; updatedBy?: string } = {},
  ): RecordPublic {
    const row = this.db.select().from(records).where(eq(records.id, id)).get();
    if (!row) throw new RecordNotFoundError(id);
    const col = this.requireRow(row.collectionId);
    const schema = col.schema as CollectionSchemaDoc;
    const mode = opts.mode ?? 'merge';

    let nextData: Record<string, unknown>;
    if (mode === 'replace') {
      nextData = validateRecord(schema, patch);
    } else {
      const current = applyDefaults(schema, row.data as Record<string, unknown>);
      const cleanedPatch = validateRecord(schema, patch, { partial: true });
      nextData = validateRecord(schema, { ...current, ...cleanedPatch });
    }
    const ts = this.now();
    const next: Partial<RecordRow> = { data: nextData, updatedAt: ts };
    if (opts.updatedBy !== undefined) next.createdBy = opts.updatedBy;
    this.db.update(records).set(next).where(eq(records.id, id)).run();
    return this.rowToRecord({ ...row, ...next } as RecordRow, schema);
  }

  /** Delete one record by id. Returns false if it did not exist. */
  deleteRecord(id: string): boolean {
    const res = this.db.delete(records).where(eq(records.id, id)).run();
    return res.changes > 0;
  }

  /**
   * Delete every record matching a filter. Guarded: refuses to delete more than
   * one row unless `confirmMany` is set (mirrors the node's `confirm_many`).
   * Returns the number deleted.
   */
  deleteWhere(collectionId: string, filter: Partial<RecordFilter>, confirmMany = false): number {
    this.requireRow(collectionId);
    const matches = this.find(collectionId, { where: filter.where ?? [] });
    if (matches.records.length > 1 && !confirmMany) {
      throw new MultiDeleteGuardError(matches.records.length);
    }
    let n = 0;
    for (const rec of matches.records) {
      if (this.deleteRecord(rec.id)) n++;
    }
    return n;
  }

  /** Count records matching a filter (ignores limit/offset). */
  count(collectionId: string, filter: Partial<RecordFilter> = {}): number {
    this.requireRow(collectionId);
    const { sql, params } = this.compileWhere(collectionId, filter.where ?? []);
    const r = this.sqlite
      .prepare(`SELECT COUNT(*) AS n FROM records WHERE ${sql}`)
      .get(...params) as { n: number };
    return r.n;
  }

  /** Find records matching a filter, applying read-time defaults. */
  find(collectionId: string, filter: Partial<RecordFilter> = {}): ListRecordsResult {
    const col = this.requireRow(collectionId);
    const schema = col.schema as CollectionSchemaDoc;
    const { sql: whereSql, params } = this.compileWhere(collectionId, filter.where ?? []);

    const total = (
      this.sqlite.prepare(`SELECT COUNT(*) AS n FROM records WHERE ${whereSql}`).get(...params) as {
        n: number;
      }
    ).n;

    const orderSql = this.compileOrder(filter.sort ?? []);
    const limit = filter.limit;
    const offset = filter.offset ?? 0;
    let query = `SELECT id, collection_id, data, created_at, updated_at, created_by FROM records WHERE ${whereSql}${orderSql}`;
    const qparams = [...params];
    if (limit !== undefined) {
      query += ` LIMIT ? OFFSET ?`;
      qparams.push(limit, offset);
    } else if (offset > 0) {
      query += ` LIMIT -1 OFFSET ?`;
      qparams.push(offset);
    }
    const rows = this.sqlite.prepare(query).all(...qparams) as RawRecordRow[];
    return {
      records: rows.map((r) => this.rawRowToRecord(r, schema)),
      total,
    };
  }

  // -------------------------------------------------------------------------
  // filter → json_extract SQL compiler (ARCHITECTURE §13.4)
  // -------------------------------------------------------------------------

  /** Build a `WHERE` fragment (always collection-scoped) + bound params. */
  private compileWhere(
    collectionId: string,
    where: WhereRow[],
  ): { sql: string; params: unknown[] } {
    const clauses: string[] = ['collection_id = ?'];
    const params: unknown[] = [collectionId];
    for (const row of where) {
      const ext = `json_extract(data, '$.${sanitizeFieldPath(row.field)}')`;
      switch (row.op) {
        case 'eq':
          clauses.push(`${ext} = ?`);
          params.push(toSqlScalar(row.value));
          break;
        case 'ne':
          clauses.push(`(${ext} IS NULL OR ${ext} <> ?)`);
          params.push(toSqlScalar(row.value));
          break;
        case 'gt':
          clauses.push(`${ext} > ?`);
          params.push(toSqlScalar(row.value));
          break;
        case 'gte':
          clauses.push(`${ext} >= ?`);
          params.push(toSqlScalar(row.value));
          break;
        case 'lt':
          clauses.push(`${ext} < ?`);
          params.push(toSqlScalar(row.value));
          break;
        case 'lte':
          clauses.push(`${ext} <= ?`);
          params.push(toSqlScalar(row.value));
          break;
        case 'contains':
          clauses.push(`${ext} LIKE ? ESCAPE '\\'`);
          params.push(`%${escapeLike(String(row.value ?? ''))}%`);
          break;
        case 'in': {
          const arr = Array.isArray(row.value) ? row.value : [row.value];
          if (arr.length === 0) {
            clauses.push('0'); // matches nothing
          } else {
            clauses.push(`${ext} IN (${arr.map(() => '?').join(', ')})`);
            for (const v of arr) params.push(toSqlScalar(v));
          }
          break;
        }
        case 'exists': {
          const want = row.value === false ? false : true; // default exists:true
          clauses.push(want ? `${ext} IS NOT NULL` : `${ext} IS NULL`);
          break;
        }
      }
    }
    return { sql: clauses.join(' AND '), params };
  }

  private compileOrder(sort: { field: string; dir?: 'asc' | 'desc' }[]): string {
    if (sort.length === 0) return ` ORDER BY created_at ASC`;
    const parts = sort.map((s) => {
      const ext = `json_extract(data, '$.${sanitizeFieldPath(s.field)}')`;
      return `${ext} ${s.dir === 'desc' ? 'DESC' : 'ASC'}`;
    });
    return ` ORDER BY ${parts.join(', ')}`;
  }

  // -------------------------------------------------------------------------
  // row mappers
  // -------------------------------------------------------------------------

  private rowToRecord(row: RecordRow, schema: CollectionSchemaDoc): RecordPublic {
    return {
      id: row.id,
      collectionId: row.collectionId,
      data: applyDefaults(schema, row.data as Record<string, unknown>),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      createdBy: row.createdBy,
    };
  }

  private rawRowToRecord(r: RawRecordRow, schema: CollectionSchemaDoc): RecordPublic {
    return {
      id: r.id,
      collectionId: r.collection_id,
      data: applyDefaults(schema, JSON.parse(r.data) as Record<string, unknown>),
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      createdBy: r.created_by,
    };
  }
}

interface RawRecordRow {
  id: string;
  collection_id: string;
  data: string;
  created_at: string;
  updated_at: string;
  created_by: string;
}

/**
 * Convert a filter value to a SQLite-comparable scalar. booleans → 0/1 (matching
 * how `json_extract` returns them), everything else verbatim.
 */
function toSqlScalar(value: unknown): unknown {
  if (typeof value === 'boolean') return value ? 1 : 0;
  return value as string | number | null;
}

/** LIKE special-char escaping for `contains` (escape char is backslash). */
function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (m) => `\\${m}`);
}

/**
 * Allow only a safe dotted/bracketed json path (identifiers, dots, [n]) so a
 * field name can never inject SQL. `value` params are always bound; the path is
 * an interpolated identifier, hence this guard. Throws on anything suspicious.
 */
function sanitizeFieldPath(field: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*|\[\d+\])*$/.test(field)) {
    throw new Error(`unsafe field path in filter: ${field}`);
  }
  return field;
}
