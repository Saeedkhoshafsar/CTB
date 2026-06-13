/**
 * P3.5-T4 — record-form & list model tests (PURE). These cover the heart of the
 * auto-generated CRUD panel: draft↔typed conversions (incl. group rows), the
 * list-column/title/cell helpers, and the search/filter → shared `RecordFilter`
 * compiler. The acceptance bar (invariant I5) is that `toRecordData`'s output
 * validates against the SAME shared `validateRecord` the server runs.
 */
import {
  type CollectionPublic,
  type CollectionSchemaDoc,
  validateRecord,
} from '@ctb/shared';
import { describe, expect, it } from 'vitest';
import {
  type FilterDraft,
  buildFilter,
  cellText,
  emptyDraft,
  listColumns,
  nextSort,
  recordTitle,
  recordToDraft,
  titleField,
  toRecordData,
} from '../src/pages/collections/record-model';

/** The demo `products` schema, with a select, an image and a `variants` group. */
const productsSchema: CollectionSchemaDoc = {
  fields: [
    { key: 'title', type: 'text', required: true, showInList: true, label: { en: 'Name' } },
    { key: 'price', type: 'number', required: true, showInList: true, validation: { min: 0 } },
    {
      key: 'status',
      type: 'select',
      options: [
        { value: 'active', label: { en: 'Active' } },
        { value: 'archived', label: { en: 'Archived' } },
      ],
    },
    { key: 'photo', type: 'image' },
    {
      key: 'variants',
      type: 'group',
      label: { en: 'Variants' },
      fields: [
        { key: 'sku', type: 'text', required: true },
        { key: 'stock', type: 'number' },
      ],
    },
  ],
};

function collection(over: Partial<CollectionPublic> = {}): CollectionPublic {
  return {
    id: 'col-1',
    botId: 'bot-1',
    slug: 'products',
    name: 'Products',
    icon: null,
    schema: productsSchema,
    display: {},
    version: 1,
    createdAt: '',
    updatedAt: '',
    ...over,
  };
}

describe('record-model: draft ↔ typed data', () => {
  it('emptyDraft seeds defaults and type-appropriate empties', () => {
    const d = emptyDraft(productsSchema);
    expect(d.title).toBe('');
    expect(d.price).toBe('');
    expect(d.status).toBe('');
    expect(d.variants).toEqual([]);
  });

  it('toRecordData coerces and produces a doc that passes the shared validator', () => {
    const draft = {
      title: 'Mug',
      price: '9.5', // string from the <input> → number
      status: 'active',
      photo: 'file-abc',
      variants: [
        { sku: 'M-RED', stock: '3' },
        { sku: 'M-BLUE', stock: '' }, // blank optional stock → omitted
      ],
    };
    const data = toRecordData(productsSchema, draft);
    expect(data.price).toBe(9.5);
    expect(data.variants).toEqual([{ sku: 'M-RED', stock: 3 }, { sku: 'M-BLUE' }]);
    // the document validates against the SHARED schema (I5)
    const clean = validateRecord(productsSchema, data);
    expect(clean.title).toBe('Mug');
    expect(clean.price).toBe(9.5);
  });

  it('drops blank optionals so the server reports required ones as field errors', () => {
    const data = toRecordData(productsSchema, { title: '', price: '', variants: [] });
    expect('title' in data).toBe(false);
    expect('price' in data).toBe(false);
    expect(() => validateRecord(productsSchema, data)).toThrow(); // title/price required
  });

  it('round-trips an existing record through recordToDraft → toRecordData', () => {
    const original = { title: 'Cap', price: 12, status: 'archived', variants: [{ sku: 'C1', stock: 5 }] };
    const draft = recordToDraft(productsSchema, original);
    expect(draft.price).toBe('12'); // numbers become strings for the input
    const back = toRecordData(productsSchema, draft);
    expect(back).toEqual(original);
  });
});

