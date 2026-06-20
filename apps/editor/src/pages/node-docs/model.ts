/**
 * Node-library docs model (PD-T4) — pure, DOM-free transform from the node
 * CATALOG (GET /api/node-types → NodeTypeInfo[]) into a browsable, grouped
 * documentation structure.
 *
 * The promise of CTB is "the work is already done, just connect them": the
 * node registry is the single source of truth for what bricks exist, and this
 * model makes that registry browsable. It does NOT hardcode any node — it
 * derives everything from the catalog payload (I5), so a node added to the
 * registry shows up in the docs automatically with its params, ports and
 * connection facts. The human fa/en label/description live behind the i18n
 * keys in `meta` (resolved by the page via `t`), so the docs are bilingual
 * for free.
 *
 * Param fields reuse the SAME `objectFields` resolver the form engine uses
 * (form/schema.ts) so the documented param shape can never drift from the
 * shape the editor form actually collects and the server re-validates.
 */
import type { NodeTypeInfo } from '@ctb/shared';
import { objectFields, type FieldSpec, type JsonSchema } from '../../form/schema';

/** A single documented parameter (one top-level field of the node's params). */
export interface DocParam {
  /** Property key as it appears in the node's `params` object. */
  key: string;
  /** Whether the server's schema marks this field required. */
  required: boolean;
  /** The widget the editor renders for this field (also a good type hint). */
  widget: FieldSpec['widget'];
  /** A short, human type summary derived from the JSON schema (e.g. "string", "one of: a, b"). */
  typeSummary: string;
  /** The schema-level default, stringified, when one exists. */
  defaultText: string | null;
  /** Schema `description`, when the Zod schema annotated one. */
  description: string | null;
}

/** A documented node — everything an external builder needs to "connect" it. */
export interface DocNode {
  type: string;
  category: string;
  /** i18n key for the human label (resolved by the page). */
  labelKey: string;
  /** i18n key for the human description, when the node provides one. */
  descriptionKey: string | null;
  icon: string | null;
  inputs: string[];
  outputs: string[];
  /** Typed sub-connection role (PB-T1), when the node opts in. */
  role: string | null;
  /** Names of typed input slots (e.g. an Agent's "tool"/"model" slots). */
  inputSlots: string[];
  /** What this node provides to a slot (e.g. "tool", "model"), when it does. */
  provides: string | null;
  /** Whether this node starts a flow (no inputs) — a trigger. */
  isTrigger: boolean;
  params: DocParam[];
}

/** A category bucket of documented nodes. */
export interface DocCategory {
  category: string;
  nodes: DocNode[];
}

/** Stable category order — mirrors the editor palette so docs read the same way. */
export const DOC_CATEGORY_ORDER = ['trigger', 'telegram', 'flow', 'data', 'ai'] as const;

/** Human-readable one-line type summary for a param's JSON schema. */
export function summarizeType(s: JsonSchema): string {
  if (Array.isArray(s.enum) && s.enum.length > 0) {
    return `one of: ${s.enum.map((v) => String(v)).join(', ')}`;
  }
  if (typeof s.const === 'string' || typeof s.const === 'number' || typeof s.const === 'boolean') {
    return `= ${String(s.const)}`;
  }
  const branches = s.anyOf ?? s.oneOf;
  if (branches && branches.length > 0) {
    const parts = branches.map((b) => summarizeType(b));
    // de-dup while preserving order
    const seen = new Set<string>();
    const uniq = parts.filter((p) => (seen.has(p) ? false : (seen.add(p), true)));
    return uniq.join(' | ');
  }
  switch (s.type) {
    case 'array':
      return s.items ? `list of ${summarizeType(s.items)}` : 'list';
    case 'object':
      return 'object';
    case 'integer':
      return 'integer';
    case 'number':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'string':
      return 'string';
    default:
      // z.unknown() / expression — anything, incl. {{ expressions }}
      return 'any';
  }
}

