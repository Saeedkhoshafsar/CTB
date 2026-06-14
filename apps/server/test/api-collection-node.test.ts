/**
 * P3.5-T5 — `collection.recordChanged` trigger + record-write event bus (e2e).
 *
 * The node-level contract (find/insert/update/... output shapes, validation,
 * loop guard at the capability level) lives in packages/nodes/test/collection-
 * node.test.ts. This file exercises the HOST side that only exists in the
 * server — the bus that turns a real record write into a started flow:
 *
 *   • a PANEL write (POST /api/records/:id) fires a matching active flow's
 *     `collection.recordChanged` trigger → a new execution row appears
 *   • a flow's OWN data.collection write does NOT re-trigger that same flow
 *     (depth-1 loop guard) but DOES trigger a different watching flow
 *   • `field_filter` (updates) and `condition` are honored
 *
 * Unlike api-collections-records.test.ts, makeWorld() here MUST pass `sqlite`
 * to wireEngine — that is what wires the SqliteCollectionStore + RecordEventBus
 * (and the data.collection capability), so a write actually reaches the bus.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { SESSION_COOKIE, buildApp } from '../src/app';
import { openDb, type Db } from '../src/db/index';
import { bots as botsTable, executions, flows as flowsTable } from '../src/db/schema';
import { runMigrations } from '../src/db/migrate';
import { wireEngine, type Engine } from '../src/engine/wire';
import { loadEnv } from '../src/lib/env';
import type { FlowGraph } from '@ctb/shared';

const SECRET = 'devsecret0123456';
const BOT = 'bot1';

interface World {
  app: FastifyInstance;
  db: Db;
  engine: Engine;
  adminCookie: Record<string, string>;
}

async function login(app: FastifyInstance, username: string, password: string): Promise<Record<string, string>> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password } });
  expect(res.statusCode).toBe(200);
  return { [SESSION_COOKIE]: res.cookies.find((c) => c.name === SESSION_COOKIE)!.value };
}

async function makeWorld(): Promise<World> {
  const dataDir = mkdtempSync(join(tmpdir(), 'ctb-colnode-'));
  const env = loadEnv({
    CTB_SECRET: SECRET,
    CTB_ADMIN_PASS: 'hunter2hunter2',
    CTB_OPERATOR_PASS: 'managerpass99',
    CTB_DATA_DIR: dataDir,
    NODE_ENV: 'test',
  } as NodeJS.ProcessEnv);
  const { db, sqlite } = openDb(':memory:');
  runMigrations(db);
  const now = new Date().toISOString();
  db.insert(botsTable).values({ id: BOT, name: 'b', tokenEnc: 'enc.x.y', createdAt: now, updatedAt: now }).run();
  // CRITICAL (vs api-collections-records.test.ts): pass `sqlite` so the engine
  // builds the collection store + record-event bus + data.collection capability.
  const engine = wireEngine({ db, sqlite, ctbSecret: SECRET });
  const app = buildApp({ env, db, sqlite, engine, logger: false, editorDistDir: '/nonexistent' });
  const adminCookie = await login(app, 'admin', 'hunter2hunter2');
  return { app, db, engine, adminCookie };
}

const todosSchema = {
  fields: [
    { key: 'title', type: 'text', required: true, indexed: true },
    { key: 'done', type: 'boolean', indexed: true, default: false },
    { key: 'priority', type: 'number', indexed: true, default: 0 },
  ],
};

async function defineTodos(w: World): Promise<string> {
  const res = await w.app.inject({
    method: 'POST',
    url: `/api/collections?botId=${BOT}`,
    cookies: w.adminCookie,
    payload: { slug: 'todos', name: 'Todos', schema: todosSchema },
  });
  expect(res.statusCode).toBe(201);
  return res.json().collection.id as string;
}

/** Insert an ACTIVE flow row directly (no flows API churn). Returns flow id. */
function insertActiveFlow(db: Db, id: string, name: string, graph: FlowGraph): void {
  const now = new Date().toISOString();
  db.insert(flowsTable)
    .values({ id, botId: BOT, name, status: 'active', graph, settings: {}, version: 1, updatedAt: now })
    .run();
}

