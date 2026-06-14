/**
 * SqliteUserStore (P3-T5) — the per-bot end-user record store (the `users`
 * table that, until now, was defined but never written). It powers three
 * consumers, all sharing ONE notion of a user so they can never drift:
 *
 *   1. the router, which upserts a user on every inbound update (first_seen on
 *      insert, last_seen + mirrored Telegram identity on every touch);
 *   2. the data.userProfile node, via the ctx.users capability the executor
 *      hands it (the host owns the table — invariant I6);
 *   3. the Users REST API (list / get / patch tags & profile).
 *
 * GENERIC by construction (invariant I2): the only structured columns are
 * `profile` (a JSON bag the flow author defines) and `tags` (string labels).
 * Telegram identity (first_name/last_name/username/lang) is MIRRORED into the
 * profile bag under reserved keys on upsert — never as dedicated columns — so
 * the schema stays domain-agnostic while flows can still read `{{ $json.user.
 * profile.first_name }}`.
 */
import { randomUUID } from 'node:crypto';
import type { CtbUser } from '@ctb/shared';
import { and, desc, eq } from 'drizzle-orm';
import type { Db } from '../db/index';
import { users } from '../db/schema';

type UserRow = typeof users.$inferSelect;

/** Telegram identity mirrored into the profile bag (reserved keys). */
export interface TgIdentity {
  firstName?: string;
  lastName?: string;
  username?: string;
  lang?: string;
}

function rowToUser(row: UserRow): CtbUser {
  return {
    tgUserId: row.tgUserId,
    profile: (row.profile as Record<string, unknown>) ?? {},
    tags: (row.tags as string[]) ?? [],
    firstSeen: row.firstSeen,
    lastSeen: row.lastSeen,
  };
}

/** Fired exactly once per user, on the insert path of `touch()` (P4-T4). */
export type FirstSeenListener = (botId: string, user: CtbUser) => void;

export class SqliteUserStore {
  /** Set by the host AFTER construction (avoids a wire ordering cycle). */
  private onFirstSeen: FirstSeenListener | null = null;

