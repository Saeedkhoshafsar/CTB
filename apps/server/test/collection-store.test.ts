/**
 * P3.5-T1 — SqliteCollectionStore round-trip tests against the real Drizzle/
 * SQLite tables. Covers every acceptance criterion of the task:
 *   • define schema with group+relation → insert/validate/find with where+sort+limit
 *   • invalid write rejected with field-level errors
 *   • an `indexed` field actually creates a real SQLite expression index
 *   • schema field-add then read an OLD record → defaults applied (lazy migrate)
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { RecordValidationError, type CollectionSchemaDoc } from '@ctb/shared';
import { openDb } from '../src/db/index';
import { runMigrations } from '../src/db/migrate';
import { schema as tables } from '../src/db/index';
import {
  MultiDeleteGuardError,
  SqliteCollectionStore,
} from '../src/collections/store';

const BOT = 'bot1';

function freshStore() {
  const { db, sqlite } = openDb(':memory:');
  runMigrations(db);
  const now = new Date().toISOString();
  db.insert(tables.bots).values({ id: BOT, name: 'b', tokenEnc: 'enc.x.y', createdAt: now, updatedAt: now }).run();
  let tick = 0;
  const store = new SqliteCollectionStore(db, sqlite, () => new Date(1750000000000 + tick++ * 1000));
  return { store, sqlite };
}

const productsSchema: CollectionSchemaDoc = {
  fields: [
    { key: 'title', type: 'text', required: true, indexed: true },
    { key: 'price', type: 'number', indexed: true },
    { key: 'status', type: 'select', options: [{ value: 'draft' }, { value: 'published' }], default: 'draft' },
    { key: 'shipping', type: 'relation', relation: { collection: 'shipping_methods', kind: 'one' } },
    {
      key: 'variants',
      type: 'group',
      fields: [
        { key: 'color', type: 'select', options: [{ value: 'red' }, { value: 'blue' }] },
        { key: 'stock', type: 'number', default: 0 },
      ],
    },
  ],
};

describe('SqliteCollectionStore — definitions', () => {
  let store: SqliteCollectionStore;
  beforeEach(() => {
    ({ store } = freshStore());
  });

  it('defines and lists a collection', () => {
    const col = store.define(BOT, { slug: 'products', name: 'Products', schema: productsSchema });
    expect(col.slug).toBe('products');
    expect(store.list(BOT)).toHaveLength(1);
    expect(store.getBySlug(BOT, 'products')?.id).toBe(col.id);
  });

  it('rejects a duplicate slug', () => {
    store.define(BOT, { slug: 'products', name: 'P', schema: productsSchema });
    expect(() => store.define(BOT, { slug: 'products', name: 'P2', schema: productsSchema })).toThrow();
  });
});

describe('SqliteCollectionStore — computed indexes', () => {
  it('creates a real SQLite expression index for each indexed field', () => {
    const { store, sqlite } = freshStore();
    const col = store.define(BOT, { slug: 'products', name: 'P', schema: productsSchema });
    const names = store.indexNamesFor(col.id);
    expect(names).toHaveLength(2); // title + price

    // The index truly exists in sqlite_master and references json_extract.
    const row = sqlite
      .prepare(`SELECT sql FROM sqlite_master WHERE type='index' AND name = ?`)
      .get(names[0]) as { sql: string };
    expect(row.sql).toContain('json_extract');
  });

  it('re-syncs indexes when the schema changes', () => {
    const { store } = freshStore();
    const col = store.define(BOT, { slug: 'products', name: 'P', schema: productsSchema });
    expect(store.indexNamesFor(col.id)).toHaveLength(2);
    // Remove the `price` index flag.
    const next: CollectionSchemaDoc = {
      fields: productsSchema.fields.map((f) => (f.key === 'price' ? { ...f, indexed: false } : f)),
    };
    store.updateDefinition(col.id, { schema: next });
    expect(store.indexNamesFor(col.id)).toHaveLength(1);
  });

  it('drops indexes when the collection is deleted', () => {
    const { store } = freshStore();
    const col = store.define(BOT, { slug: 'products', name: 'P', schema: productsSchema });
    store.deleteDefinition(col.id);
    expect(store.indexNamesFor(col.id)).toHaveLength(0);
  });
});

describe('SqliteCollectionStore — records insert/validate/find', () => {
  let store: SqliteCollectionStore;
  let colId: string;
  beforeEach(() => {
    ({ store } = freshStore());
    colId = store.define(BOT, { slug: 'products', name: 'P', schema: productsSchema }).id;
  });

  it('inserts with coercion + defaults, then reads back', () => {
    const rec = store.insert(colId, {
      title: 'Mug',
      price: '12', // coerced to number
      variants: [{ color: 'red', stock: '3' }],
    });
    expect(rec.data).toMatchObject({
      title: 'Mug',
      price: 12,
      status: 'draft', // default
      variants: [{ color: 'red', stock: 3 }],
    });
    expect(store.getRecord(rec.id)?.data.title).toBe('Mug');
  });

  it('rejects an invalid write with field-level errors', () => {
    try {
      store.insert(colId, { price: -1, status: 'bogus' }); // title missing + bad option
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(RecordValidationError);
      const paths = (e as RecordValidationError).errors.map((x) => x.path);
      expect(paths).toContain('title');
      expect(paths).toContain('status');
    }
  });

  it('find honours where + sort + limit + offset and reports total', () => {
    store.insert(colId, { title: 'A', price: 30, status: 'published' });
    store.insert(colId, { title: 'B', price: 10, status: 'published' });
    store.insert(colId, { title: 'C', price: 20, status: 'draft' });

    const res = store.find(colId, {
      where: [{ field: 'status', op: 'eq', value: 'published' }],
      sort: [{ field: 'price', dir: 'asc' }],
      limit: 1,
      offset: 0,
    });
    expect(res.total).toBe(2);
    expect(res.records).toHaveLength(1);
    expect(res.records[0]?.data.title).toBe('B'); // cheapest published
  });

  it('supports gt/lt/contains/in/exists/ne operators', () => {
    store.insert(colId, { title: 'Alpha', price: 5 });
    store.insert(colId, { title: 'Beta', price: 15 });
    store.insert(colId, { title: 'Gamma', price: 25, shipping: 'ship_1' });

    expect(store.find(colId, { where: [{ field: 'price', op: 'gt', value: 10 }] }).total).toBe(2);
    expect(store.find(colId, { where: [{ field: 'price', op: 'lt', value: 10 }] }).total).toBe(1);
    expect(store.find(colId, { where: [{ field: 'title', op: 'contains', value: 'amm' }] }).total).toBe(1);
    expect(store.find(colId, { where: [{ field: 'title', op: 'in', value: ['Alpha', 'Beta'] }] }).total).toBe(2);
    expect(store.find(colId, { where: [{ field: 'shipping', op: 'exists', value: true }] }).total).toBe(1);
    expect(store.find(colId, { where: [{ field: 'shipping', op: 'exists', value: false }] }).total).toBe(2);
    expect(store.find(colId, { where: [{ field: 'title', op: 'ne', value: 'Alpha' }] }).total).toBe(2);
  });

  it('count matches find total', () => {
    store.insert(colId, { title: 'A', price: 1, status: 'published' });
    store.insert(colId, { title: 'B', price: 2, status: 'draft' });
    expect(store.count(colId)).toBe(2);
    expect(store.count(colId, { where: [{ field: 'status', op: 'eq', value: 'published' }] })).toBe(1);
  });
});

describe('SqliteCollectionStore — update + delete', () => {
  let store: SqliteCollectionStore;
  let colId: string;
  beforeEach(() => {
    ({ store } = freshStore());
    colId = store.define(BOT, { slug: 'products', name: 'P', schema: productsSchema }).id;
  });

  it('merge update keeps other fields; replace swaps the whole group', () => {
    const rec = store.insert(colId, {
      title: 'Mug',
      price: 10,
      variants: [{ color: 'red', stock: 3 }],
    });
    const merged = store.update(rec.id, { price: 99 });
    expect(merged.data.price).toBe(99);
    expect(merged.data.title).toBe('Mug'); // untouched
    expect(merged.data.variants).toEqual([{ color: 'red', stock: 3 }]); // untouched

    const replaced = store.update(rec.id, { title: 'Mug', variants: [{ color: 'blue', stock: 1 }] }, { mode: 'replace' });
    expect(replaced.data.variants).toEqual([{ color: 'blue', stock: 1 }]);
    expect(replaced.data.price).toBeUndefined(); // replaced doc has no price
  });

  it('rejects an invalid merge patch', () => {
    const rec = store.insert(colId, { title: 'Mug' });
    expect(() => store.update(rec.id, { price: 'not-a-number' as unknown })).toThrow(RecordValidationError);
  });

  it('deleteRecord removes one row', () => {
    const rec = store.insert(colId, { title: 'X' });
    expect(store.deleteRecord(rec.id)).toBe(true);
    expect(store.getRecord(rec.id)).toBeNull();
  });

  it('deleteWhere guards multi-delete unless confirmed', () => {
    store.insert(colId, { title: 'A', status: 'draft' });
    store.insert(colId, { title: 'B', status: 'draft' });
    const filter = { where: [{ field: 'status', op: 'eq' as const, value: 'draft' }] };
    expect(() => store.deleteWhere(colId, filter)).toThrow(MultiDeleteGuardError);
    expect(store.deleteWhere(colId, filter, true)).toBe(2);
    expect(store.count(colId)).toBe(0);
  });
});

describe('SqliteCollectionStore — additive-safe schema migration (lazy)', () => {
  it('reading an old record after adding a field applies the new default', () => {
    const { store } = freshStore();
    const colId = store.define(BOT, {
      slug: 'products',
      name: 'P',
      schema: { fields: [{ key: 'title', type: 'text', required: true }] },
    }).id;
    const rec = store.insert(colId, { title: 'Legacy' });

    // Evolve the schema: add `status` with a default + an indexed field.
    store.updateDefinition(colId, {
      schema: {
        fields: [
          { key: 'title', type: 'text', required: true },
          { key: 'status', type: 'select', options: [{ value: 'draft' }, { value: 'published' }], default: 'draft', indexed: true },
        ],
      },
    });

    const read = store.getRecord(rec.id);
    expect(read?.data.status).toBe('draft'); // default applied on read
    expect(store.indexNamesFor(colId)).toHaveLength(1); // new index created
  });

  it('a write after schema change lazily re-validates against the new schema', () => {
    const { store } = freshStore();
    const colId = store.define(BOT, {
      slug: 'products',
      name: 'P',
      schema: { fields: [{ key: 'title', type: 'text', required: true }] },
    }).id;
    const rec = store.insert(colId, { title: 'Legacy' });
    store.updateDefinition(colId, {
      schema: {
        fields: [
          { key: 'title', type: 'text', required: true },
          { key: 'qty', type: 'number', required: true, default: 1 },
        ],
      },
    });
    // Merge update fills the defaulted required field from applyDefaults.
    const updated = store.update(rec.id, { title: 'Now' });
    expect(updated.data.qty).toBe(1);
  });
});
