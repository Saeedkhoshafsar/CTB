/**
 * flow.switch — Switch (NODES.md §Flow control). Routes EACH item to the
 * output port of the FIRST matching rule; no match → `default`.
 *
 * `value` and each rule's `match` arrive already expression-resolved (the
 * executor resolves {{ }} in params before execute). Comparison semantics
 * are shared with flow.if via lib/compare.ts so the two nodes judge values
 * identically ("18" equals 18, invalid regex → false, …).
 *
 * Ports: dynamic — one per rule port (+ `default`), via dynamicOutputs
 * (registry + canvas use the SAME shared key convention).
 */
import {
  FlowSwitchParamsSchema,
  out,
  switchOutputs,
  type FlowItem,
  type FlowSwitchParams,
  type NodeDef,
  type PortName,
} from '@ctb/shared';
import { compareValues } from '../lib/compare';

export const flowSwitch: NodeDef<FlowSwitchParams> = {
  type: 'flow.switch',
  category: 'flow',
  meta: { labelKey: 'nodes.flow.switch.label', descriptionKey: 'nodes.flow.switch.desc', icon: 'split' },
  ports: { inputs: ['main'], outputs: [] },
  dynamicOutputs: (params) => switchOutputs(params),
  paramsSchema: FlowSwitchParamsSchema,
  async execute(_ctx, params, items) {
    const input: FlowItem[] = items.length > 0 ? items : [{ json: {} }];
    const outputs: Partial<Record<PortName, FlowItem[]>> = {};
    for (const port of switchOutputs(params)) outputs[port] = [];

    for (const item of input) {
      const rule = params.rules.find((r) => compareValues(params.value, r.operator, r.match));
      (outputs[rule ? rule.port : 'default'] ??= []).push(item);
    }
    return out(outputs);
  },
};