/** A trigger-only flow that watches `todos` — runs to `done` the instant it fires. */
function watcherGraph(
  trigger: { events?: string[]; field_filter?: string[]; condition?: string } = {},
): FlowGraph {
  return {
    nodes: [
      {
        id: 't1',
        type: 'collection.recordChanged',
        params: {
          collection: 'todos',
          events: trigger.events ?? ['created'],
          field_filter: trigger.field_filter ?? [],
          ...(trigger.condition !== undefined ? { condition: trigger.condition } : {}),
        },
        position: { x: 0, y: 0 },
        disabled: false,
      },
    ],
    edges: [],
  } as unknown as FlowGraph;
}

/** Count executions for a flow (the proof a flow actually started). */
function execCount(db: Db, flowId: string): number {
  return db.select().from(executions).where(eq(executions.flowId, flowId)).all().length;
}

/** POST a record via the panel/records API (provenance 'panel'). */
async function createRecord(w: World, collectionId: string, data: Record<string, unknown>): Promise<string> {
  const res = await w.app.inject({
    method: 'POST',
    url: `/api/records/${collectionId}`,
    cookies: w.adminCookie,
    payload: { data },
  });
  expect(res.statusCode, res.payload).toBe(201);
  return res.json().record.id as string;
}

describe('recordChanged bus — panel write fires the trigger (P3.5-T5)', () => {
  let w: World;
  beforeEach(async () => { w = await makeWorld(); });
  afterEach(async () => { await w.engine.gateway.stopAll(); await w.app.close(); });

  it('a panel insert starts the watching flow', async () => {
    const colId = await defineTodos(w);
    insertActiveFlow(w.db, 'fWatch', 'watch creates', watcherGraph({ events: ['created'] }));

    expect(execCount(w.db, 'fWatch')).toBe(0);
    await createRecord(w, colId, { title: 'buy milk' });
    expect(execCount(w.db, 'fWatch')).toBe(1);
  });

  it('a draft (inactive) flow is NOT fired', async () => {
    const colId = await defineTodos(w);
    const now = new Date().toISOString();
    w.db
      .insert(flowsTable)
      .values({ id: 'fDraft', botId: BOT, name: 'draft', status: 'draft', graph: watcherGraph(), settings: {}, version: 1, updatedAt: now })
      .run();
    await createRecord(w, colId, { title: 'x' });
    expect(execCount(w.db, 'fDraft')).toBe(0);
  });

  it('a flow watching a DIFFERENT event kind is not fired by create', async () => {
    const colId = await defineTodos(w);
    insertActiveFlow(w.db, 'fUpd', 'watch updates only', watcherGraph({ events: ['updated'] }));
    await createRecord(w, colId, { title: 'x' });
    expect(execCount(w.db, 'fUpd')).toBe(0);
  });

  it('update fires an updated-watcher; field_filter gates which updates fire', async () => {
    const colId = await defineTodos(w);
    insertActiveFlow(w.db, 'fDone', 'watch done changes', watcherGraph({ events: ['updated'], field_filter: ['done'] }));
    const id = await createRecord(w, colId, { title: 't', done: false, priority: 1 });
    expect(execCount(w.db, 'fDone')).toBe(0);

    // change only `priority` — `done` did not change → filter blocks it
    const r1 = await w.app.inject({
      method: 'PATCH',
      url: `/api/records/${colId}/${id}`,
      cookies: w.adminCookie,
      payload: { data: { priority: 5 } },
    });
    expect(r1.statusCode).toBe(200);
    expect(execCount(w.db, 'fDone')).toBe(0);

    // now change `done` → filter passes → flow fires
    const r2 = await w.app.inject({
      method: 'PATCH',
      url: `/api/records/${colId}/${id}`,
      cookies: w.adminCookie,
      payload: { data: { done: true } },
    });
    expect(r2.statusCode).toBe(200);
    expect(execCount(w.db, 'fDone')).toBe(1);
  });

  it('condition expression gates whether the flow fires', async () => {
    const colId = await defineTodos(w);
    insertActiveFlow(
      w.db,
      'fHigh',
      'watch high priority',
      watcherGraph({ events: ['created'], condition: '{{ $json.record.priority >= 5 }}' }),
    );

    await createRecord(w, colId, { title: 'low', priority: 1 });
    expect(execCount(w.db, 'fHigh')).toBe(0); // condition false → no fire

    await createRecord(w, colId, { title: 'high', priority: 9 });
    expect(execCount(w.db, 'fHigh')).toBe(1); // condition true → fires
  });

  it('a delete fires a deleted-watcher', async () => {
    const colId = await defineTodos(w);
    insertActiveFlow(w.db, 'fDel', 'watch deletes', watcherGraph({ events: ['deleted'] }));
    const id = await createRecord(w, colId, { title: 'gone soon' });
    expect(execCount(w.db, 'fDel')).toBe(0);
    const res = await w.app.inject({ method: 'DELETE', url: `/api/records/${colId}/${id}`, cookies: w.adminCookie });
    expect(res.statusCode).toBe(200);
    expect(execCount(w.db, 'fDel')).toBe(1);
  });
});

