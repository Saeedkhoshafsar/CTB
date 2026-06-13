/**
 * P3.5-T3 — schema-builder model tests. The acceptance criterion is that the
 * builder PRODUCES JSON validating against the SHARED `CollectionSchema`
 * (invariant I5). We build the three demo collections (`products`,
 * `shipping_methods`, `orders`) entirely from draft rows — the exact shape the
 * UI emits — and assert each parses, plus the destructive-edit diff helper.
 */
import { CollectionSchema, type CollectionField } from '@ctb/shared';
import { describe, expect, it } from 'vitest';
import {
  type DraftField,
  emptyDraftField,
  fromField,
  removedFieldKeys,
  toField,
  toSchemaDoc,
} from '../src/pages/collections/builder-model';

/** Build a draft row with overrides — mirrors what the form state holds. */
function draft(over: Partial<DraftField>): DraftField {
  return { ...emptyDraftField(over.type ?? 'text'), ...over };
}

describe('builder-model: toField normalisation', () => {
  it('drops blank labels/validation and only sets present extras', () => {
    const f = toField(draft({ key: 'title', type: 'text', labelFa: 'عنوان' }));
    expect(f).toEqual({ key: 'title', type: 'text', label: { fa: 'عنوان' } });
  });

  it('parses typed defaults per field type', () => {
    expect(toField(draft({ key: 'n', type: 'number', defaultText: '5' })).default).toBe(5);
    expect(toField(draft({ key: 'b', type: 'boolean', defaultText: 'true' })).default).toBe(true);
    expect(toField(draft({ key: 'm', type: 'multiSelect', defaultText: 'a, b', options: [
      { value: 'a', labelFa: '', labelEn: '' },
      { value: 'b', labelFa: '', labelEn: '' },
    ] })).default).toEqual(['a', 'b']);
    expect(toField(draft({ key: 'j', type: 'json', defaultText: '{"x":1}' })).default).toEqual({ x: 1 });
  });

  it('only sets indexed on top-level non-group fields', () => {
    expect(toField(draft({ key: 'k', type: 'text', indexed: true })).indexed).toBe(true);
    // sub-field: indexed is suppressed
    expect(toField(draft({ key: 'k', type: 'text', indexed: true }), true).indexed).toBeUndefined();
  });

  it('round-trips a field through fromField → toField', () => {
    const original: CollectionField = {
      key: 'price',
      type: 'number',
      label: { fa: 'قیمت', en: 'Price' },
      required: true,
      indexed: true,
      validation: { min: 0 },
    };
    const back = toField(fromField(original));
    expect(back).toEqual(original);
  });
});

describe('builder-model: the three demo collections validate against CollectionSchema', () => {
  it('products', () => {
    const fields: DraftField[] = [
      draft({ key: 'title', type: 'text', labelFa: 'نام', labelEn: 'Name', required: true, showInList: true }),
      draft({ key: 'price', type: 'number', labelEn: 'Price', required: true, indexed: true, showInList: true, min: '0' }),
      draft({
        key: 'status',
        type: 'select',
        labelEn: 'Status',
        options: [
          { value: 'active', labelFa: 'فعال', labelEn: 'Active' },
          { value: 'archived', labelFa: 'بایگانی', labelEn: 'Archived' },
        ],
      }),
      draft({ key: 'photo', type: 'image', labelEn: 'Photo' }),
      draft({
        key: 'variants',
        type: 'group',
        labelEn: 'Variants',
        fields: [
          draft({ key: 'sku', type: 'text', required: true }),
          draft({ key: 'stock', type: 'number' }),
        ],
      }),
    ];
    const parsed = CollectionSchema.safeParse(toSchemaDoc(fields));
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  });

  it('shipping_methods', () => {
    const fields: DraftField[] = [
      draft({ key: 'name', type: 'text', labelEn: 'Name', required: true, showInList: true }),
      draft({ key: 'cost', type: 'number', labelEn: 'Cost', required: true }),
      draft({ key: 'active', type: 'boolean', labelEn: 'Active', defaultText: 'true' }),
    ];
    const parsed = CollectionSchema.safeParse(toSchemaDoc(fields));
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  });

  it('orders (with a relation field pointing at products + shipping_methods)', () => {
    const fields: DraftField[] = [
      draft({ key: 'ref', type: 'text', labelEn: 'Reference', required: true, indexed: true, showInList: true }),
      draft({ key: 'product', type: 'relation', labelEn: 'Product', relationCollection: 'products', relationKind: 'one' }),
      draft({ key: 'shipping', type: 'relation', labelEn: 'Shipping', relationCollection: 'shipping_methods', relationKind: 'one' }),
      draft({
        key: 'state',
        type: 'select',
        labelEn: 'State',
        options: [
          { value: 'new', labelFa: 'جدید', labelEn: 'New' },
          { value: 'paid', labelFa: 'پرداخت‌شده', labelEn: 'Paid' },
          { value: 'shipped', labelFa: 'ارسال‌شده', labelEn: 'Shipped' },
        ],
      }),
      draft({ key: 'placedAt', type: 'dateTime', labelEn: 'Placed at' }),
    ];
    const parsed = CollectionSchema.safeParse(toSchemaDoc(fields));
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
    // the relation target survived into the typed doc
    const order = parsed.success ? parsed.data : null;
    const product = order?.fields.find((f) => f.key === 'product');
    expect(product?.relation).toEqual({ collection: 'products', kind: 'one' });
  });
});

describe('builder-model: invalid drafts are rejected by CollectionSchema', () => {
  it('select with no options fails', () => {
    const parsed = CollectionSchema.safeParse(
      toSchemaDoc([draft({ key: 'x', type: 'select', options: [] })]),
    );
    expect(parsed.success).toBe(false);
  });

  it('duplicate keys fail', () => {
    const parsed = CollectionSchema.safeParse(
      toSchemaDoc([draft({ key: 'dup', type: 'text' }), draft({ key: 'dup', type: 'number' })]),
    );
    expect(parsed.success).toBe(false);
  });

  it('group with no sub-fields fails', () => {
    const parsed = CollectionSchema.safeParse(
      toSchemaDoc([draft({ key: 'g', type: 'group', fields: [] })]),
    );
    expect(parsed.success).toBe(false);
  });
});

describe('builder-model: removedFieldKeys (destructive-edit diff)', () => {
  it('reports keys present before but gone after', () => {
    const before = toSchemaDoc([
      draft({ key: 'a', type: 'text' }),
      draft({ key: 'b', type: 'text' }),
      draft({ key: 'c', type: 'text' }),
    ]);
    const after = toSchemaDoc([draft({ key: 'a', type: 'text' }), draft({ key: 'c', type: 'text' })]);
    expect(removedFieldKeys(before, after)).toEqual(['b']);
  });

  it('no removals when only adding fields', () => {
    const before = toSchemaDoc([draft({ key: 'a', type: 'text' })]);
    const after = toSchemaDoc([draft({ key: 'a', type: 'text' }), draft({ key: 'b', type: 'text' })]);
    expect(removedFieldKeys(before, after)).toEqual([]);
  });
});
