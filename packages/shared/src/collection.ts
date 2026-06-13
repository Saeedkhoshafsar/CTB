/**
 * Collections contract (PLAN P3.5-T1) — the Zod definition of a user-defined
 * "table" (its field schema) plus the single query shape used by the API, the
 * admin panel and the `data.collection` node. ARCHITECTURE §13.
 *
 * One schema, every consumer (invariant I5 extended to data): the schema builder
 * UI, the records REST validation, and the node's runtime validation all derive
 * from `CollectionSchema` here. Core stays domain-agnostic (invariant I2) — a
 * "product" is just a user's collection; CTB never names it.
 *
 * Storage is JSON documents (ARCHITECTURE §13.3), not dynamic DDL: this module
 * therefore also owns the PURE record validator/coercer (`validateRecord`) that
 * the server store calls on every write, and the additive-safe read defaulting
 * (`applyDefaults`) used by lazy-migrate-on-read.
 */
import { z } from 'zod';

// ---------------------------------------------------------------------------
// field types (ARCHITECTURE §13.2)
// ---------------------------------------------------------------------------

/** The v1 field-type vocabulary. `group` and `relation` are the structural ones. */
export const FieldTypeSchema = z.enum([
  'text',
  'longText',
  'richTextLite',
  'number',
  'boolean',
  'select',
  'multiSelect',
  'date',
  'dateTime',
  'image',
  'file',
  'json',
  'relation',
  'group',
]);
export type FieldType = z.infer<typeof FieldTypeSchema>;

/** A `key` is a snake/camel identifier safe to embed in a `json_extract` path. */
const FieldKeySchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'field key must be a simple identifier');

/** i18n-able label: a plain string or an {fa,en} pair. */
export const I18nLabelSchema = z.union([
  z.string(),
  z.object({ fa: z.string().optional(), en: z.string().optional() }),
]);
export type I18nLabel = z.infer<typeof I18nLabelSchema>;

/** A single select/multiSelect option. */
export const SelectOptionSchema = z.object({
  value: z.string().min(1),
  label: I18nLabelSchema.optional(),
});
export type SelectOption = z.infer<typeof SelectOptionSchema>;

/** Per-field validation knobs (all optional, all advisory until used). */
export const FieldValidationSchema = z.object({
  min: z.number().optional(),
  max: z.number().optional(),
  minLength: z.number().int().nonnegative().optional(),
  maxLength: z.number().int().nonnegative().optional(),
  regex: z.string().optional(),
});
export type FieldValidation = z.infer<typeof FieldValidationSchema>;

/** Relation cardinality. */
export const RelationKindSchema = z.enum(['one', 'many']);
export type RelationKind = z.infer<typeof RelationKindSchema>;

/**
 * A field definition. This is recursive: a `group` field carries `fields`
 * (its sub-fields, themselves not allowed to nest further groups in v1 — kept
 * flat for the form builder and for predictable `json_extract` paths).
 *
 * We model it with a base object + a lazy recursive shape so a `group` can hold
 * non-group sub-fields. The `superRefine` enforces the v1 rules:
 *   - `select`/`multiSelect` need `options`
 *   - `relation` needs `relation.collection`
 *   - `group` needs `fields` and its sub-fields may NOT be `group`/`relation`
 *   - non-group/non-relation fields carry none of those structural extras
 */
export interface CollectionField {
  key: string;
  type: FieldType;
  label?: I18nLabel;
  required?: boolean;
  /** Default applied when the field is absent on read (additive-safe migrate). */
  default?: unknown;
  validation?: FieldValidation;
  helpText?: I18nLabel;
  /** Show this field as a column in the auto-generated list view. */
  showInList?: boolean;
  /** Build an SQLite expression index on json_extract(data,'$.key'). */
  indexed?: boolean;
  /** select / multiSelect only. */
  options?: SelectOption[];
  /** relation only. */
  relation?: { collection: string; kind: RelationKind };
  /** group only: the repeating sub-group's columns. */
  fields?: CollectionField[];
}

const BaseFieldSchema = z.object({
  key: FieldKeySchema,
  type: FieldTypeSchema,
  label: I18nLabelSchema.optional(),
  required: z.boolean().optional(),
  default: z.unknown().optional(),
  validation: FieldValidationSchema.optional(),
  helpText: I18nLabelSchema.optional(),
  showInList: z.boolean().optional(),
  indexed: z.boolean().optional(),
  options: z.array(SelectOptionSchema).optional(),
  relation: z.object({ collection: z.string().min(1), kind: RelationKindSchema }).optional(),
});

