/**
 * schedule.trigger — time-based trigger (NODES.md §Schedule Trigger, P4-T2).
 *
 * A pure PASS-THROUGH node like tg.trigger / webhook.trigger: the host-side
 * Scheduler (apps/server/src/triggers/schedule.ts) runs a cron job per active
 * schedule.trigger node and, when it fires, builds the trigger item and starts
 * the run. By the time execute() runs the host has already done all the work;
 * the node just forwards the item it was handed.
 *
 * Emitted item shape (built by the Scheduler):
 *   `{ json: { now, cron, timezone, scheduled: true, user? } }`
 *   (`user` is present only on a `for_each_user` fan-out run.)
 */
import {
  ScheduleTriggerParamsSchema,
  out,
  type NodeDef,
  type ScheduleTriggerParams,
} from '@ctb/shared';

export const scheduleTrigger: NodeDef<ScheduleTriggerParams> = {
  type: 'schedule.trigger',
  category: 'trigger',
  meta: {
    labelKey: 'nodes.schedule.trigger.label',
    descriptionKey: 'nodeDesc.schedule.trigger',
    icon: 'clock',
  },
  ports: { inputs: [], outputs: ['main'] },
  paramsSchema: ScheduleTriggerParamsSchema,
  // `cron` / `timezone` / `for_each_user` / `rate_per_min` are HOST directives
  // consumed by the Scheduler, and `target_chat` is an expression the Telegram
  // nodes resolve themselves — none are runtime templates for THIS node, so the
  // executor must not {{ }}-evaluate them (notably target_chat would resolve to
  // a string and could fail the optional re-validation when the node runs).
  rawParamKeys: ['cron', 'timezone', 'target_chat'],
  async execute(_ctx, _params, items) {
    return out({ main: items });
  },
};
