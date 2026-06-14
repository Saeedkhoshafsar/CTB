/**
 * Collection starter templates (P3.5-T6) — the data half of the Phase 3.5
 * demo. A "starter pack" bundles a couple of ready-made Collection schemas
 * with the flows that operate on them, so an operator can stand up a working
 * "browse → order → notify" bot in two clicks, then edit everything.
 *
 * INVARIANT I2 (domain-agnostic core): these are GENERIC primitives wearing a
 * thin demo costume. The `catalog` collection is just "named records with a
 * price, stock and a few variant options"; `orders` is "a record that points
 * at a catalog record, carries a quantity and a status". CTB the engine never
 * learns the words "product" or "order" — they live ONLY in this user-facing
 * template data and in the flow node params, exactly like every other
 * collection an operator could build by hand in the panel.
 *
 * One schema, every consumer (I5): the collection schemas here are the same
 * `CreateCollectionBody` the panel/API accept, and the flows are the same
 * `FlowExport` envelope `import-template` already accepts — so "use starter
 * pack" reuses the existing create-collection + import-flow code paths with no
 * new validation surface. The test suite validates every schema + flow against
 * its Zod schema, so a malformed template can never ship.
 */
import type { CreateCollectionBody } from './collection';
import type { FlowExport } from './flow-export';
import { FLOW_EXPORT_KIND, FLOW_EXPORT_VERSION } from './flow-export';

/** A collection schema offered by a starter pack (a CreateCollectionBody). */
export interface CollectionTemplate {
  /** Stable slug the collection is created with (operator-editable after). */
  slug: string;
  /** i18n key for the human title in the gallery (falls back to body.name). */
  labelKey: string;
  /** i18n key for the one-line description. */
  descriptionKey: string;
  /** The create-collection body — validated against CreateCollectionBodySchema. */
  body: CreateCollectionBody;
}

/** A flow shipped by a starter pack (a FlowExport, same as flow-templates). */
export interface PackFlow {
  /** Stable key, unique within the pack. */
  id: string;
  labelKey: string;
  descriptionKey: string;
  export: FlowExport;
}

/**
 * A starter pack: a set of collections + a set of flows that work together.
 * Importing a pack creates every collection (skipping ones whose slug already
 * exists) then imports every flow.
 */
export interface CollectionPack {
  /** Stable key used by the API + editor (e.g. "shop"). */
  id: string;
  labelKey: string;
  descriptionKey: string;
  /** Icon hint for the gallery card. */
  icon: string;
  collections: CollectionTemplate[];
  flows: PackFlow[];
}

const flow = (name: string, graph: FlowExport['graph']): FlowExport => ({
  kind: FLOW_EXPORT_KIND,
  version: FLOW_EXPORT_VERSION,
  name,
  graph,
  settings: { executionPolicy: 'replace', errorHandlerFlowId: null },
});

// ── collection schemas ───────────────────────────────────────────────────────
//
// `catalog`: a record an operator fills in the panel — a name, a price, stock,
// a size variant (select) and an availability status. All generic field types
// (text/number/select). `titleField` + list columns drive the auto-panel.
const catalog: CollectionTemplate = {
  slug: 'catalog',
  labelKey: 'packs.shop.catalog.label',
  descriptionKey: 'packs.shop.catalog.desc',
  body: {
    slug: 'catalog',
    name: 'Catalog',
    icon: 'package',
    schema: {
      fields: [
        { key: 'name', type: 'text', label: { en: 'Name', fa: 'نام' }, required: true, showInList: true, indexed: true },
        { key: 'description', type: 'longText', label: { en: 'Description', fa: 'توضیحات' } },
        { key: 'price', type: 'number', label: { en: 'Price', fa: 'قیمت' }, required: true, showInList: true, validation: { min: 0 } },
        { key: 'stock', type: 'number', label: { en: 'Stock', fa: 'موجودی' }, default: 0, showInList: true, validation: { min: 0 } },
        {
          key: 'size',
          type: 'select',
          label: { en: 'Size', fa: 'سایز' },
          options: [
            { value: 'S', label: { en: 'Small', fa: 'کوچک' } },
            { value: 'M', label: { en: 'Medium', fa: 'متوسط' } },
            { value: 'L', label: { en: 'Large', fa: 'بزرگ' } },
          ],
        },
        {
          key: 'status',
          type: 'select',
          label: { en: 'Status', fa: 'وضعیت' },
          default: 'available',
          showInList: true,
          indexed: true,
          options: [
            { value: 'available', label: { en: 'Available', fa: 'موجود' } },
            { value: 'hidden', label: { en: 'Hidden', fa: 'پنهان' } },
          ],
        },
      ],
    },
    display: {
      titleField: 'name',
      listColumns: ['name', 'price', 'stock', 'status'],
      defaultSort: { field: 'name', dir: 'asc' },
    },
  },
};

