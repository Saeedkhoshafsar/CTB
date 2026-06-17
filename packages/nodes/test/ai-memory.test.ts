/**
 * PB-T4 — chat-memory providers (`ai.memoryKv`, `ai.memoryPostgres`) + the
 * shared chat-memory runtime they contract for.
 *
 * Two surfaces are under test:
 *  1. The PROVIDER nodes themselves — they register as `role:'provider'`,
 *     `provides:'ai:memory'`, take no data input, and fail loudly if ever run
 *     as a data step (a provider is resolved as config, never executed).
 *  2. The shared runtime (`loadChatHistory`/`appendChatTurn`) the future agent
 *     drives once it resolves an attached provider's params into a
 *     `ChatMemoryConfig` — verified over the harness's in-memory `ctx.kv` and a
 *     recording `ctx.db`.
 */
import { describe, expect, it } from 'vitest';
import { builtinNodes } from '../src/index';
import { aiMemoryKv } from '../src/ai/memory-kv';
import { aiMemoryPostgres } from '../src/ai/memory-postgres';
import {
  AiMemoryKvParamsSchema,
  AiMemoryPostgresParamsSchema,
  appendChatTurn,
  kvMemoryKey,
  loadChatHistory,
  quotePgIdent,
  toAiMessages,
  type ChatMemoryConfig,
  type DbQueryRequest,
  type DbQueryResult,
} from '@ctb/shared';
import { makeCtx } from './node-harness';

describe('ai memory providers — registration & contract (PB-T4)', () => {
  it('registers both memory providers; registry is 46 types', () => {
    const types = builtinNodes.map((n) => n.type);
    expect(types).toContain('ai.memoryKv');
    expect(types).toContain('ai.memoryPostgres');
    expect(builtinNodes.length).toBe(46);
  });

  it('both are ai:memory providers with no data input', () => {
    for (const node of [aiMemoryKv, aiMemoryPostgres]) {
      expect(node.role).toBe('provider');
      expect(node.provides).toBe('ai:memory');
      expect(node.ports.inputs).toEqual([]);
      expect(node.ports.outputs).toEqual(['provider']);
      expect(node.category).toBe('ai');
    }
  });

  it('fails loudly if a provider is ever executed as a data step', async () => {
    const ctx = makeCtx({});
    const r1 = await aiMemoryKv.execute(ctx, AiMemoryKvParamsSchema.parse({}), []);
    const r2 = await aiMemoryPostgres.execute(
      ctx,
      AiMemoryPostgresParamsSchema.parse({ credentialId: 'pg1' }),
      [],
    );
    expect(r1.kind).toBe('error');
    expect(r2.kind).toBe('error');
  });

  it('kv params default a 10-turn window and a blank session key', () => {
    const p = AiMemoryKvParamsSchema.parse({});
    expect(p.memory_window).toBe(10);
    expect(p.session_key).toBe('');
  });

  it('postgres params default table/window/auto_create and require a credential', () => {
    const p = AiMemoryPostgresParamsSchema.parse({ credentialId: 'pg1' });
    expect(p.table).toBe('ctb_chat_memory');
    expect(p.memory_window).toBe(10);
    expect(p.auto_create).toBe(true);
    expect(() => AiMemoryPostgresParamsSchema.parse({})).toThrow();
  });

  it('postgres rejects a hostile table identifier in the schema', () => {
    expect(() => AiMemoryPostgresParamsSchema.parse({ credentialId: 'pg1', table: 'x; DROP TABLE y' })).toThrow();
    expect(() => AiMemoryPostgresParamsSchema.parse({ credentialId: 'pg1', table: 'app.turns' })).not.toThrow();
  });
});

describe('chat-memory runtime — KV backing (PB-T4)', () => {
  const cfg: ChatMemoryConfig = { kind: 'kv', sessionKey: 'chat-42', window: 2 };

  it('returns an empty history for a fresh session', async () => {
    const ctx = makeCtx({});
    const h = await loadChatHistory(cfg, { kv: ctx.kv, db: ctx.db });
    expect(h).toEqual([]);
  });

  it('appends a turn pair and replays it newest-last', async () => {
    const ctx = makeCtx({});
    await appendChatTurn(cfg, { kv: ctx.kv, db: ctx.db }, { user: 'hi', assistant: 'hello' });
    const h = await loadChatHistory(cfg, { kv: ctx.kv, db: ctx.db });
    expect(h).toEqual([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ]);
    // stored under the namespaced key, scope=user
    expect(ctx.kvBag.get(`user:${kvMemoryKey('chat-42')}`)).toHaveLength(2);
  });

  it('trims to the rolling window×2 messages', async () => {
    const ctx = makeCtx({});
    const caps = { kv: ctx.kv, db: ctx.db };
    await appendChatTurn(cfg, caps, { user: 'u1', assistant: 'a1' });
    await appendChatTurn(cfg, caps, { user: 'u2', assistant: 'a2' });
    await appendChatTurn(cfg, caps, { user: 'u3', assistant: 'a3' });
    const h = await loadChatHistory(cfg, caps);
    // window=2 → last 2 turns (4 messages); the first turn dropped
    expect(h.map((m) => m.content)).toEqual(['u2', 'a2', 'u3', 'a3']);
  });

  it('ignores a corrupt stored value instead of throwing', async () => {
    const ctx = makeCtx({});
    ctx.kvBag.set(`user:${kvMemoryKey('chat-42')}`, { not: 'an array' });
    const h = await loadChatHistory(cfg, { kv: ctx.kv, db: ctx.db });
    expect(h).toEqual([]);
  });

  it('throws loudly when KV is unavailable', async () => {
    const ctx = makeCtx({});
    await expect(loadChatHistory(cfg, { kv: null, db: ctx.db })).rejects.toThrow(/KV store is not available/);
  });
});

