/**
 * trigger.callEvent — live-voice trigger (NODES.md §Live voice, Phase E / PE-T3).
 *
 * A pure PASS-THROUGH node like schedule.trigger / tg.trigger / webhook.trigger:
 * the host-side Call-event bus (apps/server/src/triggers/call-events.ts) watches
 * the Call Session Service's utterance + lifecycle streams and, when a matching
 * call event fires (callJoined / utteranceFinal / turnOpened / callLeft for the
 * configured target), builds the trigger item and starts the run. By the time
 * execute() runs the host has already done all the work; the node just forwards
 * the item it was handed.
 *
 * One generic trigger serves BOTH live-voice scenarios via config (invariant I2):
 *   - `mode: 'support'` — a Channel-Direct 1:1 call an AI answers in real time;
 *   - `mode: 'lineup'`  — a group/channel broadcast with a Q&A turn queue.
 *
 * Emitted item shape (built by the Call-event bus):
 *   `{ json: { event, target:{kind,id}, mode, speakerId?, audioFileId?,
 *              audioMime?, audioSampleRate?, currentTurn?, queue? } }`
 *   (`audio*` only on `utteranceFinal`; `currentTurn`/`queue` on lifecycle.)
 */
import {
  CallEventTriggerParamsSchema,
  out,
  type CallEventTriggerParams,
  type NodeDef,
} from '@ctb/shared';

export const callEventTrigger: NodeDef<CallEventTriggerParams> = {
  type: 'trigger.callEvent',
  category: 'trigger',
  meta: {
    labelKey: 'nodes.trigger.callEvent.label',
    descriptionKey: 'nodeDesc.trigger.callEvent',
    icon: 'phone',
  },
  ports: { inputs: [], outputs: ['main'] },
  paramsSchema: CallEventTriggerParamsSchema,
  // `connection` is a credential ref and `targetId` is a host match key the
  // Call-event bus resolves itself — neither is a runtime template for THIS
  // node, so the executor must not {{ }}-evaluate them.
  rawParamKeys: ['connection', 'targetId'],
  async execute(_ctx, _params, items) {
    return out({ main: items });
  },
};
