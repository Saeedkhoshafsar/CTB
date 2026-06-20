/**
 * SqliteApiAuditStore (PD-T3) — the host's append-only audit log of every
 * authoring/trigger call on the public `/api/v1/*` surface. It answers one
 * question for an operator: *who built/ran what, when, and with which token?*
 *
 *   • RECORD — `record()` writes one row per audited call (the v1 routes call it
 *     AFTER they've decided the response status, so the audit reflects reality:
 *     a 403/422/404 is logged just like a 201/202).
 *   • SURFACE — `list()` returns most-recent-first entries for the panel's audit
 *     view, optionally filtered by token or bot.
 *
 * The host owns the table (invariant I6) — a token can never read its own audit;
 * only the cookie-authenticated panel surface (or an instance-wide query) reads it.
 */
import { and, desc, eq, type SQL } from 'drizzle-orm';
import type { ApiAuditEntry } from '@ctb/shared';
import type { Db } from '../db/index';
import { apiAudit } from '../db/schema';

/** A single audited call (what the v1 routes hand `record()`). */
export interface AuditEntryInput {
  tokenId: string | null;
  botId?: string | null;
  action: string;
  method: string;
  route: string;
  targetId?: string | null;
  status: number;
}

/** Filters for the panel's audit view. */
export interface AuditQuery {
  tokenId?: string | undefined;
  botId?: string | undefined;
  limit?: number | undefined;
}

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

export class SqliteApiAuditStore {
  constructor(
    private readonly db: Db,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  /** Append one audit row. Best-effort: callers must never block on it. */
  record(entry: AuditEntryInput): void {
    this.db
      .insert(apiAudit)
      .values({
        tokenId: entry.tokenId,
        botId: entry.botId ?? null,
        action: entry.action,
        method: entry.method,
        route: entry.route,
        targetId: entry.targetId ?? null,
        status: entry.status,
        ts: this.clock().toISOString(),
      })
      .run();
  }

  /** Most-recent-first audit entries, optionally filtered by token / bot. */
  list(query: AuditQuery = {}): ApiAuditEntry[] {
    const limit = Math.min(Math.max(1, query.limit ?? DEFAULT_LIMIT), MAX_LIMIT);
    const conds: SQL[] = [];
    if (query.tokenId !== undefined) conds.push(eq(apiAudit.tokenId, query.tokenId));
    if (query.botId !== undefined) conds.push(eq(apiAudit.botId, query.botId));

    const base = this.db.select().from(apiAudit);
    const filtered = conds.length > 0 ? base.where(and(...conds)) : base;
    const rows = filtered.orderBy(desc(apiAudit.id)).limit(limit).all();

    return rows.map((r) => ({
      id: r.id,
      tokenId: r.tokenId,
      botId: r.botId,
      action: r.action,
      method: r.method,
      route: r.route,
      targetId: r.targetId,
      status: r.status,
      ts: r.ts,
    }));
  }
}
