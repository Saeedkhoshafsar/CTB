/**
 * SqliteAiUsageStore (PD-T2 — agent cost governance). The host's AI spend ledger
 * over the `ai_usage` table. It has three jobs, all sharing ONE notion of "what
 * a bot has spent" so enforcement and the panel can never drift:
 *
 *   1. RECORD — `record()` writes one row per LLM call (called by the host's
 *      `ctx.ai.chat` wrapper AFTER the provider replies with reported usage).
 *   2. ENFORCE — `todayTotals(botId)` sums the current UTC day's calls + tokens
 *      so the host can refuse a call that would breach a per-bot daily cap.
 *   3. SURFACE — `summary(botId)` returns the per-credential + today/all-time
 *      totals the panel's AI-usage view renders.
 *
 * The host owns the table (invariant I6) — nodes never see it; they only ever
 * issue `ctx.ai.chat`, and the per-bot wrapper meters + caps around it.
 */
import { and, desc, eq, sql } from 'drizzle-orm';
import type { AiUsageByCredential, AiUsageSummary, BotAiBudget } from '@ctb/shared';
import type { Db } from '../db/index';
import { aiUsage } from '../db/schema';

/** A single metered call (what the host hands `record()`). */
export interface AiUsageEntry {
  botId: string;
  flowId?: string | null;
  executionId?: string | null;
  credentialId: string;
  model?: string;
  promptTokens?: number | undefined;
  completionTokens?: number | undefined;
  totalTokens?: number | undefined;
}

/** UTC date string (YYYY-MM-DD) of an ISO timestamp — the daily-window key. */
export function utcDay(iso: string): string {
  // ISO-8601 from `Date#toISOString()` is always `YYYY-MM-DDT…Z` — the date is
  // the first 10 chars and is already in UTC.
  return iso.slice(0, 10);
}

export class SqliteAiUsageStore {
  constructor(
    private readonly db: Db,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  /** Persist one metered LLM call. Non-finite/negative token counts coerce to 0. */
  record(entry: AiUsageEntry): void {
    const ts = this.clock().toISOString();
    const clamp = (n: number | undefined): number =>
      typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
    this.db
      .insert(aiUsage)
      .values({
        botId: entry.botId,
        flowId: entry.flowId ?? null,
        executionId: entry.executionId ?? null,
        credentialId: entry.credentialId ?? '',
        model: entry.model ?? '',
        promptTokens: clamp(entry.promptTokens),
        completionTokens: clamp(entry.completionTokens),
        totalTokens: clamp(entry.totalTokens),
        day: utcDay(ts),
        ts,
      })
      .run();
  }

  /** Today's (current UTC day) running totals for a bot — drives the daily caps. */
  todayTotals(botId: string): { calls: number; totalTokens: number } {
    const day = utcDay(this.clock().toISOString());
    const row = this.db
      .select({
        calls: sql<number>`count(*)`,
        totalTokens: sql<number>`coalesce(sum(${aiUsage.totalTokens}), 0)`,
      })
      .from(aiUsage)
      .where(and(eq(aiUsage.botId, botId), eq(aiUsage.day, day)))
      .get();
    return { calls: row?.calls ?? 0, totalTokens: row?.totalTokens ?? 0 };
  }

  /** Lifetime totals for a bot. */
  allTimeTotals(botId: string): { calls: number; totalTokens: number } {
    const row = this.db
      .select({
        calls: sql<number>`count(*)`,
        totalTokens: sql<number>`coalesce(sum(${aiUsage.totalTokens}), 0)`,
      })
      .from(aiUsage)
      .where(eq(aiUsage.botId, botId))
      .get();
    return { calls: row?.calls ?? 0, totalTokens: row?.totalTokens ?? 0 };
  }

  /** Lifetime spend broken down per credential (most-spent first). */
  byCredential(botId: string): AiUsageByCredential[] {
    const rows = this.db
      .select({
        credentialId: aiUsage.credentialId,
        calls: sql<number>`count(*)`,
        promptTokens: sql<number>`coalesce(sum(${aiUsage.promptTokens}), 0)`,
        completionTokens: sql<number>`coalesce(sum(${aiUsage.completionTokens}), 0)`,
        totalTokens: sql<number>`coalesce(sum(${aiUsage.totalTokens}), 0)`,
      })
      .from(aiUsage)
      .where(eq(aiUsage.botId, botId))
      .groupBy(aiUsage.credentialId)
      .orderBy(desc(sql`coalesce(sum(${aiUsage.totalTokens}), 0)`))
      .all();
    return rows.map((r) => ({
      credentialId: r.credentialId,
      calls: r.calls,
      promptTokens: r.promptTokens,
      completionTokens: r.completionTokens,
      totalTokens: r.totalTokens,
    }));
  }

  /** The full panel summary (PD-T2): budget echo + today/all-time + per-credential. */
  summary(botId: string, budget: BotAiBudget): AiUsageSummary {
    return {
      budget,
      today: this.todayTotals(botId),
      allTime: this.allTimeTotals(botId),
      byCredential: this.byCredential(botId),
    };
  }
}