/** A sub-field inside a `group` — same shape but it may not itself be group/relation. */
export const SubFieldSchema = BaseFieldSchema.superRefine((f, ctx) => {
  if (f.type === 'group' || f.type === 'relation') {
    ctx.addIssue({
      code: 'custom',
      message: `sub-field "${f.key}" cannot be of type "${f.type}" (groups are one level deep, relations live at top level)`,
    });
  }
  refineFieldStructure(f, ctx);
}) as unknown as z.ZodType<CollectionField>;

export const CollectionFieldSchema: z.ZodType<CollectionField> = BaseFieldSchema.extend({
  fields: z.lazy(() => z.array(SubFieldSchema)).optional(),
}).superRefine((f, ctx) => {
  if (f.type === 'group') {
    if (!f.fields || f.fields.length === 0) {
      ctx.addIssue({ code: 'custom', message: `group field "${f.key}" needs at least one sub-field` });
    }
  } else if (f.fields !== undefined) {
    ctx.addIssue({ code: 'custom', message: `field "${f.key}" of type "${f.type}" cannot declare sub-fields` });
  }
  refineFieldStructure(f, ctx);
}) as unknown as z.ZodType<CollectionField>;

/** Shared structural checks for select/relation, used by both top-level and sub-fields. */
function refineFieldStructure(
  f: z.infer<typeof BaseFieldSchema>,
  ctx: z.RefinementCtx,
): void {
  if (f.type === 'select' || f.type === 'multiSelect') {
    if (!f.options || f.options.length === 0) {
      ctx.addIssue({ code: 'custom', message: `field "${f.key}" of type "${f.type}" needs options` });
    }
  } else if (f.options !== undefined) {
    ctx.addIssue({ code: 'custom', message: `field "${f.key}" of type "${f.type}" cannot declare options` });
  }
  if (f.type === 'relation') {
    if (!f.relation) {
      ctx.addIssue({ code: 'custom', message: `relation field "${f.key}" needs a target collection` });
    }
  } else if (f.relation !== undefined) {
    ctx.addIssue({ code: 'custom', message: `field "${f.key}" of type "${f.type}" cannot declare a relation` });
  }
}

// ---------------------------------------------------------------------------
// display hints + the collection schema document
// ---------------------------------------------------------------------------

/** List/form display hints stored in `collections.display`. */
export const CollectionDisplaySchema = z.object({
  /** Field keys shown as list columns (falls back to showInList flags). */
  listColumns: z.array(z.string()).optional(),
  /** Default sort for the list view. */
  defaultSort: z.object({ field: z.string(), dir: z.enum(['asc', 'desc']) }).optional(),
  /** Field key whose value labels a record in relation pickers / titles. */
  titleField: z.string().optional(),
});
export type CollectionDisplay = z.infer<typeof CollectionDisplaySchema>;

/** A collection slug: lower-case identifier, stable, used in REST paths. */
export const CollectionSlugSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9_]*$/, 'slug must be lower_snake_case starting with a letter');

/**
 * The full field-schema document of a collection (stored in `collections.schema`).
 * `fields` must have unique keys; that uniqueness is checked here so a malformed
 * schema never reaches the store.
 */
export const CollectionSchema = z
  .object({
    fields: z.array(CollectionFieldSchema).min(1),
  })
  .superRefine((s, ctx) => {
    const seen = new Set<string>();
    for (const f of s.fields) {
      if (seen.has(f.key)) {
        ctx.addIssue({ code: 'custom', message: `duplicate field key "${f.key}"` });
      }
      seen.add(f.key);
    }
  });
export type CollectionSchemaDoc = z.infer<typeof CollectionSchema>;

// ---------------------------------------------------------------------------
// query model — one filter shape for API + panel + node (ARCHITECTURE §13.4)
// ---------------------------------------------------------------------------

/** Comparison operators the filter compiler understands. */
export const FilterOpSchema = z.enum([
  'eq',
  'ne',
  'gt',
  'gte',
  'lt',
  'lte',
  'contains',
  'in',
  'exists',
]);
export type FilterOp = z.infer<typeof FilterOpSchema>;

/** A single AND-row of a `where` clause. */
export const WhereRowSchema = z.object({
  field: z.string().min(1),
  op: FilterOpSchema,
  /** `in` → array; `exists` → boolean; everything else → scalar. */
  value: z.unknown().optional(),
});
export type WhereRow = z.infer<typeof WhereRowSchema>;

export const SortRowSchema = z.object({
  field: z.string().min(1),
  dir: z.enum(['asc', 'desc']).default('asc'),
});
export type SortRow = z.infer<typeof SortRowSchema>;

/**
 * The record filter — AND-combined `where` rows, optional sort/limit/offset.
 * (OR-via-groups is reserved for a later task; v1 ships flat AND, matching the
 * node's where-rows UI.) Shared verbatim by the store, the REST query parser
 * and the `data.collection` node.
 */
