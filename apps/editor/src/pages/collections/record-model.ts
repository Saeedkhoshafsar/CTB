/**
 * Record-form & list model (P3.5-T4) — PURE, DOM-free helpers backing the
 * auto-generated CRUD panel. Mirrors `builder-model.ts`'s split: the visual
 * record form holds a forgiving draft (`RecordDraft`, string-ish inputs), and
 * these functions convert to/from the typed record document that the SHARED
 * `validateRecord` (invariant I5) then judges server-side.
 *
 * GENERIC (invariant I2): nothing here names a domain — it reasons purely about
 * `CollectionField` shapes. "product"/"order" live only in the user's schema.
 *
 * The list helpers (columns, the search→RecordFilter compiler, sort toggling)
 * are likewise pure so the panel stays a thin render over them and the whole
 * lot is unit-testable without a browser.
 */
import {
  type CollectionField,
  type CollectionPublic,
  type CollectionSchemaDoc,
  type RecordFilter,
  type RecordPublic,
  type WhereRow,
  labelText,
} from '@ctb/shared';

// ---------------------------------------------------------------------------
// draft record state
// ---------------------------------------------------------------------------

/**
 * A record draft is just a loose value-bag keyed by field key. Each widget owns
 * the in-memory shape that's easiest for it to edit (string for text/number/
 * date, boolean for checkbox, string[] for multiSelect/relation-many, an array
 * of row-bags for group, the file id for image/file). `toRecordData` normalises
 * everything into the document `validateRecord` expects.
 */
export type RecordDraft = Record<string, unknown>;

/** A fresh draft seeded with each field's default (or a type-appropriate empty). */
export function emptyDraft(schema: CollectionSchemaDoc): RecordDraft {
  const out: RecordDraft = {};
  for (const f of schema.fields) out[f.key] = emptyFieldValue(f);
  return out;
}

/** The empty editing value for one field (what an "add" seeds). */
export function emptyFieldValue(field: CollectionField): unknown {
  if (field.default !== undefined) return field.default;
  switch (field.type) {
    case 'boolean':
      return false;
    case 'multiSelect':
      return [];
    case 'group':
      return [];
    case 'relation':
      return field.relation?.kind === 'many' ? [] : '';
    case 'json':
      return '';
    default:
      return '';
  }
}

/** A blank group row: each sub-field at its empty editing value. */
export function emptyGroupRow(field: CollectionField): RecordDraft {
  const row: RecordDraft = {};
  for (const sub of field.fields ?? []) row[sub.key] = emptyFieldValue(sub);
  return row;
}

/** Existing record → editable draft (inverse of toRecordData, for the edit form). */
export function recordToDraft(schema: CollectionSchemaDoc, data: Record<string, unknown>): RecordDraft {
  const out: RecordDraft = {};
  for (const f of schema.fields) {
    out[f.key] = fieldToDraft(f, data[f.key]);
  }
  return out;
}

function fieldToDraft(field: CollectionField, value: unknown): unknown {
  if (value === undefined || value === null) return emptyFieldValue(field);
  switch (field.type) {
    case 'number':
      return String(value);
    case 'boolean':
      return value === true;
    case 'multiSelect':
      return Array.isArray(value) ? value : [];
    case 'json':
      try {
        return JSON.stringify(value, null, 2);
      } catch {
        return '';
      }
    case 'relation':
      if (field.relation?.kind === 'many') return Array.isArray(value) ? value : [];
      return typeof value === 'string' ? value : '';
    case 'group':
      if (!Array.isArray(value)) return [];
      return value.map((row) => {
        const r: RecordDraft = {};
        for (const sub of field.fields ?? []) {
          r[sub.key] = fieldToDraft(sub, (row as Record<string, unknown>)?.[sub.key]);
        }
        return r;
      });
    default:
      return typeof value === 'string' ? value : String(value);
  }
}

/**
 * Draft → the typed record document. We do the same string→typed coercions the
 * shared validator accepts (numbers, booleans, JSON parse) and DROP blank
 * optionals so they don't become empty strings; `validateRecord` then has the
 * final say (required checks, ranges, option membership, etc).
 *
 * Returns the data document ready to POST/PATCH. Blank required fields are left
 * absent on purpose so the server reports them as field-level "required" errors,
 * keeping a single source of truth for validation.
 */