describe('recordChanged bus — loop guard (depth 1, P3.5-T5)', () => {
  let w: World;
  beforeEach(async () => { w = await makeWorld(); });
  afterEach(async () => { await w.engine.gateway.stopAll(); await w.app.close(); });

  /** trigger → data.collection insert into the SAME `todos` collection. */
  function selfWritingGraph(): FlowGraph {
    return {
      nodes: [
        {
          id: 't1',
          type: 'collection.recordChanged',
          params: { collection: 'todos', events: ['created'], field_filter: [] },
          position: { x: 0, y: 0 },
          disabled: false,
        },
        {
          id: 'ins',
          type: 'data.collection',
          params: {
            collection: 'todos',
            operation: 'insert',
            // a child record so we can tell flow-writes apart from panel-writes
            fields: [{ field: 'title', value: 'child' }, { field: 'priority', value: '0' }],
          },
          position: { x: 200, y: 0 },
          disabled: false,
        },
      ],
      edges: [{ id: 'e1', from: { node: 't1', port: 'main' }, to: { node: 'ins', port: 'main' } }],
    } as unknown as FlowGraph;
  }

  it("a flow's own data.collection write does NOT re-trigger that same flow", async () => {
    const colId = await defineTodos(w);
    insertActiveFlow(w.db, 'fSelf', 'self writer', selfWritingGraph());

    // One panel write kicks the flow off once. The flow then inserts a `child`
    // record; the loop guard must stop that write from re-entering fSelf — so
    // exactly ONE execution exists (no runaway loop), and TWO todos exist
    // (the panel's + the one child the single run inserted).
    await createRecord(w, colId, { title: 'root' });
    expect(execCount(w.db, 'fSelf')).toBe(1);

    const countRes = await w.app.inject({ method: 'GET', url: `/api/records/${colId}/count`, cookies: w.adminCookie });
    expect(countRes.json().count).toBe(2);
  });

  it("a flow's write DOES trigger a DIFFERENT watching flow", async () => {
    const colId = await defineTodos(w);
    insertActiveFlow(w.db, 'fSelf', 'self writer', selfWritingGraph());
    insertActiveFlow(w.db, 'fOther', 'other watcher', watcherGraph({ events: ['created'] }));

    // Panel write → fSelf runs once (panel) + fOther runs once (panel).
    // fSelf then inserts `child` → loop guard skips fSelf, but fOther (a
    // different flow) IS triggered by that flow-originated write.
    await createRecord(w, colId, { title: 'root' });

    expect(execCount(w.db, 'fSelf')).toBe(1); // own write guarded
    expect(execCount(w.db, 'fOther')).toBe(2); // panel write + fSelf's child write
  });
});