describe('chat-memory runtime — Postgres backing (PB-T4)', () => {
  function pgCfg(over: Partial<Extract<ChatMemoryConfig, { kind: 'postgres' }>> = {}): ChatMemoryConfig {
    return {
      kind: 'postgres',
      credentialId: 'pg1',
      table: 'ctb_chat_memory',
      sessionKey: 'chat-42',
      window: 5,
      autoCreate: true,
      ...over,
    };
  }

  it('auto-creates the table then SELECTs the window, bound by $1/$2', async () => {
    const ctx = makeCtx({ db: { result: { rows: [], rowCount: 0 } } });
    await loadChatHistory(pgCfg(), { kv: ctx.kv, db: ctx.db });
    // 1st call = CREATE TABLE IF NOT EXISTS, 2nd = the windowed SELECT
    expect(ctx.dbCalls).toHaveLength(2);
    expect(ctx.dbCalls[0]!.sql).toMatch(/CREATE TABLE IF NOT EXISTS "ctb_chat_memory"/);
    const sel = ctx.dbCalls[1]!;
    expect(sel.dialect).toBe('postgres');
    expect(sel.sql).toMatch(/SELECT role, content FROM \(SELECT id, role, content FROM "ctb_chat_memory" WHERE session_key = \$1 ORDER BY id DESC LIMIT \$2\)/);
    expect(sel.params).toEqual(['chat-42', 10]); // window×2
  });

  it('maps rows oldest-first into history', async () => {
    const rows = [
      { role: 'user', content: 'q1' },
      { role: 'assistant', content: 'r1' },
    ];
    const ctx = makeCtx({
      db: {
        result: (req: DbQueryRequest): DbQueryResult =>
          req.sql.startsWith('SELECT') ? { rows, rowCount: rows.length } : { rows: [], rowCount: 0 },
      },
    });
    const h = await loadChatHistory(pgCfg({ autoCreate: false }), { kv: ctx.kv, db: ctx.db });
    expect(h).toEqual(rows);
    // autoCreate:false → no CREATE TABLE, just the SELECT
    expect(ctx.dbCalls).toHaveLength(1);
    expect(ctx.dbCalls[0]!.sql).toMatch(/^SELECT/);
  });

  it('appends a turn as two bound rows in one INSERT, values never concatenated', async () => {
    const ctx = makeCtx({ db: { result: { rows: [], rowCount: 0 } } });
    await appendChatTurn(
      pgCfg({ autoCreate: false }),
      { kv: ctx.kv, db: ctx.db },
      { user: "'; DROP TABLE users; --", assistant: 'ok' },
    );
    expect(ctx.dbCalls).toHaveLength(1);
    const ins = ctx.dbCalls[0]!;
    expect(ins.sql).toMatch(/INSERT INTO "ctb_chat_memory" \(session_key, role, content\) VALUES \(\$1, \$2, \$3\), \(\$1, \$4, \$5\)/);
    // the hostile value stays a single bound parameter — it is NOT in the SQL text
    expect(ins.sql).not.toContain('DROP TABLE');
    expect(ins.params).toEqual(['chat-42', 'user', "'; DROP TABLE users; --", 'assistant', 'ok']);
  });

  it('quotes a schema.table identifier and rejects a hostile one', () => {
    expect(quotePgIdent('app.turns')).toBe('"app"."turns"');
    expect(() => quotePgIdent('x; DROP TABLE y')).toThrow(/unsafe SQL identifier/);
  });

  it('throws loudly when the database is unavailable', async () => {
    const ctx = makeCtx({});
    await expect(loadChatHistory(pgCfg(), { kv: ctx.kv, db: null })).rejects.toThrow(/database is not available/);
  });

  it('toAiMessages maps stored messages to the chat-completions shape', () => {
    expect(toAiMessages([{ role: 'user', content: 'x' }])).toEqual([{ role: 'user', content: 'x' }]);
  });
});
