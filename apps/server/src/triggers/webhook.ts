/**
 * Inbound Webhook Trigger route (P4-T1, PROTOCOL.md §Inbound).
 *
 *   POST /hooks/flow/:flowId/:secret
 *
 * Registered OUTSIDE /api/ so the editor auth guard never touches it — auth is
 * the unguessable per-flow PATH SECRET (derived from CTB_SECRET, no DB column,
 * survives restarts — same approach as the Telegram gateway's webhookSecretFor)
 * plus an OPTIONAL HMAC signature over the raw body.
 *
 * The request (body/headers/query/method) becomes the first item's $json; the
 * run starts at the flow's enabled `webhook.trigger` node (chatId=null — a
 * webhook-started run has no implicit chat, like collection.recordChanged).
 *
 *  • async (default): reply 202 {ok,executionId} immediately, run out-of-band.
 *  • sync: run to a terminal/waiting status (bounded by the node's sync_timeout,
 *    capped ≤120s; overrun → 504) then reply with what a `flow.respondToWebhook`
 *    node parked under WEBHOOK_RESPONSE_VAR; no respond node → 200 ack.
 *
 * HMAC needs the EXACT request bytes, so this route is mounted inside an
 * encapsulated Fastify plugin scope that installs a raw-body-preserving JSON
 * parser — the rest of the app keeps Fastify's default parser untouched.
 */
import { createHmac, randomUUID } from 'node:crypto';
import type { Executor } from '@ctb/core';
import {
  FlowGraphSchema,
  WebhookTriggerParamsSchema,
  type FlowItem,
} from '@ctb/shared';
import { WEBHOOK_RESPONSE_VAR, type ParkedWebhookResponse } from '@ctb/nodes';
import { eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Db } from '../db/index';
import { flows } from '../db/schema';
import type { SqliteExecutionStore } from '../engine/sqlite-store';
import { safeEqual } from '../lib/session';

/** Hard ceiling on how long a sync webhook may hold the connection (mirrors the schema max). */
const MAX_SYNC_TIMEOUT_MS = 120_000;

/** Header carrying the optional HMAC signature. */
export const WEBHOOK_SIGNATURE_HEADER = 'x-ctb-signature';

/**
 * Per-flow PATH secret — deterministic, derived from CTB_SECRET so it survives
 * restarts without another DB column. Unguessable (HMAC-SHA256, base64url).
 */
export function flowWebhookSecret(flowId: string, ctbSecret: string): string {
  return createHmac('sha256', `ctb-hook-v1:${ctbSecret}`).update(flowId).digest('base64url');
}

/**
 * Per-flow HMAC KEY — a SEPARATE derivation from the path secret so leaking one
 * never reveals the other. This is the key callers sign the request body with.
 */
export function flowWebhookHmacKey(flowId: string, ctbSecret: string): string {
  return createHmac('sha256', `ctb-hook-hmac-v1:${ctbSecret}`).update(flowId).digest('hex');
}

/** The canonical signature string for a raw body: `sha256=<hex>`. */
export function signWebhookBody(rawBody: string, flowId: string, ctbSecret: string): string {
  const key = flowWebhookHmacKey(flowId, ctbSecret);
  return 'sha256=' + createHmac('sha256', key).update(rawBody).digest('hex');
}

/** The full public URL for a flow's webhook (when a public base URL is configured). */
export function flowWebhookUrl(flowId: string, ctbSecret: string, publicUrl?: string): string {
  const path = `/hooks/flow/${flowId}/${flowWebhookSecret(flowId, ctbSecret)}`;
  if (!publicUrl) return path;
  return `${publicUrl.replace(/\/$/, '')}${path}`;
}

export interface WebhookRouteDeps {
  db: Db;
  executor: Executor;
  store: SqliteExecutionStore;
  ctbSecret: string;
}

/** Headers we never echo back into $json (auth/transport noise). */
const REDACTED_HEADERS = new Set(['authorization', 'cookie', WEBHOOK_SIGNATURE_HEADER]);

