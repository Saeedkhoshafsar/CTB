/**
 * data.sort — Sort (NODES.md §Data & code; PLAN2 PA-T6).
 *
 * Orders items by one or more dotted-path keys. The sort is STABLE and
 * multi-key: the first row is the primary key, later rows break ties.
 *
 * Comparison: if BOTH values are numbers (or numeric strings) they compare
 * numerically; otherwise they compare as locale-aware strings. A missing/
 * undefined/empty value always sorts LAST, regardless of asc/desc
 * (n8n-compatible — empty rows sink to the bottom). The "missing last" rule is
 * applied AFTER the direction is chosen, so it is not flipped by `desc`.
 *
 * The input items are never mutated; only the output ORDER changes.
 */
import {
  DataSortParamsSchema,
  out,
  type DataSortParams,
  type NodeDef,
} from '@ctb/shared';

export const dataSort: NodeDef<DataSortParams> = {
  type: 'data.sort',
  category: 'data',
  meta: {
    labelKey: 'nodes.data.sort.label',
    descriptionKey: 'nodes.data.sort.desc',
    icon: 'sort',
  },
  ports: { inputs: ['main'], outputs: ['main'] },
  paramsSchema: DataSortParamsSchema,
  async execute(_ctx, params, items) {
    // Copy the array so the input order is never mutated in place.
    const sorted = items.slice();
    sorted.sort((a, b) => {
      for (const row of params.fields) {
        const av = getPath(a.json as Record<string, unknown>, row.field);
        const bv = getPath(b.json as Record<string, unknown>, row.field);
        const cmp = compareKey(av, bv, row.order);
        if (cmp !== 0) return cmp;
      }
      return 0;
    });
    return out({ main: sorted });
  },
};

/**
 * Compare two values for ONE sort key, already accounting for direction.
 * Returns <0, 0, >0. Missing values (undefined/null/'') always sort LAST in
 * the final order regardless of `order`, so we resolve them here instead of
 * negating for `desc`.
 */
function compareKey(a: unknown, b: unknown, order: 'asc' | 'desc'): number {
  const aMissing = isMissing(a);
  const bMissing = isMissing(b);
  if (aMissing && bMissing) return 0;
  if (aMissing) return 1; // a sinks below b
  if (bMissing) return -1; // b sinks below a

  const base = compareValues(a, b);
  return order === 'desc' ? -base : base;
}

/** Raw value comparison: numeric when both numeric, else locale string. */
function compareValues(a: unknown, b: unknown): number {
  const an = toNumber(a);
  const bn = toNumber(b);
  if (an !== null && bn !== null) {
    return an < bn ? -1 : an > bn ? 1 : 0;
  }
  return String(a).localeCompare(String(b));
}

function isMissing(v: unknown): boolean {
  return v === undefined || v === null || v === '';
}

/** Returns a finite number for a number or numeric string, else null. */
function toNumber(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Read the value at a dotted path; undefined when any segment is missing. */
function getPath(obj: Record<string, unknown>, path: string): unknown {
  let cur: unknown = obj;
  for (const seg of path.split('.')) {
    if (cur === null || typeof cur !== 'object' || Array.isArray(cur)) return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}
