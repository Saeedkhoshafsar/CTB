/**
 * flow.if — IF (NODES.md §Flow control). Routes EACH item to "true"/"false"
 * by evaluating the condition rows against its (already expression-resolved)
 * values, combined with AND/OR.
 *
 * Comparison semantics live in lib/compare.ts (shared with flow.switch since
 * P2-T6 so the two nodes judge values identically).
 */
import {
  FlowIfParamsSchema,
  out,
  type FlowIfParams,
  type FlowItem,
  type IfCondition,
  type NodeDef,
} from '@ctb/shared';
import { compareValues } from '../lib/compare';

export const flowIf: NodeDef<FlowIfParams> = {
  type: 'flow.if',
  category: 'flow',
  meta: { labelKey: 'nodes.flow.if.label', descriptionKey: 'nodes.flow.if.desc', icon: 'git-branch' },
  ports: { inputs: ['main'], outputs: ['true', 'false'] },
  paramsSchema: FlowIfParamsSchema,
  async execute(_ctx, params, items) {
    const input: FlowItem[] = items.length > 0 ? items : [{ json: {} }];
    const yes: FlowItem[] = [];
    const no: FlowItem[] = [];
    for (const item of input) {
      const verdicts = params.conditions.map(evalCondition);
      const pass = params.combine === 'or' ? verdicts.some(Boolean) : verdicts.every(Boolean);
      (pass ? yes : no).push(item);
    }
    return out({ true: yes, false: no });
  },
};

function evalCondition(c: IfCondition): boolean {
  return compareValues(c.value1, c.operator, c.value2);
}