function buildTriggerItem(req: FastifyRequest, rawBody: string): FlowItem {
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (REDACTED_HEADERS.has(k.toLowerCase())) continue;
    headers[k] = Array.isArray(v) ? v.join(', ') : (v ?? '');
  }
  // Prefer the parsed JSON body; fall back to the raw text when not JSON.
  let body: unknown = req.body;
  if (body === undefined || body === null || body === '') {
    body = rawBody === '' ? {} : rawBody;
  }
  return { json: { body, headers, query: (req.query as unknown) ?? {}, method: req.method } };
}

/**
 * Resolve the trigger's optional `target_chat` against the request payload.
 * Accepts a literal numeric chat id, or a `$json.body.<field>` reference that
 * digs into the parsed request body (the common n8n case: `{ "chat_id": … }`).
 * Returns a finite number, or `null` when unset/unresolvable (chatless run).
 */
function resolveTargetChat(target: string | undefined, item: FlowItem): number | null {
  if (target === undefined || target === '') return null;
  const trimmed = target.trim();

  // Literal number (`"555"`).
  if (/^-?\d+$/.test(trimmed)) {
    const n = Number(trimmed);
    return Number.isFinite(n) ? n : null;
  }

  // `$json.body.<a>.<b>` reference into the trigger item.
  const m = trimmed.match(/^\{?\{?\s*\$json\.((?:[A-Za-z_$][\w$]*)(?:\.[A-Za-z_$][\w$]*)*)\s*\}?\}?$/);
  const path = m?.[1];
  if (path) {
    let cur: unknown = item.json;
    for (const key of path.split('.')) {
      if (cur === null || typeof cur !== 'object') return null;
      cur = (cur as Record<string, unknown>)[key];
    }
    const n = typeof cur === 'string' || typeof cur === 'number' ? Number(cur) : NaN;
    return Number.isFinite(n) ? n : null;
  }

  return null;
}