describe('record-model: list helpers', () => {
  it('listColumns honours explicit display.listColumns order', () => {
    const cols = listColumns(collection({ display: { listColumns: ['price', 'title'] } }));
    expect(cols.map((c) => c.key)).toEqual(['price', 'title']);
  });

  it('listColumns falls back to showInList flags', () => {
    const cols = listColumns(collection());
    expect(cols.map((c) => c.key)).toEqual(['title', 'price']);
  });

  it('titleField + recordTitle resolve a human label', () => {
    const col = collection({ display: { titleField: 'title' } });
    expect(titleField(col)?.key).toBe('title');
    expect(recordTitle(col, { id: 'r1', collectionId: 'col-1', data: { title: 'Mug' }, createdAt: '', updatedAt: '', createdBy: 'admin' })).toBe('Mug');
  });

  it('cellText renders selects, booleans, groups and files compactly', () => {
    const status = productsSchema.fields.find((f) => f.key === 'status')!;
    const variants = productsSchema.fields.find((f) => f.key === 'variants')!;
    const photo = productsSchema.fields.find((f) => f.key === 'photo')!;
    expect(cellText(status, 'active')).toBe('Active');
    expect(cellText(variants, [{ sku: 'a' }, { sku: 'b' }])).toBe('2');
    expect(cellText(photo, 'file-x')).toBe('📎');
    expect(cellText(status, undefined)).toBe('—');
  });
});

describe('record-model: buildFilter → shared RecordFilter', () => {
  it('search term becomes a contains row on the first searchable field', () => {
    const f = buildFilter({ schema: productsSchema, search: 'mug' });
    expect(f.where).toEqual([{ field: 'title', op: 'contains', value: 'mug' }]);
  });

  it('coerces a number filter row value to a number', () => {
    const filters: FilterDraft[] = [{ field: 'price', op: 'gte', value: '10' }];
    const f = buildFilter({ schema: productsSchema, filters });
    expect(f.where).toEqual([{ field: 'price', op: 'gte', value: 10 }]);
  });

  it('select equals filter passes through + carries sort/limit/offset', () => {
    const filters: FilterDraft[] = [{ field: 'status', op: 'eq', value: 'active' }];
    const f = buildFilter({
      schema: productsSchema,
      filters,
      sort: { field: 'price', dir: 'desc' },
      limit: 25,
      offset: 50,
    });
    expect(f.where).toContainEqual({ field: 'status', op: 'eq', value: 'active' });
    expect(f.sort).toEqual([{ field: 'price', dir: 'desc' }]);
    expect(f.limit).toBe(25);
    expect(f.offset).toBe(50);
  });

  it('in splits a comma list; exists has no value coercion', () => {
    const f = buildFilter({
      schema: productsSchema,
      filters: [
        { field: 'status', op: 'in', value: 'active, archived' },
        { field: 'photo', op: 'exists', value: 'true' },
      ],
    });
    expect(f.where).toContainEqual({ field: 'status', op: 'in', value: ['active', 'archived'] });
    expect(f.where).toContainEqual({ field: 'photo', op: 'exists', value: true });
  });

  it('skips empty filter rows (no field / blank value)', () => {
    const f = buildFilter({
      schema: productsSchema,
      filters: [
        { field: '', op: 'eq', value: 'x' },
        { field: 'title', op: 'eq', value: '   ' },
      ],
    });
    expect(f.where).toEqual([]);
  });
});

describe('record-model: nextSort toggle', () => {
  it('cycles asc → desc → cleared, and new field starts asc', () => {
    expect(nextSort(null, 'price')).toEqual({ field: 'price', dir: 'asc' });
    expect(nextSort({ field: 'price', dir: 'asc' }, 'price')).toEqual({ field: 'price', dir: 'desc' });
    expect(nextSort({ field: 'price', dir: 'desc' }, 'price')).toBeNull();
    expect(nextSort({ field: 'price', dir: 'asc' }, 'title')).toEqual({ field: 'title', dir: 'asc' });
  });
});
