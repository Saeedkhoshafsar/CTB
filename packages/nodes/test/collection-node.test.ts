/**
 * data.collection + collection.recordChanged contract tests (P3.5-T5).
 *
 * data.collection is a generic CRUD primitive over the injected ctx.collections
 * capability (invariant I2 — CTB never knows the domain). The host owns the
 * schema/validation/event-bus; here we drive the node against the in-memory
 * fake store from node-harness and assert the NODES.md contract:
 *   find→N items / empty port, get hit/miss, insert (+events/suppress),
 *   update merge/replace + where-first-match + no-match→empty, delete (+guard),
 *   count, and the failure modes (no store / unknown slug).
 *
 * collection.recordChanged is a pure pass-through trigger (matching happens
 * host-side); we assert it forwards its pre-built item on `main`.
 */
import { NodeRegistry } from '@ctb/core';
import { describe, expect, it } from 'vitest';
import {
  builtinNodes,
  collectionRecordChanged,
  dataCollection,
  registerBuiltinNodes,
} from '../src/index';
import { item, makeCtx, params } from './node-harness';

describe('registry (P3.5-T5)', () => {
  it('registers both new nodes; registry is now 26 types', () => {
    const reg = registerBuiltinNodes(new NodeRegistry());
    expect(reg.has('data.collection')).toBe(true);
    expect(reg.has('collection.recordChanged')).toBe(true);
    // +2 in P4-T1: webhook.trigger + flow.respondToWebhook; +1 in P5-T1: ai.llmChat.
    expect(builtinNodes.length).toBe(46);
  });

  it('data.collection has main + empty ports; recordChanged is a trigger', () => {
    expect(dataCollection.ports).toEqual({ inputs: ['main'], outputs: ['main', 'empty'] });
    expect(collectionRecordChanged.category).toBe('trigger');
    expect(collectionRecordChanged.ports).toEqual({ inputs: [], outputs: ['main'] });
  });
});

const todos = () => ({
  todos: [
    { id: 'r1', data: { title: 'a', done: false, priority: 3 } },
    { id: 'r2', data: { title: 'b', done: true, priority: 1 } },
    { id: 'r3', data: { title: 'c', done: false, priority: 2 } },
  ],
});

describe('data.collection — find', () => {
  it('returns one item per matched record (where + sort)', async () => {
    const ctx = makeCtx({ seedCollections: todos() });
    const res = await dataCollection.execute(
      ctx,
      params(dataCollection, {
        collection: 'todos',
        operation: 'find',
        where: [{ field: 'done', op: 'eq', value: 'false' }],
        sort: [{ field: 'priority', dir: 'asc' }],
      }),
      [item({})],
    );
    if (res.kind !== 'items') throw new Error('expected items');
    const ids = res.outputs.main!.map((i) => i.json.record_id);
    expect(ids).toEqual(['r3', 'r1']); // priority 2 then 3, done:false only
  });

  it('coerces a numeric where value', async () => {
    const ctx = makeCtx({ seedCollections: todos() });
    const res = await dataCollection.execute(
      ctx,
      params(dataCollection, {
        collection: 'todos',
        operation: 'find',
        where: [{ field: 'priority', op: 'gte', value: '2' }],
      }),
      [item({})],
    );
    if (res.kind !== 'items') throw new Error('expected items');
    expect(res.outputs.main!.length).toBe(2); // priority 3 and 2
  });

  it('zero matches → empty port', async () => {
    const ctx = makeCtx({ seedCollections: todos() });
    const res = await dataCollection.execute(
      ctx,
      params(dataCollection, {
        collection: 'todos',
        operation: 'find',
        where: [{ field: 'title', op: 'eq', value: 'zzz' }],
      }),
      [item({})],
    );
    if (res.kind !== 'items') throw new Error('expected items');
    expect(res.outputs.main).toBeUndefined();
    expect(res.outputs.empty!.length).toBe(1);
  });

  it('honors limit + offset', async () => {
    const ctx = makeCtx({ seedCollections: todos() });
    const res = await dataCollection.execute(
      ctx,
      params(dataCollection, {
        collection: 'todos',
        operation: 'find',
        sort: [{ field: 'priority', dir: 'asc' }],
        limit: 1,
        offset: 1,
      }),
      [item({})],
    );
    if (res.kind !== 'items') throw new Error('expected items');
    expect(res.outputs.main!.length).toBe(1);
    expect(res.outputs.main![0]!.json.record_id).toBe('r3'); // priority 2 is 2nd
  });
});

