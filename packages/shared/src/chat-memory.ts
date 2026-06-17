/**
 * Chat-memory runtime (PB-T4) — the shared contract + logic behind the two
 * `ai:memory` provider nodes (`ai.memoryKv`, `ai.memoryPostgres`).
 *
 * A memory PROVIDER node is never run as a data step (PB-T1 — the executor
 * skips `role:'provider'` nodes). Instead a CONSUMER (the future `ai.agent`,
 * PB-T5) resolves the attached provider's params into a `ChatMemoryConfig` and
 * calls this module to:
 *   1. `loadChatHistory()` — replay the rolling last-N turns before a model call;
 *   2. `appendChatTurn()`  — persist the new user+assistant pair after it.
 *
 * Both backings honor invariants I3/I6/I7: this module touches the world ONLY
 * through the injected capabilities (`ctx.kv` for KV, `ctx.db` for Postgres) —
 * it never imports a database driver and never sees a decrypted secret (the
 * host resolves `credentialId` → pool). Values reaching SQL are ALWAYS bound as
 * `$1,$2,…` parameters, never string-concatenated; the only interpolated text
 * is the table identifier, which the caller has validated against
 * `AiMemoryPostgresParamsSchema`'s identifier regex and which we quote here.
 */
import type { AiChatMessage, DbQueryRequest, DbQueryResult } from './node-def';

/** A single stored turn message — the subset of AiChatMessage memory persists. */
export interface ChatMemoryMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

/**
 * The resolved configuration a consumer derives from an attached `ai:memory`
 * provider node. A discriminated union over the backing so the runtime picks
 * the right loader/append path.
 */
export type ChatMemoryConfig =
  | {
      kind: 'kv';
      /** Already-resolved session key (consumer expands the expression + falls back to the per-chat default). */
      sessionKey: string;
      /** Prior turns to replay / retain. */
      window: number;
    }
  | {
      kind: 'postgres';
      /** Stored `postgres` credential id; the host resolves it to a pool. */
      credentialId: string;
      /** Validated, already-safe SQL table identifier (schema.table allowed). */
      table: string;
      /** Already-resolved session key. */
      sessionKey: string;
      /** Prior turns to replay / retain. */
      window: number;
      /** Issue CREATE TABLE IF NOT EXISTS before first use. */
      autoCreate: boolean;
    };

/** The minimal KV surface this runtime needs (a slice of NodeCtx.kv). */
export interface ChatMemoryKv {
  get(scope: 'user' | 'bot' | 'flow', key: string): Promise<unknown>;
  set(scope: 'user' | 'bot' | 'flow', key: string, value: unknown): Promise<void>;
}

/** The minimal DB surface this runtime needs (a slice of NodeCtx.db). */
export interface ChatMemoryDb {
  query(req: DbQueryRequest): Promise<DbQueryResult>;
}

/** The KV key the kv-backed provider stores its window under (scope `user`). */
export function kvMemoryKey(sessionKey: string): string {
  return `__ai_mem__:${sessionKey}`;
}

/**
 * Validate a Postgres identifier the same way the db.postgres node does, then
 * double-quote each dot-segment. Throws loudly on a hostile identifier so a
 * bad table name can never reach SQL unquoted.
 */
export function quotePgIdent(ident: string): string {
  const seg = /^[A-Za-z_][A-Za-z0-9_]*$/;
  return ident
    .split('.')
    .map((part) => {
      if (!seg.test(part)) throw new Error(`unsafe SQL identifier: ${ident}`);
      return `"${part}"`;
    })
    .join('.');
}

/** Keep only well-formed memory messages (a hand-edited row must never crash). */
function sanitizeMessages(raw: unknown): ChatMemoryMessage[] {
  if (!Array.isArray(raw)) return [];
  const out: ChatMemoryMessage[] = [];
  for (const m of raw) {
    if (
      m &&
      typeof m === 'object' &&
      'role' in m &&
      'content' in m &&
      (m.role === 'user' || m.role === 'assistant' || m.role === 'system') &&
      typeof (m as { content: unknown }).content === 'string'
    ) {
      out.push({ role: m.role, content: (m as { content: string }).content });
    }
  }
  return out;
}

