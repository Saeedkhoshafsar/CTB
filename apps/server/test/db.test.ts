import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { openDb, schema } from '../src/db/index';
import { runMigrations } from '../src/db/migrate';

const EXPECTED_TABLES = [
  'api_tokens', 'bots', 'collections', 'credentials', 'exec_logs', 'executions',
  'files', 'flow_versions', 'flows', 'kv_store', 'pending_triggers', 'records', 'users',
];

function freshDb() {
  const { db, sqlite } = openDb(':memory:');
  runMigrations(db);
  return { db, sqlite };
}

describe('database layer', () => {
  it('migrations create all ARCHITECTURE §4 + §13 tables', () => {
    const { sqlite } = freshDb();
    const tables = (sqlite
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '__drizzle%' ORDER BY name`)
      .all() as { name: string }[]).map((t) => t.name);
    expect(tables).toEqual(EXPECTED_TABLES);
    sqlite.close();
  });

  it('inserts and reads back a bot + flow with JSON graph', () => {
    const { db, sqlite } = freshDb();
    const now = new Date().toISOString();
    db.insert(schema.bots).values({
      id: 'bot_1', name: 'test', tokenEnc: 'enc.payload.x', createdAt: now, updatedAt: now,
    }).run();
    const graph = { nodes: [{ id: 'a', type: 'flow.if', params: {}, position: { x: 0, y: 0 }, disabled: false }], edges: [] };
    db.insert(schema.flows).values({
      id: 'fl_1', botId: 'bot_1', name: 'demo', graph, updatedAt: now,
    }).run();
    const row = db.select().from(schema.flows).where(eq(schema.flows.id, 'fl_1')).get();
    expect(row?.graph).toEqual(graph);
    expect(row?.status).toBe('draft');
    sqlite.close();
  });

  it('enforces foreign keys (flow without bot rejected)', () => {
    const { db, sqlite } = freshDb();
    expect(() =>
      db.insert(schema.flows).values({
        id: 'fl_x', botId: 'ghost', name: 'x', graph: {}, updatedAt: 'now',
      }).run(),
    ).toThrow(/FOREIGN KEY/i);
    sqlite.close();
  });

  it('cascade-deletes executions when bot is deleted', () => {
    const { db, sqlite } = freshDb();
    const now = new Date().toISOString();
    db.insert(schema.bots).values({ id: 'b1', name: 'b', tokenEnc: 'e', createdAt: now, updatedAt: now }).run();
    db.insert(schema.flows).values({ id: 'f1', botId: 'b1', name: 'f', graph: {}, updatedAt: now }).run();
    db.insert(schema.executions).values({
      id: 'ex1', flowId: 'f1', botId: 'b1', chatId: 5, status: 'waiting',
      state: { cursor: 'n1', items: {}, vars: {}, steps: 0 },
      wait: { kind: 'reply', nodeId: 'n1', expect: 'text', retriesLeft: 0, timeoutAt: null },
      startedAt: now, updatedAt: now,
    }).run();
    db.delete(schema.bots).where(eq(schema.bots.id, 'b1')).run();
    expect(db.select().from(schema.executions).all()).toHaveLength(0);
    sqlite.close();
  });

  it('kv_store unique constraint upserts cleanly', () => {
    const { db, sqlite } = freshDb();
    const now = new Date().toISOString();
    db.insert(schema.bots).values({ id: 'b1', name: 'b', tokenEnc: 'e', createdAt: now, updatedAt: now }).run();
    const row = { botId: 'b1', scope: 'user' as const, scopeId: '42', key: 'points', updatedAt: now };
    db.insert(schema.kvStore).values({ ...row, value: 1 }).run();
    db.insert(schema.kvStore).values({ ...row, value: 2 })
      .onConflictDoUpdate({
        target: [schema.kvStore.botId, schema.kvStore.scope, schema.kvStore.scopeId, schema.kvStore.key],
        set: { value: 2, updatedAt: now },
      }).run();
    const all = db.select().from(schema.kvStore).all();
    expect(all).toHaveLength(1);
    expect(all[0]?.value).toBe(2);
    sqlite.close();
  });

  it('stores a waiting execution and round-trips its state JSON intact (I4)', () => {
    const { db, sqlite } = freshDb();
    const now = new Date().toISOString();
    db.insert(schema.bots).values({ id: 'b1', name: 'b', tokenEnc: 'e', createdAt: now, updatedAt: now }).run();
    db.insert(schema.flows).values({ id: 'f1', botId: 'b1', name: 'f', graph: {}, updatedAt: now }).run();
    const state = {
      cursor: 'ask_age',
      items: { main: [{ json: { text: 'علی', nested: { deep: [1, 2, 3] } } }] },
      vars: { name: 'علی' },
      steps: 4,
    };
    db.insert(schema.executions).values({
      id: 'ex1', flowId: 'f1', botId: 'b1', chatId: 99, status: 'waiting',
      state, wait: { kind: 'reply', nodeId: 'ask_age', expect: 'number', retriesLeft: 2, timeoutAt: null },
      startedAt: now, updatedAt: now,
    }).run();
    const row = db.select().from(schema.executions).where(eq(schema.executions.id, 'ex1')).get();
    expect(row?.state).toEqual(state);
    expect((row?.wait as { kind: string }).kind).toBe('reply');
    sqlite.close();
  });
});
