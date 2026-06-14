/**
 * flow.respondToWebhook — Respond to Webhook (NODES.md §Respond to Webhook,
 * P4-T1). Produces the HTTP response for a SYNC `webhook.trigger`.
 *
 * Like flow.return, it parks its result in a reserved $vars key and the HOST
 * (the webhook route in apps/server/src/triggers/webhook.ts) reads that key via
 * the SAME exported constant once the run reaches a terminal/waiting status —
 * so the contract can never drift. UNLIKE flow.return it is NOT terminal: it
 * passes its input through on `main` so the flow can keep running (e.g. send a
 * Telegram confirmation) after answering the HTTP caller.
 *
 * Reaching it in an ASYNC webhook run (or a non-webhook run) is harmless — it
 * parks a value nobody reads and passes items through.
 *
 * params.body / params.headers[].value arrive already {{ }}-resolved (the
 * executor resolves templates before calling execute), so this node only
 * shapes the parked object.
 */
import {
  FlowRespondToWebhookParamsSchema,
  out,
  type FlowItem,
  type FlowRespondToWebhookParams,
  type NodeDef,
} from '@ctb/shared';

/**
 * Reserved $vars key the sync HTTP response is parked under. Double underscores
 * keep it clear of any user variable name; the webhook route reads it via this
 * SAME exported constant.
 */
export const WEBHOOK_RESPONSE_VAR = '__webhook_response__';

/** The shape parked under WEBHOOK_RESPONSE_VAR — what the route turns into an HTTP reply. */
export interface ParkedWebhookResponse {
  status: number;
  bodyType: 'json' | 'text';
  body: string;
  headers: Record<string, string>;
}

export const flowRespondToWebhook: NodeDef<FlowRespondToWebhookParams> = {
  type: 'flow.respondToWebhook',
  category: 'flow',
  meta: {
    labelKey: 'nodes.flow.respondToWebhook.label',
    descriptionKey: 'nodeDesc.flow.respondToWebhook',
    icon: 'reply',
  },
  ports: { inputs: ['main'], outputs: ['main'] },
  paramsSchema: FlowRespondToWebhookParamsSchema,
  async execute(ctx, params, items) {
    const headers: Record<string, string> = {};
    for (const row of params.headers) headers[row.name] = row.value;

    const parked: ParkedWebhookResponse = {
      status: params.status,
      bodyType: params.body_type,
      body: params.body,
      headers,
    };
    ctx.vars.set(WEBHOOK_RESPONSE_VAR, parked);

    // Pass-through (seed one empty item if the branch produced none, like
    // data.setFields) so the flow keeps going after replying.
    const output: FlowItem[] = items.length > 0 ? items : [{ json: {} }];
    return out({ main: output });
  },
};