// `orders`: each record references a catalog record by id (a plain text field —
// generic, not a hard relation, so the flow can write it from KV cart state),
// the chosen size, quantity, the customer's chat id (so a status-change flow
// can notify them), and a status the operator flips in the panel.
const orders: CollectionTemplate = {
  slug: 'orders',
  labelKey: 'packs.shop.orders.label',
  descriptionKey: 'packs.shop.orders.desc',
  body: {
    slug: 'orders',
    name: 'Orders',
    icon: 'receipt',
    schema: {
      fields: [
        { key: 'item_id', type: 'text', label: { en: 'Item', fa: 'آیتم' }, required: true, showInList: true, indexed: true },
        { key: 'item_name', type: 'text', label: { en: 'Item name', fa: 'نام آیتم' }, showInList: true },
        { key: 'size', type: 'text', label: { en: 'Size', fa: 'سایز' } },
        { key: 'quantity', type: 'number', label: { en: 'Quantity', fa: 'تعداد' }, required: true, default: 1, showInList: true, validation: { min: 1 } },
        { key: 'customer_chat_id', type: 'text', label: { en: 'Customer chat id', fa: 'شناسهٔ چت مشتری' }, indexed: true },
        {
          key: 'status',
          type: 'select',
          label: { en: 'Status', fa: 'وضعیت' },
          default: 'new',
          required: true,
          showInList: true,
          indexed: true,
          options: [
            { value: 'new', label: { en: 'New', fa: 'جدید' } },
            { value: 'preparing', label: { en: 'Preparing', fa: 'در حال آماده‌سازی' } },
            { value: 'shipped', label: { en: 'Shipped', fa: 'ارسال‌شده' } },
            { value: 'cancelled', label: { en: 'Cancelled', fa: 'لغوشده' } },
          ],
        },
      ],
    },
    display: {
      titleField: 'item_name',
      listColumns: ['item_name', 'size', 'quantity', 'status'],
      defaultSort: { field: 'status', dir: 'asc' },
    },
  },
};

// ── flow 1: browse → variant menu → KV cart → insert order ────────────────────
//
// /shop → find available catalog records → present them as a menu (the demo
// ships a 2-item menu the operator extends/auto-generates) → on click, ask the
// size via a second menu → stash the chosen item+size in the per-user KV cart →
// ask quantity → insert an `orders` record (status defaults to "new") →
// confirm. Every node is a GENERIC primitive; "product"/"order" appear only in
// param strings the operator can rename.
const browseAndOrder: PackFlow = {
  id: 'browse-and-order',
  labelKey: 'packs.shop.browse.label',
  descriptionKey: 'packs.shop.browse.desc',
  export: flow('Browse & order', {
    nodes: [
      { id: 'start', type: 'tg.trigger', params: { event: 'command', command: '/shop' }, position: { x: 0, y: 0 }, disabled: false },
      {
        id: 'pickItem',
        type: 'tg.menu',
        params: {
          text: 'What would you like to order?',
          buttons: [
            [
              { text: 'Item A', key: 'a', value: 'a' },
              { text: 'Item B', key: 'b', value: 'b' },
            ],
          ],
          answer_callback_text: 'Nice pick ✓',
        },
        position: { x: 0, y: 140 },
        disabled: false,
      },
      {
        id: 'stashItem',
        type: 'data.kv',
        params: { op: 'set', scope: 'user', key: 'cart_item', value: '{{ $json.clicked.value }}' },
        position: { x: 0, y: 280 },
        disabled: false,
      },
      {
        id: 'pickSize',
        type: 'tg.menu',
        params: {
          text: 'Which size?',
          buttons: [
            [
              { text: 'S', key: 's', value: 'S' },
              { text: 'M', key: 'm', value: 'M' },
              { text: 'L', key: 'l', value: 'L' },
            ],
          ],
          answer_callback_text: 'Got it ✓',
        },
        position: { x: 0, y: 420 },
        disabled: false,
      },
      {
        id: 'stashSize',
        type: 'data.kv',
        params: { op: 'set', scope: 'user', key: 'cart_size', value: '{{ $json.clicked.value }}' },
        position: { x: 0, y: 560 },
        disabled: false,
      },
      {
        id: 'askQty',
        type: 'tg.waitForReply',
        params: {
          prompt: 'How many?',
          expect: 'number',
          validation: { min: 1, max: 99 },
          invalid_message: 'Please send a whole number from 1 to 99.',
          max_retries: 2,
          save_to: 'qty',
        },
        position: { x: 0, y: 700 },
        disabled: false,
      },
      {
        id: 'readItem',
        type: 'data.kv',
        params: { op: 'get', scope: 'user', key: 'cart_item', save_as: 'cart_item' },
        position: { x: 0, y: 840 },
        disabled: false,
      },
      {
        id: 'readSize',
        type: 'data.kv',
        params: { op: 'get', scope: 'user', key: 'cart_size', save_as: 'cart_size' },
        position: { x: 0, y: 980 },
        disabled: false,
      },
      {
        id: 'placeOrder',
        type: 'data.collection',
        params: {
          collection: 'orders',
          operation: 'insert',
          fields: [
            { field: 'item_id', value: '{{ $json.cart_item }}' },
            { field: 'size', value: '{{ $json.cart_size }}' },
            { field: 'quantity', value: '{{ $vars.qty }}' },
            { field: 'customer_chat_id', value: '{{ $chat.id }}' },
            { field: 'status', value: 'new' },
          ],
        },
        position: { x: 0, y: 1120 },
        disabled: false,
      },
      {
        id: 'confirm',
        type: 'tg.sendMessage',
        params: { type: 'text', text: '✅ Order placed! We’ll let you know when it ships.' },
        position: { x: 0, y: 1260 },
        disabled: false,
      },
    ],
    edges: [
      { id: 'e1', from: { node: 'start', port: 'main' }, to: { node: 'pickItem', port: 'main' } },
      { id: 'e2a', from: { node: 'pickItem', port: 'btn:a' }, to: { node: 'stashItem', port: 'main' } },
      { id: 'e2b', from: { node: 'pickItem', port: 'btn:b' }, to: { node: 'stashItem', port: 'main' } },
      { id: 'e3', from: { node: 'stashItem', port: 'main' }, to: { node: 'pickSize', port: 'main' } },
      { id: 'e4s', from: { node: 'pickSize', port: 'btn:s' }, to: { node: 'stashSize', port: 'main' } },
      { id: 'e4m', from: { node: 'pickSize', port: 'btn:m' }, to: { node: 'stashSize', port: 'main' } },
      { id: 'e4l', from: { node: 'pickSize', port: 'btn:l' }, to: { node: 'stashSize', port: 'main' } },
      { id: 'e5', from: { node: 'stashSize', port: 'main' }, to: { node: 'askQty', port: 'main' } },
      { id: 'e6', from: { node: 'askQty', port: 'reply' }, to: { node: 'readItem', port: 'main' } },
      { id: 'e7', from: { node: 'readItem', port: 'main' }, to: { node: 'readSize', port: 'main' } },
      { id: 'e8', from: { node: 'readSize', port: 'main' }, to: { node: 'placeOrder', port: 'main' } },
      { id: 'e9', from: { node: 'placeOrder', port: 'main' }, to: { node: 'confirm', port: 'main' } },
    ],
  }),
};