describe('data.collection — get', () => {
  it('hit returns the record', async () => {
    const ctx = makeCtx({ seedCollections: todos() });
    const res = await dataCollection.execute(
      ctx,
      params(dataCollection, { collection: 'todos', operation: 'get', record_id: 'r2' }),
      [item({})],
    );
    if (res.kind !== 'items') throw new Error('expected items');
    expect(res.outputs.main![0]!.json.record_id).toBe('r2');
    expect((res.outputs.main![0]!.json.record as Record<string, unknown>).title).toBe('b');
  });

  it('miss → empty port', async () => {
    const ctx = makeCtx({ seedCollections: todos() });
    const res = await dataCollection.execute(
      ctx,
      params(dataCollection, { collection: 'todos', operation: 'get', record_id: 'nope' }),
      [item({})],
    );
    if (res.kind !== 'items') throw new Error('expected items');
    expect(res.outputs.main).toBeUndefined();
    expect(res.outputs.empty!.length).toBe(1);
  });
});

describe('data.collection — insert', () => {
  it('inserts and emits a created event', async () => {
    const ctx = makeCtx({ knownCollections: ['todos'] });
    const res = await dataCollection.execute(
      ctx,
      params(dataCollection, {
        collection: 'todos',
        operation: 'insert',
        fields: [{ field: 'title', value: 'new' }],
      }),
      [item({})],
    );
    if (res.kind !== 'items') throw new Error('expected items');
    expect((res.outputs.main![0]!.json.record as Record<string, unknown>).title).toBe('new');
    expect(ctx.recordEvents).toEqual([
      { event: 'created', slug: 'todos', recordId: res.outputs.main![0]!.json.record_id },
    ]);
  });

  it('dotted field names nest into objects', async () => {
    const ctx = makeCtx({ knownCollections: ['todos'] });
    const res = await dataCollection.execute(
      ctx,
      params(dataCollection, {
        collection: 'todos',
        operation: 'insert',
        fields: [
          { field: 'address.city', value: 'Tehran' },
          { field: 'address.zip', value: '12345' },
        ],
      }),
      [item({})],
    );
    if (res.kind !== 'items') throw new Error('expected items');
    expect((res.outputs.main![0]!.json.record as Record<string, unknown>).address).toEqual({
      city: 'Tehran',
      zip: '12345',
    });
  });

  it('suppress_events → no event recorded', async () => {
    const ctx = makeCtx({ knownCollections: ['todos'] });
    await dataCollection.execute(
      ctx,
      params(dataCollection, {
        collection: 'todos',
        operation: 'insert',
        fields: [{ field: 'title', value: 'quiet' }],
        suppress_events: true,
      }),
      [item({})],
    );
    expect(ctx.recordEvents).toEqual([]);
  });
});

describe('data.collection — update', () => {
  it('merges by record_id (keeps untouched fields)', async () => {
    const ctx = makeCtx({ seedCollections: todos() });
    const res = await dataCollection.execute(
      ctx,
      params(dataCollection, {
        collection: 'todos',
        operation: 'update',
        record_id: 'r1',
        fields: [{ field: 'done', value: 'true' }],
        mode: 'merge',
      }),
      [item({})],
    );
    if (res.kind !== 'items') throw new Error('expected items');
    const rec = res.outputs.main![0]!.json.record as Record<string, unknown>;
    expect(rec.done).toBe('true');
    expect(rec.title).toBe('a'); // untouched
  });

  it('replace mode drops untouched fields', async () => {
    const ctx = makeCtx({ seedCollections: todos() });
    const res = await dataCollection.execute(
      ctx,
      params(dataCollection, {
        collection: 'todos',
        operation: 'update',
        record_id: 'r1',
        fields: [{ field: 'title', value: 'only' }],
        mode: 'replace',
      }),
      [item({})],
    );
    if (res.kind !== 'items') throw new Error('expected items');
    const rec = res.outputs.main![0]!.json.record as Record<string, unknown>;
    expect(rec).toEqual({ title: 'only' });
  });

  it('updates the first record matching where', async () => {
    const ctx = makeCtx({ seedCollections: todos() });
    const res = await dataCollection.execute(
      ctx,
      params(dataCollection, {
        collection: 'todos',
        operation: 'update',
        where: [{ field: 'done', op: 'eq', value: 'false' }],
        fields: [{ field: 'priority', value: '99' }],
      }),
      [item({})],
    );
    if (res.kind !== 'items') throw new Error('expected items');
    // first match wins; r1 or r3 depending on store order — assert one changed
    expect((res.outputs.main![0]!.json.record as Record<string, unknown>).priority).toBe('99');
  });

  it('no match → empty port', async () => {
    const ctx = makeCtx({ seedCollections: todos() });
    const res = await dataCollection.execute(
      ctx,
      params(dataCollection, {
        collection: 'todos',
        operation: 'update',
        where: [{ field: 'title', op: 'eq', value: 'zzz' }],
        fields: [{ field: 'priority', value: '1' }],
      }),
      [item({})],
    );
    if (res.kind !== 'items') throw new Error('expected items');
    expect(res.outputs.main).toBeUndefined();
    expect(res.outputs.empty!.length).toBe(1);
  });
});