export function toRecordData(schema: CollectionSchemaDoc, draft: RecordDraft): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of schema.fields) {
    const coerced = coerceDraftValue(f, draft[f.key]);
    if (coerced !== undefined) out[f.key] = coerced;
  }
  return out;
}

function isBlank(v: unknown): boolean {
  return v === undefined || v === null || v === '';
}

function coerceDraftValue(field: CollectionField, value: unknown): unknown {
  switch (field.type) {
    case 'number': {
      if (isBlank(value)) return undefined;
      const n = typeof value === 'number' ? value : Number(String(value));
      return Number.isNaN(n) ? String(value) : n; // pass non-numeric through so the server flags it
    }
    case 'boolean':
      return value === true || value === 'true';
    case 'multiSelect':
      return Array.isArray(value) ? value.filter((x) => typeof x === 'string' && x !== '') : [];
    case 'select':
      return isBlank(value) ? undefined : String(value);
    case 'json': {
      if (isBlank(value)) return undefined;
      if (typeof value !== 'string') return value;
      try {
        return JSON.parse(value);
      } catch {
        return value; // let the server reject (json accepts anything, so this is rare)
      }
    }
    case 'relation': {
      if (field.relation?.kind === 'many') {
        return Array.isArray(value) ? value.filter((x) => typeof x === 'string' && x !== '') : [];
      }
      return isBlank(value) ? undefined : String(value);
    }
    case 'image':
    case 'file':
      return isBlank(value) ? undefined : String(value);
    case 'group': {
      if (!Array.isArray(value)) return [];
      return value.map((row) => {
        const r: Record<string, unknown> = {};
        for (const sub of field.fields ?? []) {
          const sv = coerceDraftValue(sub, (row as Record<string, unknown>)?.[sub.key]);
          if (sv !== undefined) r[sub.key] = sv;
        }
        return r;
      });
    }
    default: {
      // text, longText, richTextLite, date, dateTime
      if (isBlank(value)) return undefined;
      return String(value);
    }
  }
}

// ---------------------------------------------------------------------------
// list view helpers
// ---------------------------------------------------------------------------

/**
 * Which top-level fields appear as list columns. Honours `display.listColumns`
 * (in that order), else every field flagged `showInList`, else the first few
 * non-structural fields as a sensible default so the table is never empty.
 */
export function listColumns(collection: CollectionPublic): CollectionField[] {
  const byKey = new Map(collection.schema.fields.map((f) => [f.key, f]));
  const explicit = collection.display.listColumns;
  if (explicit && explicit.length > 0) {
    return explicit.map((k) => byKey.get(k)).filter((f): f is CollectionField => f !== undefined);
  }
  const flagged = collection.schema.fields.filter((f) => f.showInList);
  if (flagged.length > 0) return flagged;
  return collection.schema.fields.filter((f) => f.type !== 'group').slice(0, 4);
}

/** The field whose value titles a record (relation pickers, headers). */
export function titleField(collection: CollectionPublic): CollectionField | undefined {
  const byKey = new Map(collection.schema.fields.map((f) => [f.key, f]));
  if (collection.display.titleField) return byKey.get(collection.display.titleField);
  return collection.schema.fields.find((f) => f.type === 'text' || f.type === 'longText');
}

/** A short human label for a whole record (for relation dropdowns / headers). */
export function recordTitle(collection: CollectionPublic, record: RecordPublic): string {
  const tf = titleField(collection);
  if (tf) {
    const v = record.data[tf.key];
    if (typeof v === 'string' && v !== '') return v;
    if (typeof v === 'number') return String(v);
  }
  return record.id;
}

/**
 * Render one field's value as a compact cell string for the list. Selects show
 * their option label; booleans ✓/✗; multiSelect/relation-many a count; groups a
 * row count; image/file an icon; everything else its stringified value.
 */
