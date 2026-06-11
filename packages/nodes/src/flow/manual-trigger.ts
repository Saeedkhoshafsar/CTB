/**
 * flow.manualTrigger — Manual Trigger (NODES.md §Triggers). The editor's
 * "Test flow" button starts an execution at this node; like tg.trigger it
 * anchors the entry point and carries the param schema — but here execute()
 * does real work: it parses the configured `sample` JSON into the first
 * item's $json so flow authors can test with realistic data.
 *
 * Entry items injected by the caller (Executor.start entry) win over
 * `sample` — a test harness may pass an explicit payload. Invalid sample
 * JSON fails loudly (a test run silently using {} would mislead).
 * Counts as a trigger for activation validation (shared/flow-validate.ts).
 */
import {
  fail,
  FlowManualTriggerParamsSchema,
  out,
  type FlowManualTriggerParams,
  type NodeDef,
} from '@ctb/shared';

export const flowManualTrigger: NodeDef<FlowManualTriggerParams> = {
  type: 'flow.manualTrigger',
  category: 'trigger',
  meta: { labelKey: 'nodes.flow.manualTrigger.label', descriptionKey: 'nodes.flow.manualTrigger.desc', icon: 'play' },
  ports: { inputs: [], outputs: ['main'] },
  paramsSchema: FlowManualTriggerParamsSchema,
  async execute(_ctx, params, items) {
    if (items.length > 0) return out({ main: items });
    if (params.sample !== undefined && params.sample.trim() !== '') {
      let parsed: unknown;
      try {
        parsed = JSON.parse(params.sample);
      } catch (err) {
        return fail(`flow.manualTrigger: sample is not valid JSON: ${err instanceof Error ? err.message : err}`);
      }
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return fail('flow.manualTrigger: sample must be a JSON object');
      }
      return out({ main: [{ json: parsed as Record<string, unknown> }] });
    }
    return out({ main: [{ json: {} }] });
  },
};