/** Stringify a schema default for display (null when there is none). */
export function defaultText(s: JsonSchema): string | null {
  if (s.default === undefined) return null;
  if (typeof s.default === 'string') return s.default === '' ? '""' : s.default;
  try {
    return JSON.stringify(s.default);
  } catch {
    return String(s.default);
  }
}

/** Project one node's params JSON schema into documented param rows. */
export function paramsOf(info: NodeTypeInfo): DocParam[] {
  const schema = info.paramsJsonSchema as JsonSchema;
  // A node may take a non-object params schema (e.g. a bare union); only object
  // schemas have top-level named fields to document. Non-object schemas have no
  // browsable "fields" — surface zero params (the type summary still shows in
  // the form). objectFields returns [] for a schema with no `properties`.
  return objectFields(schema).map((f) => ({
    key: f.key,
    required: f.required,
    widget: f.widget,
    typeSummary: summarizeType(f.schema),
    defaultText: defaultText(f.schema),
    description: typeof f.schema.description === 'string' ? f.schema.description : null,
  }));
}

/** Project a single catalog entry into a documented node. */
export function toDocNode(info: NodeTypeInfo): DocNode {
  return {
    type: info.type,
    category: info.category,
    labelKey: info.meta.labelKey,
    descriptionKey: info.meta.descriptionKey ?? null,
    icon: info.meta.icon ?? null,
    inputs: [...info.ports.inputs],
    outputs: [...info.ports.outputs],
    role: info.role ?? null,
    // A slot's `kind` doubles as its port name (InputSlot in shared/node-def),
    // so it is exactly what an external builder connects a provider to.
    inputSlots: info.inputSlots ? info.inputSlots.map((s) => s.kind) : [],
    provides: info.provides ?? null,
    isTrigger: info.ports.inputs.length === 0,
    params: paramsOf(info),
  };
}

/**
 * Build the full, grouped docs structure from the catalog. Categories appear
 * in DOC_CATEGORY_ORDER first; any unknown category is appended alphabetically
 * so a future category can never silently vanish from the docs.
 */
export function buildDocs(nodeTypes: NodeTypeInfo[]): DocCategory[] {
  const byCat = new Map<string, DocNode[]>();
  for (const info of nodeTypes) {
    const doc = toDocNode(info);
    const bucket = byCat.get(doc.category);
    if (bucket) bucket.push(doc);
    else byCat.set(doc.category, [doc]);
  }
  // Sort nodes within each category by type for a stable, scannable order.
  for (const list of byCat.values()) list.sort((a, b) => a.type.localeCompare(b.type));

  const known = DOC_CATEGORY_ORDER.filter((c) => byCat.has(c));
  const extra = [...byCat.keys()]
    .filter((c) => !(DOC_CATEGORY_ORDER as readonly string[]).includes(c))
    .sort((a, b) => a.localeCompare(b));

  return [...known, ...extra].map((category) => ({
    category,
    nodes: byCat.get(category) ?? [],
  }));
}

/**
 * Filter the catalog by a free-text query against node type + label/description
 * i18n keys + param keys. `resolveLabel` lets the caller pass the locale-aware
 * `t` so the search matches what the user actually sees. Empty query → all.
 */
export function filterDocs(
  cats: DocCategory[],
  query: string,
  resolveLabel: (key: string) => string,
): DocCategory[] {
  const q = query.trim().toLowerCase();
  if (q === '') return cats;
  const matches = (n: DocNode): boolean => {
    if (n.type.toLowerCase().includes(q)) return true;
    if (resolveLabel(n.labelKey).toLowerCase().includes(q)) return true;
    if (n.descriptionKey && resolveLabel(n.descriptionKey).toLowerCase().includes(q)) return true;
    return n.params.some((p) => p.key.toLowerCase().includes(q));
  };
  return cats
    .map((c) => ({ category: c.category, nodes: c.nodes.filter(matches) }))
    .filter((c) => c.nodes.length > 0);
}

/** Total node count across all categories — handy for the page header. */
export function totalNodes(cats: DocCategory[]): number {
  return cats.reduce((sum, c) => sum + c.nodes.length, 0);
}
