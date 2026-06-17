/**
 * data.removeDuplicates — Remove Duplicates (NODES.md §Data & code; PLAN2 PA-T6).
 *
 * Drops items that repeat, keeping the FIRST occurrence (n8n keeps first).
 * Two compare modes:
 *   all_fields (default): an item duplicates another when its ENTIRE $json
 *     is deep-equal (compared via a stable, key-sorted JSON serialization).
 *   selected_fields:      an item duplicates another when the values at the
 *     chosen dotted `fields` all match an already-seen item.
 * Relative order of the survivors is preserved. Items are never mutated.
 */
import {
  DataRemoveDuplicatesParamsSchema,
  fail,
  out,
  type DataRemoveDuplicatesParams,
  type NodeDef,
} from '@ctb/shared';

export const dataRemoveDuplicates: NodeDef<DataRemoveDuplicatesParams> = {
  type: 'data.removeDuplicates',
  category: 'data',
  meta: {
    labelKey: 'nodes.data.removeDuplicates.label',
    descriptionKey: 'nodes.data.removeDuplicates.desc',
    icon: 'filter',
  },
  ports: { inputs: ['main'], outputs: ['main'] },
  paramsSchema: DataRemoveDuplicatesParamsSchema,
  async execute(_ctx, params, items) {
    const useFields = params.compare === 'selected_fields';
    const fields = params.fields ?? [];
    if (useFields && fields.length === 0) {
      return fail('data.removeDuplicates: compare=selected_fields requires at least one field');
    }

    const seen = new Set<string>();
    const kept = [];
    for (const item of items) {
      const json = item.json as Record<string, unknown>;
      const key = useFields
        ? stableStringify(fields.map((f) => getPath(json, f)))
        : stableStringify(json);
      if (seen.has(key)) continue;
      seen.add(key);
      kept.push(item);
    }
    return out({ main: kept });
  },
};

/** Read the value at a dotted path; undefined when any segment is missing. */
function getPath(obj: Record<string, unknown>, path: string): unknown {
  let cur: unknown = obj;
  for (const seg of path.split('.')) {
    if (cur === null || typeof cur !== 'object' || Array.isArray(cur)) return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

/**
 * Deterministic JSON serialization: object keys are sorted recursively so two
 * objects with the same content but different key order produce the same
 * string. undefined is encoded distinctly so a missing field never collides
 * with a literal null.
 */
function stableStringify(value: unknown): string {
  if (value === undefined) return '\u0000undefined';
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map((v) => stableStringify(v)).join(',') + ']';
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return (
    '{' +
    keys.map((k) => JSON.stringify(k) + ':' + stableStringify(obj[k])).join(',') +
    '}'
  );
}
