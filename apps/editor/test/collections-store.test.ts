/**
 * P3.5-T3 — collections store tests over the fake server. Exercises the full
 * create → list → edit → record-count → delete cycle through the typed client,
 * proving the store stays in sync with the (fake) server and that the schema
 * built in the UI round-trips the real REST envelopes.
 */
import type { CreateCollectionBody } from '@ctb/shared';
import { describe, expect, it } from 'vitest';
import { ApiClient } from '../src/api/client';
import { createAuthStore } from '../src/stores/auth';
import { createBotsStore } from '../src/stores/bots';
import { createCollectionsStore } from '../src/stores/collections';
import { createFakeServer } from './fake-fetch';

const VALID_TOKEN = '123456789:AAEabcdefghijklmnopqrstuvwxy-z12345';

async function setupWithBot() {
  const srv = createFakeServer();
  const client = new ApiClient({ fetchImpl: srv.fetch });
  const useAuth = createAuthStore(client);
  await useAuth.getState().login('admin', 'pw');
  const useBots = createBotsStore(client);
  const bot = await useBots.getState().createBot({
    name: 'Shop',
    token: VALID_TOKEN,
    mode: 'polling',
    settings: {},
  });
  return { srv, client, botId: bot.id };
}

const productsBody: CreateCollectionBody = {
  slug: 'products',
  name: 'Products',
  schema: {
    fields: [
      { key: 'title', type: 'text', required: true, showInList: true },
      { key: 'price', type: 'number', indexed: true, showInList: true },
    ],
  },
  display: { listColumns: ['title', 'price'], titleField: 'title' },
};

describe('collections store', () => {
  it('create + list keep the store in sync with the server', async () => {
    const { client, botId } = await setupWithBot();
    const useCollections = createCollectionsStore(client);

    await useCollections.getState().load(botId);
    expect(useCollections.getState().collections).toHaveLength(0);

    const col = await useCollections.getState().createCollection(botId, productsBody);
    expect(col.slug).toBe('products');
    expect(col.schema.fields).toHaveLength(2);
    expect(useCollections.getState().collections).toHaveLength(1);
  });

  it('update replaces the schema and bumps version', async () => {
    const { client, botId } = await setupWithBot();
    const useCollections = createCollectionsStore(client);
    const col = await useCollections.getState().createCollection(botId, productsBody);

    const updated = await useCollections.getState().updateCollection(col.id, {
      name: 'Catalog',
      schema: { fields: [{ key: 'title', type: 'text', required: true }] },
    });
    expect(updated.name).toBe('Catalog');
    expect(updated.schema.fields).toHaveLength(1);
    expect(updated.version).toBe(2);
    expect(useCollections.getState().collections[0]?.name).toBe('Catalog');
  });

  it('recordCount reflects records created against the collection', async () => {
    const { client, botId } = await setupWithBot();
    const useCollections = createCollectionsStore(client);
    const col = await useCollections.getState().createCollection(botId, productsBody);

    expect(await useCollections.getState().recordCount(col.id)).toBe(0);
    await client.createRecord(col.id, { data: { title: 'Mug', price: 9 } });
    await client.createRecord(col.id, { data: { title: 'Cap', price: 12 } });
    expect(await useCollections.getState().recordCount(col.id)).toBe(2);
  });

  it('delete removes the collection (and cascades its records on the server)', async () => {
    const { srv, client, botId } = await setupWithBot();
    const useCollections = createCollectionsStore(client);
    const col = await useCollections.getState().createCollection(botId, productsBody);
    await client.createRecord(col.id, { data: { title: 'Mug', price: 9 } });

    await useCollections.getState().deleteCollection(col.id);
    expect(useCollections.getState().collections).toHaveLength(0);
    expect([...srv.records.values()].filter((r) => r.collectionId === col.id)).toHaveLength(0);
  });

  it('rejects an invalid schema locally (I5) before any network call', async () => {
    const { srv, client, botId } = await setupWithBot();
    const useCollections = createCollectionsStore(client);
    const before = srv.calls.length;
    await expect(
      useCollections.getState().createCollection(botId, {
        slug: 'bad',
        name: 'Bad',
        // select with no options — invalid per CollectionSchema
        schema: { fields: [{ key: 'x', type: 'select', options: [] }] },
      } as CreateCollectionBody),
    ).rejects.toThrow();
    // no POST hit the server — validation failed client-side
    expect(srv.calls.length).toBe(before);
  });

  it('record create enforces required fields via the shared validator (422)', async () => {
    const { client, botId } = await setupWithBot();
    const useCollections = createCollectionsStore(client);
    const col = await useCollections.getState().createCollection(botId, productsBody);
    // title is required → server returns 422 validation_failed
    await expect(client.createRecord(col.id, { data: { price: 5 } })).rejects.toMatchObject({
      status: 422,
    });
  });
});
