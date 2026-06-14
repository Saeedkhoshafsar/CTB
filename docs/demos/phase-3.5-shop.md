# 🎬 Phase 3.5 demo — the "shop" starter pack (the manager test)

This is the documented end-to-end run that proves Phase 3.5 (Collections):
an **operator builds data in the panel**, a **customer browses and orders in
Telegram**, the **server is killed mid-conversation and resumes** (invariant
I4 — durable, server-state-free conversations), and **flipping an order's
status in the panel notifies the customer** — without anyone touching the flow
canvas.

Everything is **generic** (invariant I2): the engine never learns the words
"product" or "order". They live only in the starter-pack template data and in
node param strings the operator can rename. The "shop" pack is just a thin demo
costume over generic Collections + flow primitives.

> The whole script below is exercised automatically, against a fake Telegram
> transport and a real on-disk SQLite file, by
> `apps/server/test/e2e-phase35-demo.test.ts`. Run it with:
>
> ```bash
> npm run test --workspace=@ctb/server -- e2e-phase35-demo
> ```

---

## What the "shop" pack ships

`packages/shared/src/collection-templates.ts` defines one pack, `shop`:

**Collections**

| slug      | fields                                                                 |
|-----------|------------------------------------------------------------------------|
| `catalog` | `name`, `description`, `price`, `stock`, `size` (select), `status`      |
| `orders`  | `item_id`, `item_name`, `size`, `quantity`, `customer_chat_id`, `status` |

**Flows** (imported as **drafts** — the operator reviews & activates them)

1. **Browse & order** — `/shop` → menu of items → menu of sizes → KV cart →
   `tg.waitForReply` for quantity → `data.collection` *insert* into `orders`
   (status defaults to `new`) → confirmation message.
2. **Notify on status change** — a `collection.recordChanged` trigger watching
   `orders` for `updated` events where the `status` field changed, guarded by
   a condition (`status === 'shipped' || status === 'preparing'`) → a
   `tg.sendMessage` to `{{ $json.record.customer_chat_id }}`.

---

## The run, step by step

### 1. Operator builds the data (admin panel / REST)

Install the pack onto a bot in one call:

```http
POST /api/collection-packs/import
{ "botId": "shop-bot", "packId": "shop" }
```

→ creates the `catalog` + `orders` collections and inserts both flows as
**drafts**. Re-importing is **idempotent**: collections whose slug already
exists are skipped, never clobbered.

The operator reviews the two draft flows and **activates** them, then adds a
couple of catalog items in the auto-generated records panel:

```http
POST /api/records/<catalogId>   { "data": { "name": "Item A", "price": 10, "stock": 5, "size": "M", "status": "available" } }
POST /api/records/<catalogId>   { "data": { "name": "Item B", "price": 20, "stock": 3, "size": "L", "status": "available" } }
```

### 2. Customer browses & orders (Telegram)

```
customer → /shop
bot      → "What would you like to order?"  [Item A] [Item B]
customer → (taps Item A)
bot      → "Which size?"  [S] [M] [L]
customer → (taps M)
bot      → "How many?"
```

At this point the conversation is **parked on a wait** (`tg.waitForReply`) —
the only state is one row in the SQLite `executions` table marked `waiting`.
There is **no in-memory session** holding the conversation.

### 3. 💀 Kill the server mid-conversation, then resume (I4)

The test literally stops the gateway, **closes the SQLite handle**, closes the
HTTP app, throws away every in-memory object, and **boots a brand-new server
from the same SQLite file** — nothing else survives.

```
customer → 2          (answers the quantity question on the NEW server)
bot      → "✅ Order placed! ..."
```

The flow **resumes from the wait** on the fresh process and the
`data.collection` node inserts the order:

```json
{ "item_id": "a", "size": "M", "quantity": 2, "status": "new",
  "customer_chat_id": "555" }
```

This is invariant **I4** in action: conversations are durable and free of
server-resident state.

### 4. Operator ships the order → customer is notified

The operator flips the order's status in the panel:

```http
PATCH /api/records/<ordersId>/<orderId>   { "data": { "status": "shipped" } }
```

The host-side **record-write event bus** sees an `orders` record `updated` with
the `status` field changed, evaluates the trigger's condition against the new
record, and fires the **Notify on status change** flow — which DMs the
customer:

```
bot → (to chat 555) "Update on your order: it is now "shipped"."
```

No one opened the canvas. The operator only touched data.

---

## Invariants this demo exercises

- **I2 — domain-agnostic core.** "product"/"order" appear only in template data
  and param strings; the engine and every node stay generic.
- **I4 — durable, server-state-free conversations.** The order conversation
  survives a full process restart with only SQLite as state.
- **I5 — one schema, every consumer.** Pack import reuses the same
  `CreateCollectionBody` and `FlowExport` shapes the panel/API already accept;
  no new validation surface.
- **Depth-1 loop guard.** A flow's own `data.collection` writes never re-trigger
  that same flow's `recordChanged` trigger.

## Gotcha worth remembering

The `collection.recordChanged` node is a pure **pass-through**: matching
(slug + event kind + field_filter + condition) and the loop guard all happen
**host-side** in the event bus. Its params — including the `condition`
expression string — are **host directives, not runtime templates for the
node**, so they are listed in `rawParamKeys` and the executor must **not**
`{{ }}`-evaluate them. (If it did, `condition` would resolve to a boolean and
fail its `z.string()` re-validation when the trigger node runs.)
