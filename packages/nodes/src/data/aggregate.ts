/**
 * data.aggregate — Aggregate (NODES.md §Data & code; PLAN2 PA-T5).
 *
 * Merges many items into ONE by collecting fields into arrays.
 * The inverse of data.splitOut.
 *
 * Two modes:
 *   aggregate_individual_fields (default): for each row in `fields`, collect
 *     the value of that dotted `field` across all items into `dest`; remaining
 *     fields from the first item are carried through.
 *   aggregate_all_items: wrap each item's entire $json into an array under
 *     `dest_field` (default "data").
 *
 * Empty input → single item with an empty array.
 */
import {
  DataAggregateParamsSchema,
  out,
  type DataAggregateParams,
  type FlowItem,
  type NodeDef,
} from '@ctb/shared';

export const dataAggregate: NodeDef<DataAggregateParams> = {
  type: 'data.aggregate',
  category: 'data',
  meta: {
    labelKey: 'nodes.data.aggregate.label',
    descriptionKey: 'nodes.data.aggregate.desc',
    icon: 'layers',
  },
  ports: { inputs: ['main'], outputs: ['main'] },
  paramsSchema: DataAggregateParamsSchema,
  async execute(_ctx, params, items) {
    if (params.mode === 'aggregate_all_items') {
      // Wrap every item's $json into an array.
      const arr = items.map((i) => i.json);
      const outJson: Record<string, unknown> = {};
      setPath(outJson, params.dest_field, arr);
      return out({ main: [{ json: outJson }] });
    }

    // aggregate_individual_fields
    const fields = params.fields ?? [];
    if (fields.length === 0) {
      // No field rows defined: aggregate all items under 'data' as a fallback.
      return out({ main: [{ json: { data: items.map((i) => i.json) } }] });
    }

    // Start from a clone of the first item's $json (carries non-aggregated fields).
    const baseJson: Record<string, unknown> =
      items.length > 0
        ? (structuredClone(items[0]!.json) as Record<string, unknown>)
        : {};

    // Collect each named field across all items.
    for (const row of fields) {
      const dest = row.dest ?? row.field;
      const collected = items.map((item) =>
        getPath(item.json as Record<string, unknown>, row.field),
      );
      setPath(baseJson, dest, collected);
    }

    return out({ main: [{ json: baseJson }] });
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

/** Set the value at a dotted path in-place (creates intermediate objects). */
function setPath(obj: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const seg = parts[i]!;
    if (typeof cur[seg] !== 'object' || cur[seg] === null || Array.isArray(cur[seg])) {
      cur[seg] = {};
    }
    cur = cur[seg] as Record<string, unknown>;
  }
  const last = parts[parts.length - 1]!;
  cur[last] = value;
}