export const RecordFilterSchema = z.object({
  where: z.array(WhereRowSchema).default([]),
  sort: z.array(SortRowSchema).default([]),
  limit: z.number().int().positive().max(1000).optional(),
  offset: z.number().int().nonnegative().optional(),
});
export type RecordFilter = z.infer<typeof RecordFilterSchema>;

// ---------------------------------------------------------------------------
// record validation + coercion (PURE — the store calls this on every write)
// ---------------------------------------------------------------------------

/** A field-level validation problem, returned to the API as structured errors. */
export interface FieldError {
  /** Dotted path, e.g. `variants[0].price`. */
  path: string;
  message: string;
}

export class RecordValidationError extends Error {
  constructor(readonly errors: FieldError[]) {
    super(`record validation failed: ${errors.map((e) => `${e.path}: ${e.message}`).join('; ')}`);
    this.name = 'RecordValidationError';
  }
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Coerce + validate ONE scalar field value against its definition. Pushes errors. */
function coerceScalar(
  field: CollectionField,
  value: unknown,
  path: string,
  errors: FieldError[],
): unknown {
  const v = field.validation ?? {};
  const fail = (message: string): undefined => {
    errors.push({ path, message });
    return undefined;
  };

  switch (field.type) {
    case 'text':
    case 'longText':
    case 'richTextLite': {
      if (typeof value !== 'string') return fail('expected a string');
      if (v.minLength !== undefined && value.length < v.minLength) return fail(`min length ${v.minLength}`);
      if (v.maxLength !== undefined && value.length > v.maxLength) return fail(`max length ${v.maxLength}`);
      if (v.regex !== undefined && !new RegExp(v.regex).test(value)) return fail('does not match pattern');
      return value;
    }
    case 'number': {
      const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
      if (typeof n !== 'number' || Number.isNaN(n)) return fail('expected a number');
      if (v.min !== undefined && n < v.min) return fail(`min ${v.min}`);
      if (v.max !== undefined && n > v.max) return fail(`max ${v.max}`);
      return n;
    }
    case 'boolean': {
      if (typeof value === 'boolean') return value;
      if (value === 'true') return true;
      if (value === 'false') return false;
      return fail('expected a boolean');
    }
    case 'select': {
      if (typeof value !== 'string') return fail('expected a string');
      const allowed = (field.options ?? []).map((o) => o.value);
      if (!allowed.includes(value)) return fail(`not an allowed option`);
      return value;
    }
    case 'multiSelect': {
      if (!Array.isArray(value)) return fail('expected an array');
      const allowed = new Set((field.options ?? []).map((o) => o.value));
      for (const item of value) {
        if (typeof item !== 'string' || !allowed.has(item)) return fail(`contains a disallowed option`);
      }
      return value;
    }
    case 'date': {
      if (typeof value !== 'string' || !ISO_DATE.test(value)) return fail('expected an ISO date (YYYY-MM-DD)');
      return value;
    }
    case 'dateTime': {
      if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) return fail('expected an ISO datetime');
      return value;
    }
    case 'image':
    case 'file': {
      // A file ref: the `files` table id (string). Validation that it exists is
      // the store's job (it has DB access); here we only check the shape.
      if (typeof value !== 'string') return fail('expected a file reference id');
      return value;
    }
    case 'json': {
      // The escape hatch — accept any JSON-serialisable value as-is.
      return value;
    }
    case 'relation': {
      const kind = field.relation?.kind ?? 'one';
      if (kind === 'one') {
        if (typeof value !== 'string') return fail('expected a related record id');
        return value;
      }
      if (!Array.isArray(value) || value.some((x) => typeof x !== 'string')) {
        return fail('expected an array of related record ids');
      }
      return value;
    }
    default:
      return value;
  }
}

/**
 * Validate + coerce a record document against a collection schema. Returns the
 * cleaned document (numbers parsed, booleans normalised, unknown keys dropped).
 * Throws `RecordValidationError` with field-level paths on any failure.
 *
 * `partial: true` (for PATCH/update-merge) skips the "required" check for fields
 * absent from the input — present fields are still validated.
 */
