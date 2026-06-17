/**
 * data.limit — Limit (NODES.md §Data & code; PLAN2 PA-T6).
 *
 * Keeps only the first or last N items on the `main` port:
 *   keep=first (default): the first `max_items` items.
 *   keep=last:            the last  `max_items` items.
 * `max_items=0` lets everything through (no limit). Items are never mutated;
 * the same item references pass through in their original relative order.
 */
import {
  DataLimitParamsSchema,
  out,
  type DataLimitParams,
  type NodeDef,
} from '@ctb/shared';

export const dataLimit: NodeDef<DataLimitParams> = {
  type: 'data.limit',
  category: 'data',
  meta: {
    labelKey: 'nodes.data.limit.label',
    descriptionKey: 'nodes.data.limit.desc',
    icon: 'scissors',
  },
  ports: { inputs: ['main'], outputs: ['main'] },
  paramsSchema: DataLimitParamsSchema,
  async execute(_ctx, params, items) {
    const n = params.max_items;
    if (n <= 0 || items.length <= n) {
      return out({ main: items });
    }
    const kept = params.keep === 'last' ? items.slice(items.length - n) : items.slice(0, n);
    return out({ main: kept });
  },
};
