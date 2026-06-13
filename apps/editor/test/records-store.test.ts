/**
 * P3.5-T4 — records store + CRUD-panel acceptance over the fake server.
 *
 * The PLAN acceptance is the "operator persona" run: add a product with 3
 * variants and a photo, edit the stock of one variant, filter the list by a
 * select field — all writes validated server-side. We drive exactly that path
 * through the typed client + records store (no canvas, no DOM), proving the
 * panel's data plumbing end-to-end against the real REST envelopes.
 */
import type { CreateCollectionBody } from '@ctb/shared';
import { describe, expect, it } from 'vitest';
import { ApiClient } from '../src/api/client';
import {
  buildFilter,
  toRecordData,
} from '../src/pages/collections/record-model';
import { createAuthStore } from '../src/stores/auth';
import { createBotsStore } from '../src/stores/bots';
import { createRecordsStore } from '../src/stores/records';
import { createFakeServer } from './fake-fetch';

const VALID_TOKEN = '123456789:AAEabcdefghijklmnopqrstuvwxy-z12345';

const productsBody: CreateCollectionBody = {
  slug: 'products',
  name: 'Products',
  schema: {
    fields: [
      { key: 'title', type: 'text', required: true, showInList: true },
      { key: 'price', type: 'number', required: true, showInList: true, validation: { min: 0 } },
      {
        key: 'status',
        type: 'select',
        showInList: true,
        options: [
          { value: 'active', label: { en: 'Active' } },
          { value: 'archived', label: { en: 'Archived' } },
        ],
      },
      { key: 'photo', type: 'image' },
      {
        key: 'variants',
        type: 'group',
        fields: [
          { key: 'sku', type: 'text', required: true },
          { key: 'stock', type: 'number' },
        ],
      },
    ],
  },
  display: { listColumns: ['title', 'price', 'status'], titleField: 'title', defaultSort: { field: 'price', dir: 'asc' } },
};

async function setup() {
  const srv = createFakeServer();
  const client = new ApiClient({ fetchImpl: srv.fetch });
  const useAuth = createAuthStore(client);
  await useAuth.getState().login('admin', 'pw');
  const useBots = createBotsStore(client);
  const bot = await useBots.getState().createBot({ name: 'Shop', token: VALID_TOKEN, mode: 'polling', settings: {} });
  const col = await client.createCollection(bot.id, productsBody);
  return { srv, client, botId: bot.id, collectionId: col.id, schema: col.schema };
}

describe('records store: operator CRUD over the fake server', () => {
  it('queries an empty collection', async () => {
    const { client, collectionId, schema } = await setup();
    const useRecords = createRecordsStore(client);
    await useRecords.getState().query(collectionId, buildFilter({ schema }));
    expect(useRecords.getState().records).toHaveLength(0);
    expect(useRecords.getState().total).toBe(0);
  });

  it('🎬 operator persona: add a product with 3 variants + photo, edit one variant stock', async () => {
    const { client, botId, collectionId, schema } = await setup();
    const useRecords = createRecordsStore(client);

    // upload a "photo" (base64 stand-in)
    const file = await client.uploadFile(botId, btoa('PNGBYTES'), 'image/png');
    expect(file.id).toBeTruthy();

    // build the record exactly as the form would: a draft → toRecordData
    const draft = {
      title: 'Mug',
      price: '9.5',
      status: 'active',
      photo: file.id,
      variants: [
        { sku: 'M-RED', stock: '3' },
        { sku: 'M-BLUE', stock: '5' },
        { sku: 'M-GREEN', stock: '0' },
      ],
    };
    const created = await useRecords.getState().createRecord(collectionId, {
      data: toRecordData(schema, draft),
    });
    expect(created && 'data' in created).toBe(true);
    const rec = created as Extract<typeof created, { data: unknown }>;
    expect(rec.data.price).toBe(9.5);
    expect(rec.data.photo).toBe(file.id);
    expect((rec.data.variants as unknown[]).length).toBe(3);

    // edit the stock of the SECOND variant via a replace-mode update
    const editedDraft = {
      ...draft,
      variants: [
        { sku: 'M-RED', stock: '3' },
        { sku: 'M-BLUE', stock: '42' },
        { sku: 'M-GREEN', stock: '0' },
      ],
    };
    const updated = await useRecords.getState().updateRecord(collectionId, rec.id, {
      data: toRecordData(schema, editedDraft),
      mode: 'replace',
    });
    expect(updated && 'data' in updated).toBe(true);
    const u = updated as Extract<typeof updated, { data: unknown }>;
    expect((u.data.variants as { sku: string; stock: number }[])[1]).toEqual({ sku: 'M-BLUE', stock: 42 });
  });

  it('a 422 returns a field-error map the form renders inline (required field)', async () => {
    const { client, collectionId } = await setup();
    const useRecords = createRecordsStore(client);
    // price is required → server 422 → store returns a FieldErrors map, not a throw
    const result = await useRecords.getState().createRecord(collectionId, { data: { title: 'NoPrice' } });
    expect(result && 'data' in result).toBe(false);
    expect((result as Record<string, string>).price).toBeTruthy();
  });

  it('filters the list by a select field (server-side filter parity)', async () => {
    const { client, collectionId, schema } = await setup();
    const useRecords = createRecordsStore(client);
    await client.createRecord(collectionId, { data: { title: 'A', price: 1, status: 'active' } });
    await client.createRecord(collectionId, { data: { title: 'B', price: 2, status: 'archived' } });
    await client.createRecord(collectionId, { data: { title: 'C', price: 3, status: 'active' } });

    await useRecords.getState().query(
      collectionId,
      buildFilter({ schema, filters: [{ field: 'status', op: 'eq', value: 'active' }] }),
    );
    const titles = useRecords.getState().records.map((r) => r.data.title).sort();
    expect(titles).toEqual(['A', 'C']);
    expect(useRecords.getState().total).toBe(2);
  });

  it('sort + pagination travel through to the server', async () => {
    const { client, collectionId, schema } = await setup();
    const useRecords = createRecordsStore(client);
    for (const p of [3, 1, 2]) {
      await client.createRecord(collectionId, { data: { title: `P${p}`, price: p } });
    }
    await useRecords.getState().query(
      collectionId,
      buildFilter({ schema, sort: { field: 'price', dir: 'desc' }, limit: 2, offset: 0 }),
    );
    expect(useRecords.getState().records.map((r) => r.data.price)).toEqual([3, 2]);
    expect(useRecords.getState().total).toBe(3); // total ignores the page limit
  });

  it('search term filters via a contains row', async () => {
    const { client, collectionId, schema } = await setup();
    const useRecords = createRecordsStore(client);
    await client.createRecord(collectionId, { data: { title: 'Red Mug', price: 9 } });
    await client.createRecord(collectionId, { data: { title: 'Blue Cap', price: 12 } });

    await useRecords.getState().query(collectionId, buildFilter({ schema, search: 'Mug' }));
    expect(useRecords.getState().records.map((r) => r.data.title)).toEqual(['Red Mug']);
  });

  it('delete removes the record from the store and the server', async () => {
    const { srv, client, collectionId, schema } = await setup();
    const useRecords = createRecordsStore(client);
    const rec = await client.createRecord(collectionId, { data: { title: 'X', price: 1 } });
    await useRecords.getState().query(collectionId, buildFilter({ schema }));
    expect(useRecords.getState().records).toHaveLength(1);

    await useRecords.getState().deleteRecord(collectionId, rec.id);
    expect(useRecords.getState().records).toHaveLength(0);
    expect(srv.records.has(rec.id)).toBe(false);
  });
});
