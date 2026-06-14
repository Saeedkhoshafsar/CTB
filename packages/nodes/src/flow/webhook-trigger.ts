/**
 * webhook.trigger — inbound HTTP trigger (NODES.md §Webhook Trigger, P4-T1).
 *
 * A pure PASS-THROUGH node like tg.trigger / collection.recordChanged: the
 * route (apps/server/src/triggers/webhook.ts) authenticates the request
 * (per-flow path secret + optional HMAC), builds the trigger item from the
 * request (body/headers/query/method → $json) and starts the run. By the time
 * execute() runs the host has already done all the work; the node just forwards
 * the item it was handed.
 *
 * Emitted item shape (built by the route):
 *   `{ json: { body, headers, query, method } }`
 */
import {
  WebhookTriggerParamsSchema,
  out,
  type NodeDef,
  type WebhookTriggerParams,
} from '@ctb/shared';

export const webhookTrigger: NodeDef<WebhookTriggerParams> = {
  type: 'webhook.trigger',
  category: 'trigger',
  meta: {
    labelKey: 'nodes.webhook.trigger.label',
    descriptionKey: 'nodeDesc.webhook.trigger',
    icon: 'webhook',
  },
  ports: { inputs: [], outputs: ['main'] },
  paramsSchema: WebhookTriggerParamsSchema,
  // `mode` / `verify_signature` / `sync_timeout` are HOST directives consumed by
  // the route, and `target_chat` is an expression the Telegram nodes resolve
  // themselves — none are runtime templates for THIS node, so the executor must
  // not {{ }}-evaluate target_chat (it would resolve to a string and could fail
  // the optional re-validation when the trigger node runs).
  rawParamKeys: ['target_chat'],
  async execute(_ctx, _params, items) {
    return out({ main: items });
  },
};