export function validateRecord(
  schema: CollectionSchemaDoc,
  input: unknown,
  opts: { partial?: boolean } = {},
): Record<string, unknown> {
  const errors: FieldError[] = [];
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new RecordValidationError([{ path: '', message: 'record must be an object' }]);
  }
  const src = input as Record<string, unknown>;
  const out: Record<string, unknown> = {};

  for (const field of schema.fields) {
    const present = Object.prototype.hasOwnProperty.call(src, field.key);
    let value = present ? src[field.key] : undefined;

    if (!present || value === undefined || value === null || value === '') {
      if (opts.partial && !present) continue; // PATCH: leave untouched
      if (field.default !== undefined) {
        out[field.key] = field.default;
        continue;
      }
      if (field.required) {
        errors.push({ path: field.key, message: 'required' });
      }
      // Optional & empty → omit from the document.
      continue;
    }

    if (field.type === 'group') {
      if (!Array.isArray(value)) {
        errors.push({ path: field.key, message: 'group expects an array of rows' });
        continue;
      }
      const rows: Record<string, unknown>[] = [];
      value.forEach((row, i) => {
        if (typeof row !== 'object' || row === null || Array.isArray(row)) {
          errors.push({ path: `${field.key}[${i}]`, message: 'expected an object row' });
          return;
        }
        const r = row as Record<string, unknown>;
        const cleanRow: Record<string, unknown> = {};
        for (const sub of field.fields ?? []) {
          const subPresent = Object.prototype.hasOwnProperty.call(r, sub.key);
          const subVal = subPresent ? r[sub.key] : undefined;
          if (!subPresent || subVal === undefined || subVal === null || subVal === '') {
            if (sub.default !== undefined) cleanRow[sub.key] = sub.default;
            else if (sub.required) errors.push({ path: `${field.key}[${i}].${sub.key}`, message: 'required' });
            continue;
          }
          const coerced = coerceScalar(sub, subVal, `${field.key}[${i}].${sub.key}`, errors);
          if (coerced !== undefined) cleanRow[sub.key] = coerced;
        }
        rows.push(cleanRow);
      });
      out[field.key] = rows;
      continue;
    }

    const coerced = coerceScalar(field, value, field.key, errors);
    if (coerced !== undefined) out[field.key] = coerced;
  }

  if (errors.length > 0) throw new RecordValidationError(errors);
  return out;
}

/**
 * Additive-safe read defaulting (ARCHITECTURE §13.3): when a field was ADDED to
 * the schema after a record was written, fill the absent key with its declared
 * default (or a type-appropriate empty) so old records read consistently. Pure,
 * non-throwing — used on every read, NOT a validation pass.
 */
export function applyDefaults(
  schema: CollectionSchemaDoc,
  record: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...record };
  for (const field of schema.fields) {
    if (Object.prototype.hasOwnProperty.call(out, field.key)) continue;
    if (field.default !== undefined) {
      out[field.key] = field.default;
    } else if (field.type === 'group' || field.type === 'multiSelect') {
      out[field.key] = [];
    } else if (field.type === 'relation' && field.relation?.kind === 'many') {
      out[field.key] = [];
    }
    // else: leave absent (scalar optional fields stay undefined)
  }
  return out;
}

/** Resolve an i18n label to a display string (fa preferred, then en, then key). */
export function labelText(label: I18nLabel | undefined, fallback: string): string {
  if (label === undefined) return fallback;
  if (typeof label === 'string') return label;
  return label.fa ?? label.en ?? fallback;
}

/** Collect every top-level field flagged `indexed` — the store builds an index per one. */
export function indexedFields(schema: CollectionSchemaDoc): CollectionField[] {
  return schema.fields.filter((f) => f.indexed && f.type !== 'group');
}

// ---------------------------------------------------------------------------
// request bodies + public DTO (used by P3.5-T2 API; defined here with the contract)
// ---------------------------------------------------------------------------

export const CreateCollectionBodySchema = z.object({
  slug: CollectionSlugSchema,
  name: z.string().min(1).max(120),
  icon: z.string().max(64).optional(),
  schema: CollectionSchema,
  display: CollectionDisplaySchema.optional(),
});
export type CreateCollectionBody = z.infer<typeof CreateCollectionBodySchema>;

export const UpdateCollectionBodySchema = z
  .object({
    name: z.string().min(1).max(120).optional(),
    icon: z.string().max(64).optional(),
    schema: CollectionSchema.optional(),
    display: CollectionDisplaySchema.optional(),
  })
  .refine(
    (b) => b.name !== undefined || b.icon !== undefined || b.schema !== undefined || b.display !== undefined,
    { message: 'nothing to update' },
  );
export type UpdateCollectionBody = z.infer<typeof UpdateCollectionBodySchema>;

/** Public projection of a collection (what the API returns). */
export interface CollectionPublic {
  id: string;
  botId: string;
  slug: string;
  name: string;
  icon: string | null;
  schema: CollectionSchemaDoc;
  display: CollectionDisplay;
  version: number;
  createdAt: string;
  updatedAt: string;
}

/** A stored record as returned by the API/node. */
export interface RecordPublic {
  id: string;
  collectionId: string;
  data: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
}
