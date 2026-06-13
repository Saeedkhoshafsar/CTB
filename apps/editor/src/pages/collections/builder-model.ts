/**
 * Schema-builder model (P3.5-T3) — PURE conversions between the visual builder's
 * editable draft state and the shared `CollectionSchema` document (invariant I5:
 * the builder's only job is to PRODUCE JSON that validates against the same Zod
 * schema the server and node consume).
 *
 * The draft uses string-ish fields (everything an <input> yields) so the form is
 * forgiving while typing; `toField`/`toSchema` normalise into the typed contract
 * and we let `CollectionSchema.safeParse` be the single source of truth on save.
 */
import {
  type CollectionDisplay,
  type CollectionField,
  type CollectionSchemaDoc,
  type FieldType,
  type SelectOption,
} from '@ctb/shared';

/** Field types that may live inside a `group` (no nesting groups/relations). */
export const SUB_FIELD_TYPES: readonly FieldType[] = [
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
];

/** Every field type the top-level builder offers. */
export const FIELD_TYPES: readonly FieldType[] = [...SUB_FIELD_TYPES, 'relation', 'group'];

/** Types that carry an options list. */
export const OPTION_TYPES: readonly FieldType[] = ['select', 'multiSelect'];

/** Editable draft of one option row. */
export interface DraftOption {
  value: string;
  labelFa: string;
  labelEn: string;
}

/** Editable draft of one field row (top-level or sub-field). */
export interface DraftField {
  /** Local row id so React keys + reorder are stable independent of `key`. */
  rowId: string;
  key: string;
  type: FieldType;
  labelFa: string;
  labelEn: string;
  required: boolean;
  defaultText: string;
  indexed: boolean;
  showInList: boolean;
  // validation (all optional; blank = unset)
  min: string;
  max: string;
  minLength: string;
  maxLength: string;
  regex: string;
  // select / multiSelect
  options: DraftOption[];
  // relation
  relationCollection: string;
  relationKind: 'one' | 'many';
  // group
  fields: DraftField[];
}

let rowSeq = 0;
const nextRowId = (): string => `row-${++rowSeq}`;

/** A fresh empty draft field of the given type. */
export function emptyDraftField(type: FieldType = 'text'): DraftField {
  return {
    rowId: nextRowId(),
    key: '',
    type,
    labelFa: '',
    labelEn: '',
    required: false,
    defaultText: '',
    indexed: false,
    showInList: false,
    min: '',
    max: '',
    minLength: '',
    maxLength: '',
    regex: '',
    options: [],
    relationCollection: '',
    relationKind: 'one',
    fields: [],
  };
}

function num(s: string): number | undefined {
  if (s.trim() === '') return undefined;
  const n = Number(s);
  return Number.isNaN(n) ? undefined : n;
}

/** Parse the default text into a typed value for the given field type (best effort). */
function parseDefault(type: FieldType, text: string): unknown {
  if (text.trim() === '') return undefined;
  switch (type) {
    case 'number': {
      const n = Number(text);
      return Number.isNaN(n) ? undefined : n;
    }
    case 'boolean':
      return text === 'true';
    case 'multiSelect':
      return text
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s !== '');
    case 'json':
      try {
        return JSON.parse(text);
      } catch {
        return undefined;
      }
    default:
      return text;
  }
}

function optionsToTyped(options: DraftOption[]): SelectOption[] {
  return options
    .filter((o) => o.value.trim() !== '')
    .map((o) => {
      const label =
        o.labelFa.trim() !== '' || o.labelEn.trim() !== ''
          ? {
              ...(o.labelFa.trim() !== '' ? { fa: o.labelFa.trim() } : {}),
              ...(o.labelEn.trim() !== '' ? { en: o.labelEn.trim() } : {}),
            }
          : undefined;
      return { value: o.value.trim(), ...(label ? { label } : {}) };
    });
}

