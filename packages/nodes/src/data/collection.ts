/**
 * data.collection — Collection CRUD (NODES.md §Collection, P3.5-T5). Generic
 * structured-data access against a user-defined Collection of this bot (looked
 * up by slug), via the injected `ctx.collections` capability. As domain-agnostic
 * as data.kv (invariant I2): CTB never knows whether records are products,
 * tickets or recipes — the host owns the schema + validation.
 *
 * Ops (one node run = one store interaction, NOT per item — the collection is
 * execution-external state, like data.kv):
 *  - find    → where/sort/limit/offset → ONE output item per matched record
 *              (`{ json: { record, record_id } }`); zero matches → `empty` port
 *  - get     → record_id → one item, or `empty` port
 *  - insert  → field rows → `{ record, record_id }`
 *  - update  → record_id OR where (first match) + field rows; mode merge|replace
 *  - delete  → record_id OR where + confirm_many guard → `{ deleted: n }`
 *  - count   → where → `{ count }`
 *
 * Writes are validated host-side against the collection schema (shared
 * `validateRecord`); a validation failure surfaces as a node error with the
 * field-level messages. `suppress_events` opts the write out of firing
 * `collection.recordChanged`.
 *
 * The `where` value, `record_id` and each field-mapping `value` are EXPRESSIONS
 * already resolved by the executor before execute() runs (they are plain string
 * params, not in rawParamKeys), so the node just consumes the resolved strings.
 */
import {
  CollectionParamsSchema,
  fail,
  out,
  type CollectionFilter,
  type CollectionParams,
  type CollectionRecord,
  type CollectionWhereRow,
  type FlowItem,
  type NodeDef,
} from '@ctb/shared';

export const dataCollection: NodeDef<CollectionParams> = {
  type: 'data.collection',
  category: 'data',
  meta: {
    labelKey: 'nodes.data.collection.label',
    descriptionKey: 'nodes.data.collection.desc',
    icon: 'database',
  },
  ports: { inputs: ['main'], outputs: ['main', 'empty'] },
  paramsSchema: CollectionParamsSchema,
  async execute(ctx, params, items) {
    if (!ctx.collections) {
      return fail('data.collection: collection store is not available on this instance');
    }
    const col = ctx.collections;
    const slug = params.collection;
    const suppress = params.suppress_events;

    try {
      switch (params.operation) {
        case 'find': {
          const filter = buildFilter(params.where, params.sort, params.limit, params.offset);
          const { records } = await col.find(slug, filter);
          if (records.length === 0) return out({ empty: [{ json: {} }] });
          return out({ main: records.map(recordItem) });
        }

        case 'get': {
          const id = (params.record_id ?? '').trim();
          if (id === '') return fail('data.collection: op "get" requires a record_id');
          const record = await col.get(slug, id);
          if (!record) return out({ empty: [{ json: { record_id: id } }] });
          return out({ main: [recordItem(record)] });
        }

        case 'count': {
          const filter = buildFilter(params.where, [], undefined, undefined);
          const count = await col.count(slug, filter);
          return out({ main: [{ json: { count } }] });
        }

        case 'insert': {
          const data = mappingToData(params.fields);
          const record = await col.insert(slug, data, { suppressEvents: suppress });
          return out({ main: [recordItem(record)] });
        }

        case 'update': {
          const id = await resolveTargetId(col, slug, params);
          if (id === null) return out({ empty: [{ json: {} }] });
          const patch = mappingToData(params.fields);
          const record = await col.update(slug, id, patch, {
            mode: params.mode,
            suppressEvents: suppress,
          });
          return out({ main: [recordItem(record)] });
        }

        case 'delete': {
          const id = (params.record_id ?? '').trim();
          let deleted: number;
          if (id !== '') {
            deleted = await col.delete(slug, { recordId: id }, { suppressEvents: suppress });
          } else {
            const filter = buildFilter(params.where, [], undefined, undefined);
            deleted = await col.delete(
              slug,
              { filter },
              { confirmMany: params.confirm_many, suppressEvents: suppress },
            );
          }
          return out({ main: [{ json: { deleted } }] });
        }
      }
    } catch (err) {
      return fail(`data.collection: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Unreachable: the switch is exhaustive over the enum.
    void items;
    return fail(`data.collection: unknown operation`);
  },
};

/** Wrap a host record into the node's emitted item shape. */
function recordItem(record: CollectionRecord): FlowItem {
  return { json: { record: record.data, record_id: record.id } };
}

/**
 * Resolve the single record id an update should target: an explicit `record_id`
 * wins; otherwise the FIRST record matching `where` (NODES.md). Returns null
 * when nothing matches (→ empty port).
 */
async function resolveTargetId(
  col: NonNullable<import('@ctb/shared').NodeCtx['collections']>,
  slug: string,
  params: CollectionParams,
): Promise<string | null> {
  const explicit = (params.record_id ?? '').trim();
  if (explicit !== '') return explicit;
  const filter = buildFilter(params.where, [], 1, undefined);
  const { records } = await col.find(slug, filter);
  return records[0]?.id ?? null;
}

/** Build the host filter from resolved where/sort params (coerces where values). */
function buildFilter(
  where: CollectionWhereRow[],
  sort: { field: string; dir: 'asc' | 'desc' }[],
  limit: number | undefined,
  offset: number | undefined,
): CollectionFilter {
  const filter: CollectionFilter = {
    where: where.map((row) => ({ field: row.field, op: row.op, value: coerceWhereValue(row) })),
    sort: sort.map((s) => ({ field: s.field, dir: s.dir })),
  };
  if (limit !== undefined) filter.limit = limit;
  if (offset !== undefined) filter.offset = offset;
  return filter;
}

/**
 * Coerce a resolved where-row string into the value the filter compiler wants:
 *  - `in`     → comma-separated list (and number-coerce each)
 *  - `exists` → boolean ("false"/"0" → false, else true)
 *  - others   → number if numeric, "true"/"false" → bool, else the string
 * (The store's json_extract comparisons need the right primitive type.)
 */
function coerceWhereValue(row: CollectionWhereRow): unknown {
  const raw = row.value ?? '';
  if (row.op === 'exists') return !(raw === 'false' || raw === '0' || raw === '');
  if (row.op === 'in') {
    return raw
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s !== '')
      .map(coerceScalar);
  }
  return coerceScalar(raw);
}

/** number if it looks numeric, boolean for true/false, else the raw string. */
function coerceScalar(s: string): unknown {
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (s !== '' && !Number.isNaN(Number(s)) && /^-?\d+(\.\d+)?$/.test(s.trim())) return Number(s);
  return s;
}

/**
 * Turn field-mapping rows into a record document. Field names may be dotted
 * (`address.city`) → nested objects. Values are pre-resolved strings; we
 * leave typed coercion (number/boolean/select) to the host's `validateRecord`,
 * which knows each field's declared type (invariant I5 — one validator).
 */
function mappingToData(rows: { field: string; value: string }[]): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  for (const row of rows) setAtPath(data, row.field, row.value);
  return data;
}

/** Set `value` at a dotted `path` inside `obj`, creating nested objects. */
function setAtPath(obj: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.').filter((p) => p !== '');
  if (parts.length === 0) return;
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i]!;
    const existing = cur[key];
    if (typeof existing !== 'object' || existing === null || Array.isArray(existing)) {
      cur[key] = {};
    }
    cur = cur[key] as Record<string, unknown>;
  }
  cur[parts[parts.length - 1]!] = value;
}
