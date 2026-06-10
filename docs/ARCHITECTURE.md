# CTB Architecture

> Status: v0.1 — design document. This is the contract the codebase is built against.

## 1. Goals & non-goals

**Goals**

- A general-purpose, node-based automation engine specialized for **conversational** Telegram bots.
- n8n-grade developer experience: item pipeline, expressions, Code node, credentials, sub-flows, webhooks.
- Single-binary-feeling deploy: `docker compose up` or `npm start` with SQLite — no mandatory external services.
- Multi-bot: one CTB instance hosts many bot tokens, each with its own flows.

**Non-goals**

- No business-domain nodes in core (no shop/VPN/CRM nodes). Domain logic = flows + Code + HTTP + future plugins. *Structured user-defined data* is provided by the generic **Collections** layer (§13) — "product" is the user's data, never a CTB concept.
- Not a general workflow engine competing with n8n for non-chat automation. If a job is pure data plumbing, use n8n and connect it to CTB via webhooks.
- No visual theming/white-label concerns in v1.

## 2. Language & stack decision

**TypeScript everywhere.** Rationale:

| Concern | Decision | Why |
|---|---|---|
| Engine + API | Node.js 20+, TypeScript, Fastify | Single language with the editor; first-class async; huge ecosystem |
| Telegram | [grammY](https://grammy.dev) | Best-typed TG framework; webhook & polling; middlewares |
| Editor | React + [React Flow](https://reactflow.dev) | Industry standard for node canvases (n8n-like UX) |
| DB | SQLite (default) / Postgres via [Drizzle ORM](https://orm.drizzle.team) | Zero-config start, painless upgrade path |
| Code node sandbox | `worker_threads` + restricted realm (see §8) | In-process isolation with timeouts, no extra runtime |
| Validation | Zod schemas in `packages/shared` | One schema → server validation + editor forms + docs |
| Monorepo | npm workspaces + turborepo (optional) | Simple, no exotic tooling |

PHP is dropped entirely. The old project remains a UX reference only.

## 3. Repository layout

```
ctb/
├─ apps/
│  ├─ server/                 # Fastify app
│  │  ├─ src/
│  │  │  ├─ api/              # REST API for the editor (flows, bots, creds, executions)
│  │  │  ├─ telegram/         # grammY gateway: webhook receiver, update router, sender
│  │  │  ├─ triggers/         # schedule (cron), inbound webhook endpoints
│  │  │  └─ main.ts
│  └─ editor/                 # React SPA (Vite)
│     ├─ src/
│     │  ├─ canvas/           # React Flow canvas, node rendering, edges
│     │  ├─ panels/           # node config side panel (auto-generated from node schemas)
│     │  ├─ stores/           # zustand state
│     │  └─ api/              # typed client for server API
├─ packages/
│  ├─ shared/                 # types, zod schemas, node parameter definitions
│  ├─ core/                   # THE ENGINE (no Telegram, no HTTP — pure logic)
│  │  ├─ src/
│  │  │  ├─ engine/           # executor, scheduler of node steps, pause/resume
│  │  │  ├─ expression/       # {{ }} expression evaluator
│  │  │  ├─ registry/         # node type registry
│  │  │  ├─ store/            # execution/state persistence interfaces
│  │  │  └─ types.ts          # FlowItem, NodeDef, ExecutionState...
│  ├─ nodes/                  # built-in node implementations (depend on core)
│  └─ sandbox/                # Code-node isolated runner
├─ docs/
│  ├─ ARCHITECTURE.md         # this file
│  ├─ ROADMAP.md
│  ├─ NODES.md                # node-by-node specification
│  └─ PROTOCOL.md             # external integration protocol (webhooks in/out)
└─ docker/ docker-compose.yml Dockerfile
```

**Dependency rule:** `shared ← sandbox ← core ← nodes ← server` (Decision Log #12). The editor depends only on `shared` + server API. `core` never imports Telegram or Fastify — it executes flows against injected *services* (sender, storage, http), which makes it unit-testable and future-proof (e.g., a Discord gateway later).

## 4. Data model

```
bots          id, name, token(enc), mode(webhook|polling), status, settings(json)
flows         id, bot_id, name, status(draft|active), graph(json), version, updated_at
flow_versions id, flow_id, version, graph(json), created_at        -- history / rollback
credentials   id, name, type, data(encrypted json)
executions    id, flow_id, bot_id, chat_id, user_id, status(running|waiting|done|error|canceled),
              cursor(node_id), state(json: items, vars), wait(json: what we wait for, timeout_at),
              started_at, updated_at
exec_logs     id, execution_id, node_id, level, input(json), output(json), error, duration_ms, ts
kv_store      bot_id, scope(user|bot|flow), scope_id, key, value(json), updated_at
users         id, bot_id, tg_user_id, profile(json), tags(json), first_seen, last_seen

-- Collections layer (§13) — user-defined structured data
collections   id, bot_id, slug, name, icon, schema(json: CollectionSchema), display(json: list/form hints),
              version, created_at, updated_at
records       id, collection_id, data(json), created_at, updated_at, created_by(admin|flow:<id>)
files         id, bot_id, kind(local|tg_file_id), path_or_file_id, mime, size, created_at
```

Key decisions:

- **`flows.graph`** is one JSON document: `{ nodes: [...], edges: [...] }` — exactly what the canvas edits. Engine consumes the same structure (no compile step in v1).
- **`executions` is the heart of pause/resume.** When a flow hits `Wait for Reply`, the executor serializes `{cursor, items, vars, wait}` and exits. The Telegram router later matches an incoming update to a waiting execution (`bot_id + chat_id`, plus optional filters) and resumes.
- **One waiting execution per chat per flow** (configurable policy: replace | queue | ignore new triggers while waiting).
- Credentials encrypted with AES-256-GCM, key from `CTB_SECRET` env.

## 5. The item pipeline (n8n-compatible mental model)

Every connection carries an **array of items**:

```ts
interface FlowItem {
  json: Record<string, unknown>;   // the payload
  binary?: Record<string, BinaryRef>; // file refs (Telegram file_id or stored blob)
}
```

- A Telegram trigger emits one item: `{ json: { update, message, user, chat, text, ... } }`.
- Most Telegram nodes operate per-item; Loop/Merge manipulate the array, like n8n.
- Node output = `FlowItem[]` per output port (IF/Switch have multiple ports).

**Execution-scoped variables** (`$vars`) live next to the pipeline for conversation state (answers collected so far), because in chat flows "the conversation" matters more than "the items". Both are persisted in `executions.state`.

## 6. Expression engine

Any string parameter may contain `{{ expression }}`. Implementation: a safe evaluator (JS subset via the sandbox, single-line, 50ms budget) with this scope:

| Variable | Meaning |
|---|---|
| `$json` | first input item's json (per-item when node maps over items) |
| `$items` | all input items |
| `$vars` | execution variables (set by Set/Code/Wait nodes) |
| `$user` | CTB user record for this chat (profile, tags, kv) |
| `$chat` | Telegram chat info |
| `$execution` | id, startedAt |
| `$flow` | id, name |
| `$env` | whitelisted instance settings |
| `$now` | Date now; helpers like `$now.format('YYYY-MM-DD')` |

Plus helpers: `$kv.get(key)`, `$json.path?.to?.field`, standard JS string/number/array methods (sandbox-enforced, no I/O).

## 7. Execution engine (pause/resume)

```
trigger fires ──► create execution (status=running)
   loop:
     node = graph[cursor]
     out  = await nodeImpl.execute(ctx, params, items)
     ├─ out = items → push to next node(s) via edges, advance cursor
     ├─ out = WAIT(spec) → persist state, status=waiting, RETURN
     ├─ out = GOTO(nodeId) → jump
     └─ out = END / ERROR → finalize, log

telegram update arrives ──► router:
   1. is some execution waiting on (bot, chat) and update matches wait-spec?
        yes → deserialize state, inject update as the wait node's output, resume loop
   2. else → does update match a flow trigger? → start new execution
   3. else → optional default-reply behavior per bot
```

Engine guarantees:

- **Durability:** state persisted at every wait and every N nodes (checkpoint), so a crash resumes cleanly.
- **Timeouts:** `wait.timeout_at` scanned by the scheduler; on timeout, execution resumes through the wait node's *timeout* output port.
- **Loop safety:** max steps per execution (default 1000) and max execution wall-time.
- **Concurrency:** per-chat mutex — one execution actively running per chat at a time.

## 8. Code node sandbox

The Code node runs **real JavaScript** with the same scope as expressions plus async APIs:

```js
// available inside Code node
$items, $json, $vars, $user, $kv
await $http.get(url, opts)            // outbound HTTP (rate/size limited)
await $bot.sendMessage(text, opts)    // shortcut sender (optional capability)
return items;                          // → next node
```

Isolation strategy (v1): dedicated `worker_threads` pool; each run gets a fresh realm with a frozen global, no `require/process/fs`; capabilities (`$http`, `$bot`) are injected proxies that hop back to the host over MessagePort, where limits are enforced. Hard timeout (default 10s), memory cap per worker. v2 option: out-of-process runner or `isolated-vm` for hostile-multi-tenant deployments.

## 9. Telegram gateway

- One Fastify route `/tg/:botId/:secret` per bot in webhook mode; long-polling supported for dev/no-domain setups.
- **Outbound sender** is centralized: per-bot token-bucket rate limiting (respect 429 + retry_after), message splitting, parse-mode safety, file uploads.
- Updates are normalized into a `TgEvent` (message/callback/command/contact/photo/...) before hitting the trigger router, so nodes never parse raw updates.

## 10. External integration protocol (the "plays well with n8n / AI" part)

- **Inbound:** every flow can expose `POST /hooks/flow/:flowId/:secret` (Webhook Trigger). Payload becomes `$json`. Optional sync mode: HTTP response is produced by a `Respond to Webhook` node.
- **Outbound:** HTTP Request node + `$http` in Code node, with credentials.
- **Events out (later):** instance-level outgoing webhooks for `execution.finished`, `user.first_seen`, etc.
- **MCP/AI (later phase):** LLM Chat node (OpenAI-compatible base URL → works with OpenAI/Anthropic-proxy/OpenRouter/local), then MCP client node that lists a server's tools and exposes them to an Agent node.

Details live in `docs/PROTOCOL.md` (written in Phase 4).

## 11. Security model

- Panel auth: single admin (env credentials) in v1; sessions via signed cookies. Multi-user later.
- Bot tokens & credentials encrypted at rest (AES-256-GCM, `CTB_SECRET`).
- Webhook endpoints carry unguessable secrets; optional HMAC signature verification.
- Code node: capability-injection only, no ambient authority (see §8). `$http` has an allow/deny-list config per instance.
- All editor API behind auth; CORS locked to the editor origin.

## 12. Testing strategy

- `core`: pure unit tests (engine stepping, pause/resume serialization round-trips, expression eval).
- `nodes`: contract tests per node (given params+items → expected output) — node specs in NODES.md double as test fixtures.
- e2e: spin server with SQLite memory + grammY test transformer (no real Telegram), drive a flow through trigger→wait→resume→end.

## 13. Collections — schema-driven structured data + auto-generated admin UI

> **The problem this solves:** a non-technical operator (the "manager") must be able to manage
> structured business data — products with color/size variants and price deltas, shipping methods,
> orders — through a clean CRUD panel **without ever seeing the flow canvas**, while CTB core stays
> 100% domain-agnostic (invariant I2). The answer is the *Directus/PocketBase pattern*: data first,
> UI generated from schema. We deliberately do NOT model admin UI as workflow nodes — a panel is a
> layout *tree*, a flow is a logic *graph*; mixing them produces the worst of both.

### 13.1 Concept

A **Collection** is a user-defined "table": a name + a field schema, created in the panel with a
visual schema builder (no code, no migration written by the user). CTB renders, from that schema
alone:

1. an **auto-generated CRUD panel** (list view with search/filter/sort + record form), and
2. a **REST surface** (`/api/collections/:slug/records`, admin-session or API-token auth), and
3. a generic **`data.collection` node** so flows query/write the same data (spec in NODES.md).

Same trick as node config panels: one schema → one form generator → many consumers (invariant I5
extended: *Collection schemas are Zod-validated documents; the admin form, the API validation, and
the node's runtime validation all derive from the same definition*).

### 13.2 Field types (v1)

```
text, longText, richTextLite, number, boolean, select(options), multiSelect,
date, dateTime, image (file ref), file, json (raw, escape hatch),
relation       → one|many → another collection in the same bot
group          → repeating sub-group of fields (rows inside the record)
```

`group` is the workhorse for variant-style data: a `products` collection holds a `variants` group
(color: select, size: select, price_delta: number, stock: number) — the manager edits variants as
rows inside the product form. `relation` covers shared entities (e.g. `shipping_methods`). Both
patterns stay generic; CTB never knows what a "variant" is.

Each field carries: `key, type, label (i18n-able), required, default, validation (regex/min/max),
helpText, showInList (bool)`. Display hints (list columns, sort default) live in `collections.display`.

### 13.3 Storage model — JSON documents, not dynamic DDL

Records are stored as **JSON documents** in one `records` table (`data` column), validated against
the collection's Zod schema on every write. We do NOT issue `CREATE TABLE`/`ALTER TABLE` per user
collection (the PocketBase approach) because:

| | JSON-document (chosen) | Dynamic DDL |
|---|---|---|
| Schema edits | instant, no migration engine | needs online ALTER machinery, lock risk |
| `group` fields | native (nested array) | requires child tables + joins |
| Engine complexity | one Drizzle table | a migration planner inside CTB |
| Query speed | fine for bot-scale data (≤ ~100k records) with SQLite `json_extract` indexes | faster at warehouse scale we don't target |

Mitigations: per-collection **computed indexes** on hot fields (SQLite expression indexes on
`json_extract(data,'$.field')`, declared in the schema builder as "indexed" toggle), and a hard
documented expectation: Collections is bot-scale operational data, not analytics storage. Schema
changes are **additive-safe** (new fields default-filled at read time); destructive changes
(remove/retype field) prompt with a record-count warning and lazy-migrate on write.

### 13.4 Query model

One filter shape used by the API, the panel, and the `data.collection` node:

```ts
{ where:  [{ field, op: eq|ne|gt|gte|lt|lte|contains|in|exists, value }],  // AND rows; OR via groups
  sort:   [{ field, dir }], limit, offset }
```

Compiled to SQLite `json_extract` SQL by one query builder in `apps/server`. Expressions are
allowed in node-side filter values (`{{ $vars.chosen_color }}`).

### 13.5 Admin panel & roles

- The editor app gets a **Data section**: collection list → auto-generated list view + record form.
  Forms reuse the Phase-2 schema-driven form engine (P2-T3) — that engine must therefore be built
  collection-aware (widget registry keyed by field type, not hardcoded to node params).
- **Operator role** (the manager): a second auth role that sees ONLY the Data section (and later,
  dashboards) — never bots/flows/executions. This is the minimal multi-user step pulled forward
  from P6; full RBAC stays in P6.
- RTL/fa first-class, as everywhere.

### 13.6 Flows ↔ Collections ↔ events

- Flows read/write records via `data.collection` (find/get/insert/update/delete/count).
- **Record-change trigger** (`collection.recordChanged`): a flow can start when a record is
  created/updated/deleted *from the panel or API* (e.g. order status flipped to "shipped" → flow
  messages the customer). Flow-originated writes can opt out of re-triggering (`suppress_events`)
  to prevent loops; trigger-side guard: max trigger depth 1 per write chain.
- Carts and other per-conversation state remain in `kv_store`; Collections is for durable,
  manager-visible entities. Rule of thumb documented for users: *if the manager should see it in a
  table, it's a collection; if only the conversation needs it, it's KV.*

### 13.7 What stays out (v1)

- No free-form page/dashboard builder yet (P6+ candidate: declarative "Views" composed of
  table/stat/button blocks bound to collections). CRUD covers the 80%.
- No per-record file blobs beyond images/files referenced via the `files` table (local disk dir or
  Telegram `file_id` reuse).
- No cross-bot collections; a collection belongs to one bot.