/** Convert one draft row into a typed CollectionField (sub-field aware). */
export function toField(draft: DraftField, isSub = false): CollectionField {
  const field: CollectionField = { key: draft.key.trim(), type: draft.type };

  const labelFa = draft.labelFa.trim();
  const labelEn = draft.labelEn.trim();
  if (labelFa !== '' || labelEn !== '') {
    field.label = {
      ...(labelFa !== '' ? { fa: labelFa } : {}),
      ...(labelEn !== '' ? { en: labelEn } : {}),
    };
  }

  if (draft.required) field.required = true;
  if (!isSub && draft.indexed && draft.type !== 'group') field.indexed = true;
  if (draft.showInList) field.showInList = true;

  const def = parseDefault(draft.type, draft.defaultText);
  if (def !== undefined) field.default = def;

  const validation: NonNullable<CollectionField['validation']> = {};
  const min = num(draft.min);
  const max = num(draft.max);
  const minLength = num(draft.minLength);
  const maxLength = num(draft.maxLength);
  if (min !== undefined) validation.min = min;
  if (max !== undefined) validation.max = max;
  if (minLength !== undefined) validation.minLength = minLength;
  if (maxLength !== undefined) validation.maxLength = maxLength;
  if (draft.regex.trim() !== '') validation.regex = draft.regex.trim();
  if (Object.keys(validation).length > 0) field.validation = validation;

  if (OPTION_TYPES.includes(draft.type)) {
    field.options = optionsToTyped(draft.options);
  }
  if (draft.type === 'relation') {
    field.relation = { collection: draft.relationCollection.trim(), kind: draft.relationKind };
  }
  if (draft.type === 'group') {
    field.fields = draft.fields.map((f) => toField(f, true));
  }

  return field;
}

/** Build the full schema doc draft → typed (still subject to safeParse on save). */
export function toSchemaDoc(fields: DraftField[]): CollectionSchemaDoc {
  return { fields: fields.map((f) => toField(f)) } as CollectionSchemaDoc;
}

// --- typed → draft (for the "edit existing collection" path) ----------------

function labelPart(
  label: CollectionField['label'],
  part: 'fa' | 'en',
): string {
  if (label === undefined) return '';
  if (typeof label === 'string') return part === 'fa' ? label : '';
  return label[part] ?? '';
}

function defaultToText(type: FieldType, value: unknown): string {
  if (value === undefined) return '';
  if (type === 'json') return JSON.stringify(value);
  if (Array.isArray(value)) return value.join(', ');
  return String(value);
}

/** Typed field → editable draft (inverse of toField). */
export function fromField(field: CollectionField): DraftField {
  const v = field.validation ?? {};
  return {
    rowId: nextRowId(),
    key: field.key,
    type: field.type,
    labelFa: labelPart(field.label, 'fa'),
    labelEn: labelPart(field.label, 'en'),
    required: field.required ?? false,
    defaultText: defaultToText(field.type, field.default),
    indexed: field.indexed ?? false,
    showInList: field.showInList ?? false,
    min: v.min !== undefined ? String(v.min) : '',
    max: v.max !== undefined ? String(v.max) : '',
    minLength: v.minLength !== undefined ? String(v.minLength) : '',
    maxLength: v.maxLength !== undefined ? String(v.maxLength) : '',
    regex: v.regex ?? '',
    options: (field.options ?? []).map((o) => ({
      value: o.value,
      labelFa: labelPart(o.label, 'fa'),
      labelEn: labelPart(o.label, 'en'),
    })),
    relationCollection: field.relation?.collection ?? '',
    relationKind: field.relation?.kind ?? 'one',
    fields: (field.fields ?? []).map(fromField),
  };
}

/**
 * Diff two schema docs by field key — the set of keys present in `before` and
 * GONE in `after`. Removing a field is the destructive edit P3.5-T3 must warn on.
 */
export function removedFieldKeys(
  before: CollectionSchemaDoc,
  after: CollectionSchemaDoc,
): string[] {
  const afterKeys = new Set(after.fields.map((f) => f.key));
  return before.fields.map((f) => f.key).filter((k) => !afterKeys.has(k));
}
