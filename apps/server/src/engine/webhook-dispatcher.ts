/**
 * Outbound instance-webhook dispatcher (P4-T4, PROTOCOL.md §Outbound) — the
 * host side of CTB's "events out" surface.
 *
 * When something noteworthy happens (`execution.finished` / `execution.failed`
 * / `user.first_seen`), the relevant call-site builds an {@link OutboundEvent}
 * and hands it to {@link WebhookDispatcher.dispatch}. The dispatcher:
 *   1. loads every ACTIVE `instance_webhooks` row that subscribes to the event
 *      and whose bot scope matches (null = all bots, else the event's bot),
 *   2. POSTs the event envelope as JSON to each subscription's URL,
 *      optionally signed with `X-CTB-Signature: sha256=<hex>` (HMAC-SHA256 of
 *      the raw body, keyed by the subscription's `secret`),
 *   3. retries transient failures with a small backoff, and
 *   4. stamps `last_fired_at` + `last_error` on the row (best-effort).
 *
 * Delivery is FIRE-AND-FORGET: `dispatch()` returns immediately and the network
 * work runs out-of-band so an event source (the executor finishing, a user
 * being seen) is never blocked or failed by a slow/broken endpoint. A test can
 * `await dispatcher.drain()` to flush in-flight deliveries deterministically.
 *
 * Lives in apps/server (NOT core): core never does I/O or imports HTTP (I3).
 */
import { createHmac } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { OutboundEvent, OutboundEventName } from '@ctb/shared';
import { WEBHOOK_SIGNATURE_HEADER } from '../triggers/webhook';
import type { Db } from '../db/index';
import { instanceWebhooks } from '../db/schema';

/** Logger shape used across the server engine: `(level, message, data?)`. */
type DispatchLog = (
  level: 'debug' | 'info' | 'warn' | 'error',
  message: string,
  data?: unknown,
) => void;

export interface WebhookDispatcherDeps {
  db: Db;
  /** Injectable fetch (tests pass a fake); defaults to global fetch. */
  fetchImpl?: typeof fetch;
  log?: DispatchLog;
  clock?: () => Date;
  /** Per-request timeout in ms (default 10s). */
  timeoutMs?: number;
  /** Total attempts per delivery incl. the first (default 3). */
  maxAttempts?: number;
  /** Base backoff between attempts in ms (default 250; 0 disables the wait). */
  backoffMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BACKOFF_MS = 250;

const sleep = (ms: number): Promise<void> =>
  ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve();

export class WebhookDispatcher {
  private readonly db: Db;
  private readonly fetchImpl: typeof fetch;
  private readonly log: DispatchLog;
  private readonly clock: () => Date;
  private readonly timeoutMs: number;
  private readonly maxAttempts: number;
  private readonly backoffMs: number;
  /** In-flight deliveries; `drain()` awaits them (tests + graceful shutdown). */
  private readonly inflight = new Set<Promise<void>>();

  constructor(deps: WebhookDispatcherDeps) {
    this.db = deps.db;
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.log = deps.log ?? (() => undefined);
    this.clock = deps.clock ?? (() => new Date());
    this.timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxAttempts = deps.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.backoffMs = deps.backoffMs ?? DEFAULT_BACKOFF_MS;
  }

  /**
   * Fire all subscriptions matching `event`. Returns immediately; the actual
   * HTTP work is tracked in `inflight` and can be awaited via `drain()`.
   */
  dispatch(event: OutboundEvent): void {
    const subs = this.matchingSubscriptions(event.event, event.bot_id);
    if (subs.length === 0) return;
    for (const sub of subs) {
      const p = this.deliver(sub, event).finally(() => this.inflight.delete(p));
      this.inflight.add(p);
    }
  }

  /** Await all in-flight deliveries (deterministic in tests; flush on shutdown). */
  async drain(): Promise<void> {
    while (this.inflight.size > 0) {
      await Promise.allSettled([...this.inflight]);
    }
  }

  /** ACTIVE subscriptions for this event whose bot scope matches (null = all). */
  private matchingSubscriptions(
    eventName: OutboundEventName,
    botId: string,
  ): { id: string; url: string; secret: string | null; events: string[] }[] {
    const rows = this.db
      .select()
      .from(instanceWebhooks)
      .where(eq(instanceWebhooks.active, true))
      .all();
    return rows
      .filter((r) => r.botId === null || r.botId === botId)
      .filter((r) => Array.isArray(r.events) && r.events.includes(eventName))
      .map((r) => ({ id: r.id, url: r.url, secret: r.secret, events: r.events }));
  }

  private async deliver(
    sub: { id: string; url: string; secret: string | null },
    event: OutboundEvent,
  ): Promise<void> {
    const body = JSON.stringify(event);
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'user-agent': 'ctb-webhooks/1',
      'x-ctb-event': event.event,
    };
    if (sub.secret) {
      headers[WEBHOOK_SIGNATURE_HEADER] =
        'sha256=' + createHmac('sha256', sub.secret).update(body).digest('hex');
    }

    let lastErr: string | null = null;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      try {
        const res = await this.fetchWithTimeout(sub.url, body, headers);
        if (res.ok) {
          this.stamp(sub.id, null);
          return;
        }
        lastErr = `HTTP ${res.status}`;
        // 4xx (except 408/429) are not worth retrying — the request is bad.
        if (res.status < 500 && res.status !== 408 && res.status !== 429) break;
      } catch (err) {
        lastErr = err instanceof Error ? err.message : String(err);
      }
      if (attempt < this.maxAttempts) await sleep(this.backoffMs * attempt);
    }
    this.log('warn', `webhook delivery failed for ${sub.url}: ${lastErr}`, { webhookId: sub.id });
    this.stamp(sub.id, lastErr ?? 'unknown_error');
  }

  private async fetchWithTimeout(
    url: string,
    body: string,
    headers: Record<string, string>,
  ): Promise<Response> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      return await this.fetchImpl(url, {
        method: 'POST',
        headers,
        body,
        signal: ctrl.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  /** Record the outcome on the row (best-effort; a stamp failure never throws). */
  private stamp(id: string, error: string | null): void {
    try {
      this.db
        .update(instanceWebhooks)
        .set({ lastFiredAt: this.clock().toISOString(), lastError: error })
        .where(and(eq(instanceWebhooks.id, id)))
        .run();
    } catch {
      /* ignore — delivery already happened; bookkeeping is non-critical */
    }
  }
}
