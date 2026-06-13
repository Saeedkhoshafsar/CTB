/**
 * P3.5-T1 — Collections contract: CollectionSchema validation + the pure
 * record validator/coercer + read-time defaulting. (ARCHITECTURE §13.)
 */
import { describe, expect, it } from 'vitest';
import {
  CollectionSchema,
  RecordFilterSchema,
  RecordValidationError,
  applyDefaults,
  indexedFields,
  labelText,
  validateRecord,
  type CollectionSchemaDoc,
} from '@ctb/shared';

/** A products-style schema exercising group + relation + select + indexed. */
const productsSchema: CollectionSchemaDoc = CollectionSchema.parse({
  fields: [
    { key: 'title', type: 'text', required: true, indexed: true },
    { key: 'price', type: 'number', validation: { min: 0 } },
    { key: 'active', type: 'boolean', default: true },
    { key: 'status', type: 'select', options: [{ value: 'draft' }, { value: 'published' }], default: 'draft' },
    { key: 'tags', type: 'multiSelect', options: [{ value: 'new' }, { value: 'sale' }] },
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
});

describe('CollectionSchema', () => {
  it('accepts a valid group+relation+select schema', () => {
    expect(productsSchema.fields).toHaveLength(7);
  });

  it('rejects a select field without options', () => {
    const r = CollectionSchema.safeParse({ fields: [{ key: 'x', type: 'select' }] });
    expect(r.success).toBe(false);
  });

  it('rejects a relation field without a target', () => {
    const r = CollectionSchema.safeParse({ fields: [{ key: 'x', type: 'relation' }] });
    expect(r.success).toBe(false);
  });

  it('rejects a group nested inside a group (one level deep)', () => {
    const r = CollectionSchema.safeParse({
      fields: [{ key: 'g', type: 'group', fields: [{ key: 'inner', type: 'group', fields: [{ key: 'a', type: 'text' }] }] }],
    });
    expect(r.success).toBe(false);
  });

  it('rejects duplicate field keys', () => {
    const r = CollectionSchema.safeParse({
      fields: [{ key: 'a', type: 'text' }, { key: 'a', type: 'number' }],
    });
    expect(r.success).toBe(false);
  });

  it('rejects bad field key identifiers', () => {
    const r = CollectionSchema.safeParse({ fields: [{ key: '1bad', type: 'text' }] });
    expect(r.success).toBe(false);
  });

  it('indexedFields returns only indexed, non-group fields', () => {
    expect(indexedFields(productsSchema).map((f) => f.key)).toEqual(['title']);
  });

  it('labelText resolves fa → en → fallback', () => {
    expect(labelText({ fa: 'عنوان', en: 'Title' }, 'x')).toBe('عنوان');
    expect(labelText({ en: 'Title' }, 'x')).toBe('Title');
    expect(labelText('Plain', 'x')).toBe('Plain');
    expect(labelText(undefined, 'fallback')).toBe('fallback');
  });
});

describe('validateRecord — coercion + defaults', () => {
  it('coerces, defaults and drops unknown keys', () => {
    const out = validateRecord(productsSchema, {
      title: 'Mug',
      price: '12.5', // string → number
      extra: 'ignored',
      variants: [{ color: 'red', stock: '4' }],
    });
    expect(out).toEqual({
      title: 'Mug',
      price: 12.5,
      active: true, // default
      status: 'draft', // default
      variants: [{ color: 'red', stock: 4 }],
    });
    expect(out).not.toHaveProperty('extra');
  });

  it('throws field-level errors for a missing required field + bad option', () => {
    try {
      validateRecord(productsSchema, { status: 'nope' });
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(RecordValidationError);
      const err = e as RecordValidationError;
      const paths = err.errors.map((x) => x.path);
      expect(paths).toContain('title'); // required
      expect(paths).toContain('status'); // disallowed option
    }
  });

  it('validates number min and group sub-field options', () => {
    expect(() => validateRecord(productsSchema, { title: 't', price: -1 })).toThrow(RecordValidationError);
    expect(() =>
      validateRecord(productsSchema, { title: 't', variants: [{ color: 'green' }] }),
    ).toThrow(RecordValidationError);
  });

  it('partial mode skips required checks on absent fields', () => {
    const out = validateRecord(productsSchema, { price: 9 }, { partial: true });
    expect(out).toEqual({ price: 9 });
  });

  it('multiSelect and relation cardinality are enforced', () => {
    expect(() => validateRecord(productsSchema, { title: 't', tags: ['bad'] })).toThrow();
    expect(() =>
      validateRecord(productsSchema, { title: 't', shipping: ['a', 'b'] }),
    ).toThrow(); // relation kind=one expects a string
  });
});

describe('applyDefaults — additive-safe read', () => {
  it('fills a newly-added field default into an old record', () => {
    const old = { title: 'Legacy' }; // written before active/status existed
    const read = applyDefaults(productsSchema, old);
    expect(read.active).toBe(true);
    expect(read.status).toBe('draft');
    expect(read.tags).toEqual([]); // multiSelect → []
    expect(read.variants).toEqual([]); // group → []
  });

  it('does not overwrite present values', () => {
    const read = applyDefaults(productsSchema, { title: 'X', active: false, status: 'published' });
    expect(read.active).toBe(false);
    expect(read.status).toBe('published');
  });
});

describe('RecordFilter', () => {
  it('parses and defaults where/sort to empty arrays', () => {
    const f = RecordFilterSchema.parse({});
    expect(f.where).toEqual([]);
    expect(f.sort).toEqual([]);
  });

  it('accepts a typical filter', () => {
    const f = RecordFilterSchema.parse({
      where: [{ field: 'status', op: 'eq', value: 'published' }],
      sort: [{ field: 'price', dir: 'desc' }],
      limit: 10,
      offset: 0,
    });
    expect(f.where[0]?.op).toBe('eq');
    expect(f.sort[0]?.dir).toBe('desc');
  });

  it('rejects an unknown operator', () => {
    const r = RecordFilterSchema.safeParse({ where: [{ field: 'x', op: 'like', value: 1 }] });
    expect(r.success).toBe(false);
  });
});