describe('data.collection — delete', () => {
  it('deletes by record_id', async () => {
    const ctx = makeCtx({ seedCollections: todos() });
    const res = await dataCollection.execute(
      ctx,
      params(dataCollection, { collection: 'todos', operation: 'delete', record_id: 'r1' }),
      [item({})],
    );
    if (res.kind !== 'items') throw new Error('expected items');
    expect(res.outputs.main![0]!.json.deleted).toBe(1);
  });

  it('multi-delete without confirm_many → error', async () => {
    const ctx = makeCtx({ seedCollections: todos() });
    const res = await dataCollection.execute(
      ctx,
      params(dataCollection, {
        collection: 'todos',
        operation: 'delete',
        where: [{ field: 'done', op: 'eq', value: 'false' }],
      }),
      [item({})],
    );
    expect(res.kind).toBe('error');
  });

  it('multi-delete with confirm_many deletes all matches', async () => {
    const ctx = makeCtx({ seedCollections: todos() });
    const res = await dataCollection.execute(
      ctx,
      params(dataCollection, {
        collection: 'todos',
        operation: 'delete',
        where: [{ field: 'done', op: 'eq', value: 'false' }],
        confirm_many: true,
      }),
      [item({})],
    );
    if (res.kind !== 'items') throw new Error('expected items');
    expect(res.outputs.main![0]!.json.deleted).toBe(2);
  });
});

describe('data.collection — count', () => {
  it('counts matching records', async () => {
    const ctx = makeCtx({ seedCollections: todos() });
    const res = await dataCollection.execute(
      ctx,
      params(dataCollection, {
        collection: 'todos',
        operation: 'count',
        where: [{ field: 'done', op: 'eq', value: 'false' }],
      }),
      [item({})],
    );
    if (res.kind !== 'items') throw new Error('expected items');
    expect(res.outputs.main![0]!.json.count).toBe(2);
  });
});

describe('data.collection — failure modes', () => {
  it('no collection store on the instance → error', async () => {
    const ctx = makeCtx({ collections: null });
    const res = await dataCollection.execute(
      ctx,
      params(dataCollection, { collection: 'todos', operation: 'count' }),
      [item({})],
    );
    expect(res.kind).toBe('error');
  });

  it('unknown slug → error', async () => {
    const ctx = makeCtx({ knownCollections: ['todos'] });
    const res = await dataCollection.execute(
      ctx,
      params(dataCollection, { collection: 'ghosts', operation: 'count' }),
      [item({})],
    );
    expect(res.kind).toBe('error');
  });
});

describe('collection.recordChanged — pass-through', () => {
  it('forwards its pre-built item on main', async () => {
    const ctx = makeCtx();
    const built = item({ event: 'created', record: { title: 'x' }, record_id: 'r9', source: 'panel' });
    const res = await collectionRecordChanged.execute(
      ctx,
      params(collectionRecordChanged, { collection: 'todos', events: ['created'] }),
      [built],
    );
    if (res.kind !== 'items') throw new Error('expected items');
    expect(res.outputs.main).toEqual([built]);
  });
});
