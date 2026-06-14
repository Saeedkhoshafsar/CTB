/**
 * P3.5-T6 — starter-pack templates contract.
 *
 * Every shipped pack must be IMPORT-READY through the existing code paths (I5):
 *   • each collection's `body` validates against CreateCollectionBodySchema,
 *   • each flow's `export` validates against FlowExportSchema,
 *   • flows only reference collection slugs the pack actually ships,
 *   • the gallery row (collectionPackInfo) is the light, serializable shape.
 *
 * A malformed template can therefore never ship — this test fails at build.
 */
import { describe, expect, it } from 'vitest';
import {
  COLLECTION_PACKS,
  CreateCollectionBodySchema,
  FlowExportSchema,
  collectionPackInfo,
  findCollectionPack,
  shopPack,
} from '@ctb/shared';

describe('collection starter packs (P3.5-T6)', () => {
  it('exposes the shop pack in the gallery', () => {
    expect(COLLECTION_PACKS.map((p) => p.id)).toContain('shop');
    expect(findCollectionPack('shop')).toBe(shopPack);
    expect(findCollectionPack('nope')).toBeUndefined();
  });

  for (const pack of COLLECTION_PACKS) {
    describe(`pack "${pack.id}"`, () => {
      it('every collection body validates against CreateCollectionBodySchema', () => {
        for (const col of pack.collections) {
          const res = CreateCollectionBodySchema.safeParse(col.body);
          if (!res.success) {
            throw new Error(`${pack.id}/${col.slug}: ${JSON.stringify(res.error.issues, null, 2)}`);
          }
          expect(col.body.slug).toBe(col.slug);
        }
      });

      it('every flow export validates against FlowExportSchema', () => {
        for (const f of pack.flows) {
          const res = FlowExportSchema.safeParse(f.export);
          if (!res.success) {
            throw new Error(`${pack.id}/${f.id}: ${JSON.stringify(res.error.issues, null, 2)}`);
          }
        }
      });

      it('flows only reference collection slugs the pack ships', () => {
        const slugs = new Set(pack.collections.map((c) => c.slug));
        for (const f of pack.flows) {
          for (const node of f.export.graph.nodes) {
            const params = node.params as { collection?: unknown };
            if (typeof params.collection === 'string') {
              expect(slugs.has(params.collection)).toBe(true);
            }
          }
        }
      });

      it('gallery info is the light, serializable shape (no nested schema/graph)', () => {
        const info = collectionPackInfo(pack);
        expect(info.id).toBe(pack.id);
        expect(info.collectionSlugs).toEqual(pack.collections.map((c) => c.slug));
        expect(info.flowNames).toEqual(pack.flows.map((f) => f.export.name));
        expect(info).not.toHaveProperty('collections');
        expect(info).not.toHaveProperty('flows');
      });
    });
  }

  it('shop pack: catalog + orders collections and browse + notify flows', () => {
    expect(shopPack.collections.map((c) => c.slug)).toEqual(['catalog', 'orders']);
    expect(shopPack.flows.map((f) => f.id)).toEqual(['browse-and-order', 'notify-on-status']);

    // the notify flow is a recordChanged-triggered flow watching orders.status
    const notify = shopPack.flows.find((f) => f.id === 'notify-on-status')!;
    const trigger = notify.export.graph.nodes.find((n) => n.type === 'collection.recordChanged')!;
    expect(trigger).toBeTruthy();
    expect((trigger.params as { collection: string }).collection).toBe('orders');
    expect((trigger.params as { field_filter: string[] }).field_filter).toEqual(['status']);

    // the browse flow inserts an orders record via a data.collection node
    const browse = shopPack.flows.find((f) => f.id === 'browse-and-order')!;
    const insert = browse.export.graph.nodes.find((n) => n.type === 'data.collection')!;
    expect((insert.params as { operation: string }).operation).toBe('insert');
    expect((insert.params as { collection: string }).collection).toBe('orders');
  });
});
