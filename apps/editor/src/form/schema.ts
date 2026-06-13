/**
 * Schema resolver (P2-T3) — pure, DOM-free mapping from a JSON Schema node
 * (produced by the server's `z.toJSONSchema(..., {io:'input'})`) to a widget
 * descriptor the form engine renders.
 *
 * Design (PLAN P2-T3 architecture note): this is a standalone form engine —
 * widgets are keyed by STRUCTURAL field shape, never by node type. The same
 * resolver will render Collection record forms in Phase 3.5; anything
 * node-specific (e.g. "the IF conditions widget") is detected from the
 * schema's structure, not from a node-type lookup table.
 */

export interface JsonSchema {
  type?: string;
  enum?: (string | number)[];
  const?: string | number | boolean;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
  pattern?: string;
  minLength?: number;
  minItems?: number;
  minimum?: number;
  maximum?: number;
  default?: unknown;
  description?: string;
  [k: string]: unknown;
}

/** Every widget the engine knows. Renderers register against these keys. */
export type WidgetKind =
  | 'text' // single-line, expression-aware
  | 'multiline' // textarea, expression-aware
  | 'expression' // schema is `{}` (unknown) — anything incl. {{ }} allowed
  | 'number'
  | 'boolean'
  | 'select'
  | 'duration' // "30s" / "15m" / "2h" / "7d"
  | 'object' // nested fieldset
  | 'rows' // array of objects → repeating rows
  | 'union' // anyOf → branch chooser + sub-widget
  | 'keyboard' // Telegram button-grid builder (structural detect)
  | 'conditions' // IF condition rows (structural detect)
  | 'code'; // CodeMirror JS editor (ctbWidget annotation, data.code P2-T7)

export interface FieldSpec {
  /** property key inside the parent object ('' for the root / union branch). */
  key: string;
  schema: JsonSchema;
  required: boolean;
  widget: WidgetKind;
}

const DURATION_PATTERN_HINT = '(ms|s|m|h|d)';

/** Keys that read better as a textarea. Presentation heuristic only. */
const MULTILINE_KEYS = new Set(['text', 'caption', 'message', 'invalid_message', 'note']);

/** Structural: zod discriminatedUnion('kind', inline|reply|remove) → keyboard. */
export function isKeyboardSchema(s: JsonSchema): boolean {
  const branches = s.oneOf ?? s.anyOf;
  if (!branches || branches.length === 0) return false;
  const kinds = new Set<string>();
  for (const b of branches) {
    const kind = b.properties?.kind?.const;
    if (typeof kind !== 'string') return false;
    kinds.add(kind);
  }
  return kinds.has('inline') && kinds.has('reply');
}

/** Structural: array items with value1 + operator(enum) + value2 → conditions. */
export function isConditionsSchema(s: JsonSchema): boolean {
  if (s.type !== 'array' || !s.items?.properties) return false;
  const p = s.items.properties;
  return 'value1' in p && Array.isArray(p.operator?.enum) && 'value2' in p;
}

function isEmptySchema(s: JsonSchema): boolean {
  // z.unknown() emits {} — no type, no composition keywords
  return (
    s.type === undefined &&
    s.enum === undefined &&
    s.const === undefined &&
    s.anyOf === undefined &&
    s.oneOf === undefined &&
    s.properties === undefined
  );
}

/** Resolve one JSON-Schema node to the widget that edits it. */
export function resolveWidget(key: string, s: JsonSchema): WidgetKind {
  // Explicit annotation wins (z.meta({ctbWidget}) survives z.toJSONSchema) —
  // still structural in spirit: it's a property OF the schema, not a
  // node-type lookup, so Collection fields can reuse it (Phase 3.5).
  if (s.ctbWidget === 'code') return 'code';
  if (isKeyboardSchema(s)) return 'keyboard';
  if (isConditionsSchema(s)) return 'conditions';
  if (Array.isArray(s.enum)) return 'select';
  if (s.anyOf || s.oneOf) {
    // chat: anyOf [number, string] — both editable in one expression-aware box
    const branches = (s.anyOf ?? s.oneOf)!;
    const prims = branches.every((b) => b.type === 'string' || b.type === 'number');
    if (prims) return 'text';
    return 'union';
  }
  switch (s.type) {
    case 'boolean':
      return 'boolean';
    case 'number':
    case 'integer':
      return 'number';
    case 'object':
      return 'object';
    case 'array':
      return 'rows';
    case 'string':
      if (s.pattern?.includes(DURATION_PATTERN_HINT)) return 'duration';
      return MULTILINE_KEYS.has(key) ? 'multiline' : 'text';
    default:
      if (isEmptySchema(s)) return 'expression';
      return 'text';
  }
}

/** Fields of an object schema, in declaration order. */
export function objectFields(s: JsonSchema): FieldSpec[] {
  const required = new Set(s.required ?? []);
  return Object.entries(s.properties ?? {}).map(([key, child]) => ({
    key,
    schema: child,
    required: required.has(key),
    widget: resolveWidget(key, child),
  }));
}

/** Branches of a union schema, each resolved like a root field. */
export function unionBranches(s: JsonSchema): FieldSpec[] {
  return (s.anyOf ?? s.oneOf ?? []).map((b) => ({
    key: '',
    schema: b,
    required: false,
    widget: resolveWidget('', b),
  }));
}

/**
 * Convert a value while switching union branches so the user's work is
 * preserved (n8n behaviour): string → object carries the text into a `text`
 * property; object → string extracts `.text`. Anything else starts fresh.
 */
export function convertBranchValue(to: JsonSchema, value: unknown): unknown {
  if (typeof value === 'string' && to.type === 'object' && to.properties && 'text' in to.properties) {
    const seed = emptyValue(to);
    return seed !== null && typeof seed === 'object'
      ? { ...(seed as Record<string, unknown>), text: value }
      : { text: value };
  }
  if (
    to.type === 'string' &&
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    typeof (value as Record<string, unknown>).text === 'string'
  ) {
    return (value as Record<string, unknown>).text;
  }
  return emptyValue(to);
}

/** Which union branch matches the current value (for initial selection). */
export function matchBranch(s: JsonSchema, value: unknown): number {
  const branches = s.anyOf ?? s.oneOf ?? [];
  if (value === undefined) return 0;
  for (let i = 0; i < branches.length; i++) {
    const b = branches[i]!;
    if (b.type === 'string' && typeof value === 'string') return i;
    if ((b.type === 'number' || b.type === 'integer') && typeof value === 'number') return i;
    if (b.type === 'object' && value !== null && typeof value === 'object' && !Array.isArray(value))
      return i;
    if (b.type === 'array' && Array.isArray(value)) return i;
  }
  return 0;
}

/**
 * A fresh value for a schema — used when adding a row / switching a union
 * branch. Required object children are seeded recursively so Zod's
 * `required` doesn't instantly flag a row the user just added.
 */
export function emptyValue(s: JsonSchema): unknown {
  if (s.default !== undefined) return s.default;
  if (typeof s.const === 'string' || typeof s.const === 'number' || typeof s.const === 'boolean')
    return s.const;
  if (Array.isArray(s.enum) && s.enum.length > 0) return s.enum[0];
  switch (s.type) {
    case 'boolean':
      return false;
    case 'number':
    case 'integer':
      return 0;
    case 'array':
      return [];
    case 'string':
      return '';
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const key of s.required ?? []) {
        const child = s.properties?.[key];
        if (child) out[key] = emptyValue(child);
      }
      return out;
    }
    default:
      return '';
  }
}