  constructor(
    private readonly db: Db,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  /**
   * Register a callback fired the FIRST time a given (bot, user) is touched —
   * i.e. when the router upserts a brand-new end user. Drives the outbound
   * `user.first_seen` instance webhook (P4-T4). Best-effort: a throwing or slow
   * listener must never break the upsert, so it runs guarded + out-of-band.
   */
  setFirstSeenListener(fn: FirstSeenListener | null): void {
    this.onFirstSeen = fn;
  }

  private now(): string {
    return this.clock().toISOString();
  }

  private rowFor(botId: string, tgUserId: number): UserRow | undefined {
    return this.db
      .select()
      .from(users)
      .where(and(eq(users.botId, botId), eq(users.tgUserId, tgUserId)))
      .get();
  }

  /** Read a user record; null if never seen. */
  get(botId: string, tgUserId: number): CtbUser | null {
    const row = this.rowFor(botId, tgUserId);
    return row ? rowToUser(row) : null;
  }

  /**
   * Upsert called by the router on every inbound update. Inserts a fresh record
   * (first_seen = now) or bumps last_seen, and mirrors the latest Telegram
   * identity into the profile bag (reserved keys) so it stays current without
   * the flow author touching it. Never overwrites author-set profile keys.
   */
  touch(botId: string, tgUserId: number, identity: TgIdentity = {}): CtbUser {
    const ts = this.now();
    const mirror: Record<string, unknown> = {};
    if (identity.firstName !== undefined) mirror.first_name = identity.firstName;
    if (identity.lastName !== undefined) mirror.last_name = identity.lastName;
    if (identity.username !== undefined) mirror.username = identity.username;
    if (identity.lang !== undefined) mirror.lang = identity.lang;

    const existing = this.rowFor(botId, tgUserId);
    if (!existing) {
      const row: UserRow = {
        id: randomUUID(),
        botId,
        tgUserId,
        profile: mirror,
        tags: [],
        firstSeen: ts,
        lastSeen: ts,
      };
      this.db.insert(users).values(row).run();
      const user = rowToUser(row);
      if (this.onFirstSeen) {
        try {
          this.onFirstSeen(botId, user);
        } catch {
          /* a broken listener must never break the upsert */
        }
      }
      return user;
    }
    // Re-mirror identity (author keys win on collision is unnecessary — these
    // are reserved keys) and bump last_seen.
    const profile = { ...(existing.profile as Record<string, unknown>), ...mirror };
    this.db
      .update(users)
      .set({ profile, lastSeen: ts })
      .where(eq(users.id, existing.id))
      .run();
    return rowToUser({ ...existing, profile, lastSeen: ts });
  }

  /** Merge (or replace) profile fields; upserts a bare record if unseen. */
  setProfile(
    botId: string,
    tgUserId: number,
    fields: Record<string, unknown>,
    mode: 'merge' | 'replace' = 'merge',
  ): CtbUser {
    const ts = this.now();
    const existing = this.rowFor(botId, tgUserId);
    if (!existing) {
      const row: UserRow = {
        id: randomUUID(),
        botId,
        tgUserId,
        profile: { ...fields },
        tags: [],
        firstSeen: ts,
        lastSeen: ts,
      };
      this.db.insert(users).values(row).run();
      return rowToUser(row);
    }
    const profile =
      mode === 'replace' ? { ...fields } : { ...(existing.profile as Record<string, unknown>), ...fields };
    this.db.update(users).set({ profile, lastSeen: ts }).where(eq(users.id, existing.id)).run();
    return rowToUser({ ...existing, profile, lastSeen: ts });
  }

  /** Replace the whole profile bag (PATCH from the panel). No-op-creates if unseen. */
  replaceProfile(botId: string, tgUserId: number, profile: Record<string, unknown>): CtbUser {
    return this.setProfile(botId, tgUserId, profile, 'replace');
  }

  private mutateTags(
    botId: string,
    tgUserId: number,
    fn: (tags: string[]) => string[],
  ): CtbUser {
    const ts = this.now();
    const existing = this.rowFor(botId, tgUserId);
    if (!existing) {
      const row: UserRow = {
        id: randomUUID(),
        botId,
        tgUserId,
        profile: {},
        tags: fn([]),
        firstSeen: ts,
        lastSeen: ts,
      };
      this.db.insert(users).values(row).run();
      return rowToUser(row);
    }
    const tags = fn((existing.tags as string[]) ?? []);
    this.db.update(users).set({ tags, lastSeen: ts }).where(eq(users.id, existing.id)).run();
    return rowToUser({ ...existing, tags, lastSeen: ts });
  }

  addTags(botId: string, tgUserId: number, tags: string[]): CtbUser {
    return this.mutateTags(botId, tgUserId, (cur) => [...new Set([...cur, ...tags])]);
  }

  removeTags(botId: string, tgUserId: number, tags: string[]): CtbUser {
    const drop = new Set(tags);
    return this.mutateTags(botId, tgUserId, (cur) => cur.filter((t) => !drop.has(t)));
  }

  /** Set the exact tag list (PATCH from the panel). */
  setTags(botId: string, tgUserId: number, tags: string[]): CtbUser {
    return this.mutateTags(botId, tgUserId, () => [...new Set(tags)]);
  }

  /** List users for a bot, newest-seen first. Each carries its row id. */
  list(botId: string, opts: { limit?: number; offset?: number } = {}): Array<{ id: string; user: CtbUser }> {
    const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
    const offset = Math.max(opts.offset ?? 0, 0);
    const rows = this.db
      .select()
      .from(users)
      .where(eq(users.botId, botId))
      .orderBy(desc(users.lastSeen))
      .limit(limit)
      .offset(offset)
      .all();
    return rows.map((r) => ({ id: r.id, user: rowToUser(r) }));
  }

  /** Row id → record (the API patches by row id, not tg id). */
  getById(id: string): { botId: string; user: CtbUser } | null {
    const row = this.db.select().from(users).where(eq(users.id, id)).get();
    return row ? { botId: row.botId, user: rowToUser(row) } : null;
  }
}
