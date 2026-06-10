import { describe, expect, it } from 'vitest';
import { BinaryRefSchema, FlowItemSchema, item } from '@ctb/shared';

describe('FlowItem & BinaryRef', () => {
  it('parses a plain json item', () => {
    const parsed = FlowItemSchema.parse({ json: { text: 'hi', n: 1, nested: { a: [1, 2] } } });
    expect(parsed.json['text']).toBe('hi');
    expect(parsed.binary).toBeUndefined();
  });

  it('parses an item with telegram binary ref', () => {
    const parsed = FlowItemSchema.parse({
      json: {},
      binary: { photo: { kind: 'tg_file_id', fileId: 'AgACAgQ', mime: 'image/jpeg' } },
    });
    expect(parsed.binary?.['photo']?.kind).toBe('tg_file_id');
  });

  it('rejects unknown binary kinds and bad urls', () => {
    expect(BinaryRefSchema.safeParse({ kind: 'ftp', path: 'x' }).success).toBe(false);
    expect(BinaryRefSchema.safeParse({ kind: 'url', url: 'not-a-url' }).success).toBe(false);
  });

  it('item() helper builds valid items', () => {
    expect(FlowItemSchema.safeParse(item({ a: 1 })).success).toBe(true);
    expect(
      FlowItemSchema.safeParse(item({}, { f: { kind: 'stored', fileRecordId: 'r1' } })).success,
    ).toBe(true);
  });
});