export function cellText(field: CollectionField, value: unknown): string {
  if (value === undefined || value === null || value === '') return '—';
  switch (field.type) {
    case 'boolean':
      return value ? '✓' : '✗';
    case 'select': {
      const opt = (field.options ?? []).find((o) => o.value === value);
      return opt ? labelText(opt.label, opt.value) : String(value);
    }
    case 'multiSelect':
      return Array.isArray(value) ? `${value.length}` : '—';
    case 'group':
      return Array.isArray(value) ? `${value.length}` : '0';
    case 'relation':
      if (field.relation?.kind === 'many') return Array.isArray(value) ? `${value.length}` : '0';
      return typeof value === 'string' ? value : '—';
    case 'image':
    case 'file':
      return '📎';
    case 'json':
      try {
        return JSON.stringify(value);
      } catch {
        return '—';
      }
    default:
      return String(value);
  }
}

// ---------------------------------------------------------------------------
// search / filter → RecordFilter (the shared query shape, I5)
// ---------------------------------------------------------------------------

/** A single filter-builder row in the panel UI. */
export interface FilterDraft {
  field: string;
  /** Subset of FilterOp the panel exposes. */
  op: WhereRow['op'];
  value: string;
}

/** Fields a user can filter by — top-level, non-structural (no group). */
export function filterableFields(schema: CollectionSchemaDoc): CollectionField[] {
  return schema.fields.filter((f) => f.type !== 'group' && f.type !== 'json' && f.type !== 'image' && f.type !== 'file');
}

/** Fields a free-text search box scans (text-ish + select). */
export function searchableFields(schema: CollectionSchemaDoc): CollectionField[] {
  return schema.fields.filter(
    (f) => f.type === 'text' || f.type === 'longText' || f.type === 'richTextLite',
  );
}

/** Coerce a filter-row's raw string into the typed value the operator expects. */
function filterValue(field: CollectionField | undefined, op: WhereRow['op'], raw: string): unknown {
  if (op === 'exists') return raw !== 'false';
  if (op === 'in') {
    return raw
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s !== '')
      .map((s) => coerceScalarFilter(field, s));
  }
  return coerceScalarFilter(field, raw);
}

function coerceScalarFilter(field: CollectionField | undefined, raw: string): unknown {
  if (field?.type === 'number') {
    const n = Number(raw);
    return Number.isNaN(n) ? raw : n;
  }
  if (field?.type === 'boolean') {
    if (raw === 'true') return true;
    if (raw === 'false') return false;
  }
  return raw;
}

/**
 * Compile the panel's search box + filter rows + sort + pagination into the
 * shared `RecordFilter`. The search term becomes one OR-less set of `contains`
 * rows — but since the filter is flat AND, we apply search to the FIRST
 * searchable field only when a term is present (a deliberate v1 simplification;
 * richer search is a later task). Explicit filter rows are AND-combined as-is.
 */
export function buildFilter(opts: {
  schema: CollectionSchemaDoc;
  search?: string;
  searchField?: string;
  filters?: FilterDraft[];
  sort?: { field: string; dir: 'asc' | 'desc' } | null;
  limit?: number;
  offset?: number;
}): RecordFilter {
  const byKey = new Map(opts.schema.fields.map((f) => [f.key, f]));
  const where: WhereRow[] = [];

  const term = (opts.search ?? '').trim();
  if (term !== '') {
    const field =
      opts.searchField && byKey.has(opts.searchField)
        ? opts.searchField
        : searchableFields(opts.schema)[0]?.key;
    if (field) where.push({ field, op: 'contains', value: term });
  }

  for (const row of opts.filters ?? []) {
    if (!row.field) continue;
    if (row.op !== 'exists' && row.value.trim() === '' && row.op !== 'in') continue;
    where.push({
      field: row.field,
      op: row.op,
      value: filterValue(byKey.get(row.field), row.op, row.value),
    });
  }

  const filter: RecordFilter = { where, sort: [] };
  if (opts.sort) filter.sort = [{ field: opts.sort.field, dir: opts.sort.dir }];
  if (opts.limit !== undefined) filter.limit = opts.limit;
  if (opts.offset !== undefined) filter.offset = opts.offset;
  return filter;
}

/** Toggle a sort click: same field flips dir, a new field starts ascending. */
export function nextSort(
  current: { field: string; dir: 'asc' | 'desc' } | null,
  field: string,
): { field: string; dir: 'asc' | 'desc' } | null {
  if (current?.field === field) {
    if (current.dir === 'asc') return { field, dir: 'desc' };
    return null; // third click clears the sort
  }
  return { field, dir: 'asc' };
}