export function registerWebhookTriggerRoute(app: FastifyInstance, deps: WebhookRouteDeps): void {
  // Encapsulated scope: a raw-body-preserving JSON parser so HMAC sees exact
  // bytes. Scoped via register() so it does not affect the rest of the app.
  void app.register(async (scope) => {
    scope.addContentTypeParser(
      'application/json',
      { parseAs: 'string' },
      (req, body, done) => {
        (req as FastifyRequest & { rawBody?: string }).rawBody = body as string;
        if (body === '') return done(null, {});
        try {
          done(null, JSON.parse(body as string));
        } catch {
          // Keep the raw text available; body becomes the string.
          done(null, body);
        }
      },
    );

    scope.post<{ Params: { flowId: string; secret: string } }>(
      '/hooks/flow/:flowId/:secret',
      async (req, reply) => {
        const { flowId, secret } = req.params;

        // 1) Path-secret auth (timing-safe). Never reveal whether the flow exists.
        if (!safeEqual(secret, flowWebhookSecret(flowId, deps.ctbSecret))) {
          return reply.code(404).send({ error: 'not_found' });
        }

        const row = deps.db.select().from(flows).where(eq(flows.id, flowId)).get();
        if (!row) return reply.code(404).send({ error: 'not_found' });

        const graph = FlowGraphSchema.safeParse(row.graph);
        if (!graph.success) return reply.code(422).send({ error: 'invalid_graph' });

        const triggerNode = graph.data.nodes.find(
          (n) => n.type === 'webhook.trigger' && !n.disabled,
        );
        if (!triggerNode) {
          return reply.code(404).send({ error: 'no_webhook_trigger' });
        }
        const params = WebhookTriggerParamsSchema.parse(triggerNode.params ?? {});

        // 2) Optional HMAC over the raw body.
        const rawBody = (req as FastifyRequest & { rawBody?: string }).rawBody ?? '';
        if (params.verify_signature) {
          const given = req.headers[WEBHOOK_SIGNATURE_HEADER];
          const sig = Array.isArray(given) ? given[0] : given;
          const expected = signWebhookBody(rawBody, flowId, deps.ctbSecret);
          if (!sig || !safeEqual(sig, expected)) {
            return reply.code(401).send({ error: 'invalid_signature' });
          }
        }

        // 3) Build the trigger item + start the run.
        const item = buildTriggerItem(req, rawBody);
        // Optional `target_chat`: when set, the run is bound to a Telegram chat
        // so conversation nodes (tg.sendMessage / tg.waitForReply) work — this
        // is what makes a sync webhook able to ask a user and return the answer
        // (PROTOCOL.md "n8n → CTB" recipe). It is a literal chat id or a simple
        // `$json.body.<field>` reference into the request body; anything that
        // doesn't resolve to a finite number leaves the run chatless (null).
        const chatId = resolveTargetChat(params.target_chat, item);
        const executionId = randomUUID();
        const startArgs = {
          executionId,
          flow: { id: row.id, name: row.name },
          graph: graph.data,
          botId: row.botId,
          chatId,
          userId: null,
          entry: { nodeId: triggerNode.id, items: { main: [item] } },
        };

        if (params.mode === 'async') {
          // Fire-and-forget: reply 202, run out-of-band.
          void deps.executor.start(startArgs).catch(() => undefined);
          return reply.code(202).send({ ok: true, executionId });
        }

        // sync: hold the connection until flow.respondToWebhook parks a
        // response, the run reaches a terminal status, or the (clamped)
        // sync_timeout elapses. The run may PAUSE on a tg.waitForReply mid-way
        // (the "n8n → CTB" conversation recipe): start() returns `waiting`, the
        // user answers in Telegram, the router resumes the run on another tick,
        // and respondToWebhook eventually parks the answer — so we can't just
        // await start(); we poll the durable state until something resolves.
        const timeoutMs = Math.min(params.sync_timeout * 1000, MAX_SYNC_TIMEOUT_MS);
        const deadline = Date.now() + timeoutMs;

        // Kick off the run (fire-and-forget — its result is read from the store).
        let firstStatus: string | null = null;
        const run = deps.executor
          .start(startArgs)
          .then((r) => { firstStatus = r.status; })
          .catch(() => { firstStatus = 'error'; });

        const readParked = async (): Promise<ParkedWebhookResponse | undefined> => {
          const exec = await deps.store.load(executionId);
          return exec?.state.vars[WEBHOOK_RESPONSE_VAR] as ParkedWebhookResponse | undefined;
        };
        const readStatus = async (): Promise<string | undefined> =>
          (await deps.store.load(executionId))?.status;

        // Let the initial synchronous run settle (to a wait or a terminal state).
        await run;

        // Poll until a response is parked or the run is no longer in flight.
        let parked = await readParked();
        while (parked === undefined && Date.now() < deadline) {
          const status = await readStatus();
          if (status === 'done' || status === 'error' || status === 'canceled') break;
          await new Promise((r) => setTimeout(r, 25));
          parked = await readParked();
        }
        if (parked === undefined) parked = await readParked();

        if (parked) return sendParked(reply, parked);

        // No respond node parked anything. If the run is still parked on a wait
        // when the clock runs out, that's a sync timeout; otherwise it finished
        // without a response → a plain ack carrying the final status.
        const finalStatus = (await readStatus()) ?? firstStatus ?? 'running';
        if (finalStatus === 'waiting' || finalStatus === 'running') {
          return reply.code(504).send({ ok: false, error: 'sync_timeout', executionId });
        }
        return reply.code(200).send({ ok: true, executionId, status: finalStatus });
      },
    );
  });
}

/** Turn a parked response into the actual HTTP reply (Content-Type honoured/derived). */
function sendParked(reply: FastifyReply, parked: ParkedWebhookResponse): unknown {
  reply.code(parked.status);
  // Apply explicit headers first; a Content-Type row overrides the default.
  let explicitContentType = false;
  for (const [name, value] of Object.entries(parked.headers)) {
    reply.header(name, value);
    if (name.toLowerCase() === 'content-type') explicitContentType = true;
  }

  if (parked.bodyType === 'json') {
    if (!explicitContentType) reply.header('content-type', 'application/json');
    if (parked.body === '') return reply.send({});
    // Send valid JSON verbatim; fall back to wrapping non-JSON text.
    try {
      return reply.send(JSON.parse(parked.body));
    } catch {
      return reply.send(parked.body);
    }
  }

  if (!explicitContentType) reply.header('content-type', 'text/plain; charset=utf-8');
  return reply.send(parked.body);
}