// ── flow 2: recordChanged(status) → notify chat ───────────────────────────────
//
// Fires whenever an `orders` record is UPDATED and its `status` field changed
// (field_filter), and only when the new status is a "real" progress state
// (condition guards out edits that don't matter). It reads the customer's
// stored chat id off the changed record and DMs them. This is the operator-side
// half of the demo: flipping a status in the panel notifies the customer.
const notifyOnStatus: PackFlow = {
  id: 'notify-on-status',
  labelKey: 'packs.shop.notify.label',
  descriptionKey: 'packs.shop.notify.desc',
  export: flow('Notify on status change', {
    nodes: [
      {
        id: 'onChange',
        type: 'collection.recordChanged',
        params: {
          collection: 'orders',
          events: ['updated'],
          field_filter: ['status'],
          condition: "{{ $json.record.status === 'shipped' || $json.record.status === 'preparing' }}",
        },
        position: { x: 0, y: 0 },
        disabled: false,
      },
      {
        id: 'notify',
        type: 'tg.sendMessage',
        params: {
          type: 'text',
          chat: '{{ $json.record.customer_chat_id }}',
          text: 'Update on your order: it is now “{{ $json.record.status }}”.',
        },
        position: { x: 0, y: 140 },
        disabled: false,
      },
    ],
    edges: [{ id: 'e1', from: { node: 'onChange', port: 'main' }, to: { node: 'notify', port: 'main' } }],
  }),
};

// ── the gallery ──────────────────────────────────────────────────────────────

/** The one starter pack of Phase 3.5. GENERIC (I2) — demo costume only. */
export const shopPack: CollectionPack = {
  id: 'shop',
  labelKey: 'packs.shop.label',
  descriptionKey: 'packs.shop.desc',
  icon: 'shopping-cart',
  collections: [catalog, orders],
  flows: [browseAndOrder, notifyOnStatus],
};

/** All collection packs, in display order. */
export const COLLECTION_PACKS: readonly CollectionPack[] = [shopPack];

/** Look up a pack by its stable id. */
export function findCollectionPack(id: string): CollectionPack | undefined {
  return COLLECTION_PACKS.find((p) => p.id === id);
}

/** Serializable gallery row for the API (no nested schema/graph in the list). */
export interface CollectionPackInfo {
  id: string;
  labelKey: string;
  descriptionKey: string;
  icon: string;
  collectionSlugs: string[];
  flowNames: string[];
}

export function collectionPackInfo(p: CollectionPack): CollectionPackInfo {
  return {
    id: p.id,
    labelKey: p.labelKey,
    descriptionKey: p.descriptionKey,
    icon: p.icon,
    collectionSlugs: p.collections.map((c) => c.slug),
    flowNames: p.flows.map((f) => f.export.name),
  };
}