/** Coerce a stored row's role to a valid memory role (defensive). */
function coerceRole(value: unknown): ChatMemoryMessage['role'] {
  return value === 'assistant' || value === 'system' ? value : 'user';
}

/**
 * Load the rolling chat history for a session, newest-last, trimmed to the
 * config's window (window×2 messages). Defensive: a missing/corrupt store
 * yields an empty history rather than throwing.
 */
export async function loadChatHistory(
  cfg: ChatMemoryConfig,
  caps: { kv: ChatMemoryKv | null; db: ChatMemoryDb | null },
): Promise<ChatMemoryMessage[]> {
  if (cfg.kind === 'kv') {
    if (!caps.kv) throw new Error('ai.memoryKv: KV store is not available in this context');
    const raw = await caps.kv.get('user', kvMemoryKey(cfg.sessionKey));
    return sanitizeMessages(raw).slice(-cfg.window * 2);
  }
  // postgres
  if (!caps.db) throw new Error('ai.memoryPostgres: database is not available in this context');
  const table = quotePgIdent(cfg.table);
  if (cfg.autoCreate) await ensurePgTable(caps.db, cfg.credentialId, table);
  // Read the most-recent window×2 messages for this session, oldest-first.
  const res = await caps.db.query({
    credentialId: cfg.credentialId,
    dialect: 'postgres',
    sql: `SELECT role, content FROM (SELECT id, role, content FROM ${table} WHERE session_key = $1 ORDER BY id DESC LIMIT $2) sub ORDER BY id ASC`,
    params: [cfg.sessionKey, cfg.window * 2],
  });
  return res.rows.map((r) => ({ role: coerceRole(r.role), content: String(r.content ?? '') }));
}

/**
 * Persist one turn pair (the user message + the assistant reply) for a session.
 * KV stores the trimmed rolling window as a single JSON value (exactly like the
 * old ai.llmChat); Postgres appends two rows (the table grows; the window only
 * bounds what `loadChatHistory` replays — callers may prune separately).
 */
export async function appendChatTurn(
  cfg: ChatMemoryConfig,
  caps: { kv: ChatMemoryKv | null; db: ChatMemoryDb | null },
  turn: { user: string; assistant: string },
): Promise<void> {
  const pair: ChatMemoryMessage[] = [
    { role: 'user', content: turn.user },
    { role: 'assistant', content: turn.assistant },
  ];
  if (cfg.kind === 'kv') {
    if (!caps.kv) throw new Error('ai.memoryKv: KV store is not available in this context');
    const key = kvMemoryKey(cfg.sessionKey);
    const existing = sanitizeMessages(await caps.kv.get('user', key));
    const next = [...existing, ...pair].slice(-cfg.window * 2);
    await caps.kv.set('user', key, next);
    return;
  }
  // postgres
  if (!caps.db) throw new Error('ai.memoryPostgres: database is not available in this context');
  const table = quotePgIdent(cfg.table);
  if (cfg.autoCreate) await ensurePgTable(caps.db, cfg.credentialId, table);
  await caps.db.query({
    credentialId: cfg.credentialId,
    dialect: 'postgres',
    sql: `INSERT INTO ${table} (session_key, role, content) VALUES ($1, $2, $3), ($1, $4, $5)`,
    params: [cfg.sessionKey, 'user', turn.user, 'assistant', turn.assistant],
  });
}

/** Create the chat-memory table on demand (idempotent). Identifier pre-quoted. */
async function ensurePgTable(db: ChatMemoryDb, credentialId: string, quotedTable: string): Promise<void> {
  await db.query({
    credentialId,
    dialect: 'postgres',
    sql: `CREATE TABLE IF NOT EXISTS ${quotedTable} (id BIGSERIAL PRIMARY KEY, session_key TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
    params: [],
  });
}

/** Convert stored memory messages to the AiChatMessage shape a model call wants. */
export function toAiMessages(msgs: ChatMemoryMessage[]): AiChatMessage[] {
  return msgs.map((m) => ({ role: m.role, content: m.content }));
}
