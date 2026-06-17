/**
 * data.filter — Filter items (NODES.md §Data & code; PLAN2 PA-T4).
 *
 * Partitions items into two groups: `kept` (conditions pass) and `discarded`
 * (conditions fail). Reuses the flow.if condition engine (compareValues) so
 * operators, AND/OR combine logic, and loose-numeric equality are IDENTICAL to
 * flow.if — a user who knows IF already knows Filter.
 *
 * Differs from flow.if in purpose and output port names:
 *   • flow.if: branches the whole batch at a decision point in the flow.
 *   • data.filter: partitions items, keeping both sets in the pipeline.
 *
 * Both ports (`kept` / `discarded`) are always emitted — even when empty —
 * so downstream branches always have edges to connect to.
 * Items are never mutated.
 */
import {
  DataFilterParamsSchema,
  out,
  type DataFilterParams,
  type FlowItem,
  type IfCondition,
  type NodeDef,
} from '@ctb/shared';
import { compareValues } from '../lib/compare';

export const dataFilter: NodeDef<DataFilterParams> = {
  type: 'data.filter',
  category: 'data',
  meta: {
    labelKey: 'nodes.data.filter.label',
    descriptionKey: 'nodes.data.filter.desc',
    icon: 'filter',
  },
  ports: { inputs: ['main'], outputs: ['kept', 'discarded'] },
  paramsSchema: DataFilterParamsSchema,
  async execute(_ctx, params, items) {
    const input: FlowItem[] = items.length > 0 ? items : [{ json: {} }];
    const kept: FlowItem[] = [];
    const discarded: FlowItem[] = [];

    for (const item of input) {
      const verdicts = params.conditions.map((c) => evalCondition(c));
      const pass =
        params.combine === 'or'
          ? verdicts.some(Boolean)
          : verdicts.every(Boolean);
      (pass ? kept : discarded).push(item);
    }

    return out({ kept, discarded });
  },
};

function evalCondition(c: IfCondition): boolean {
  return compareValues(c.value1, c.operator, c.value2);
}
