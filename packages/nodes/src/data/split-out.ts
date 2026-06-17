/**
 * data.splitOut — Split Out (NODES.md §Data & code; PLAN2 PA-T5).
 *
 * Splits one item that contains an array field into one item per element
 * (n8n "Split Out"). The inverse of data.aggregate.
 *
 * Ports:
 *   `main`  — one item per array element.
 *   `empty` — original item passed through when the array is empty/missing.
 *
 * When `field` resolves to a non-array, it is treated as a single-element
 * array (n8n-compatible behaviour). Items are never mutated.
 */
import {
  DataSplitOutParamsSchema,
  out,
  type DataSplitOutParams,
  type FlowItem,
  type NodeDef,
} from '@ctb/shared';

export const dataSplitOut: NodeDef<DataSplitOutParams> = {
  type: 'data.splitOut',
  category: 'data',
  meta: {
    labelKey: 'nodes.data.splitOut.label',
    descriptionKey: 'nodes.data.splitOut.desc',
    icon: 'split',
  },
  ports: { inputs: ['main'], outputs: ['main', 'empty'] },
  paramsSchema: DataSplitOutParamsSchema,
  async execute(_ctx, params, items) {
    const input: FlowItem[] = items.length > 0 ? items : [{ json: {} }];
    const main: FlowItem[] = [];
    const empty: FlowItem[] = [];

    for (const item of input) {
      const json = item.json as Record<string, unknown>;
      const raw = getPath(json, params.field);

      // Normalise to an array (non-array → wrap in single-element array).
      const arr: unknown[] = Array.isArray(raw) ? raw : raw !== undefined ? [raw] : [];

      if (arr.length === 0) {
        // No elements → send original item to `empty` port.
        empty.push(item);
        continue;
      }

      for (const el of arr) {
        let outJson: Record<string, unknown>;

        if (params.include === 'selected_field_only') {
          // Only the extracted element.
          if (el !== null && typeof el === 'object' && !Array.isArray(el)) {
            outJson = { ...(el as Record<string, unknown>) };
          } else {
            outJson = { value: el };
          }
        } else {
          // all_fields: copy the original item, replace the array field with el.
          outJson = setPath(structuredClone(json) as Record<string, unknown>, params.field, el);
        }

        const next: FlowItem = { json: outJson };
        if (item.binary !== undefined) next.binary = item.binary;
        main.push(next);
      }
    }

    return out({ main, empty });
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

/** Set the value at a dotted path on an already-cloned object (in-place). */
function setPath(
  obj: Record<string, unknown>,
  path: string,
  value: unknown,
): Record<string, unknown> {
  const [head, ...rest] = path.split('.');
  if (head === undefined || head === '') return obj;
  const copy = { ...obj };
  if (rest.length === 0) {
    copy[head] = value;
    return copy;
  }
  const child = copy[head];
  const childObj =
    child !== null && typeof child === 'object' && !Array.isArray(child)
      ? ({ ...(child as Record<string, unknown>) })
      : {};
  copy[head] = setPath(childObj, rest.join('.'), value);
  return copy;
}
