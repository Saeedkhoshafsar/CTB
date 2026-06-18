# CTB External Integration Protocol

> The contract for talking to CTB from the outside world — n8n, scripts, AI
> agents, other services — and for CTB talking back out. Completed across
> Phase 4 (P4-T1 … P4-T5).

CTB exposes three integration surfaces:

| Direction | Surface | Auth | Section |
|---|---|---|---|
| **In** | per-flow **Webhook Trigger** — fire a specific flow, optionally sync (wait for a reply) | unguessable path secret + optional HMAC | [§ Webhook Trigger](#inbound-webhook-trigger--p4-t1) |
| **In** | the **REST API v1** (`/api/v1/*`) — trigger flows, send messages, query users/executions — and the **MCP server** (`POST /api/v1/mcp`) for AI agents | `Authorization: Bearer ctb_…` | [§ REST API](#inbound-rest-api-token-auth--p4-t3) · [§ MCP server](#mcp-server--ctb-as-a-tool-surface--pc-t3) |
| **Out** | **instance webhooks** — CTB POSTs an event envelope to your URLs when things happen | optional HMAC signature CTB adds | [§ Outbound](#outbound-instance-webhooks--p4-t4) |

Two end-to-end **n8n recipes** (the canonical "open protocol" use case) are at
the bottom: [§ n8n recipes](#n8n-recipes).

### Conventions

- **Base URL.** Everything is relative to where the server runs
  (`http://localhost:3000` in dev; your own origin in prod). Examples use
  `$CTB` for that origin.
- **JSON in, JSON out.** Request bodies are `application/json`; so are
  responses (the Webhook Trigger sync mode is the one place YOU decide the
  response shape, via `flow.respondToWebhook`).
- **Error envelope.** Every 4xx/5xx from the REST API and the admin APIs is a
  uniform shape so callers can branch on `error` without parsing prose:

  ```json
  { "error": "flow_not_found", "message": "no flow with id …" }
  ```

  `error` is a stable machine code (snake_case); `message` is human prose that
  may change. The error codes used by each endpoint are listed inline below
  (e.g. `404 flow_not_found`, `401 invalid_token`).
- **Secrets (invariant I7).** Anything secret — API token plaintext, a webhook
  subscription's signing `secret` — is **write-only**: accepted on create,
  hashed/stored, and **never returned or logged**. Listings expose only a
  derived hint (a 10-char token prefix, or `hasSecret: true`).
- **Signatures.** Both the inbound HMAC option and every outbound delivery use
  the same convention: header `X-CTB-Signature: sha256=<hex>` where `<hex>` is
  `HMAC-SHA256(rawRequestBody, key)`. Verify against the **raw bytes**, before
  any JSON re-serialization.

## Inbound: Webhook Trigger ✅ P4-T1

```
POST /hooks/flow/:flowId/:secret
Content-Type: application/json

{ ...arbitrary payload... }   → becomes $json.body in the flow
```

The trigger item's `$json` is `{ body, headers, query, method }` (the parsed JSON
body, request headers with `authorization`/`cookie`/`x-ctb-signature` redacted,
the query object, and the HTTP method).

- **`:secret`** — an unguessable per-flow path secret derived from `CTB_SECRET`
  (`flowWebhookSecret(flowId)`, base64url HMAC; no DB column, stable across
  restarts). A mismatch — or an unknown flow id — returns `404` (no existence
  leak). `GET /api/flows/:id/webhook` returns the full URL + HMAC key for wiring.
- **Async mode (default):** responds `202 {"ok":true,"executionId":"..."}`
  immediately; the flow runs out-of-band.
- **Sync mode:** holds the request until a `Respond to Webhook` node parks
  `{status, headers, body}` (sent back as the HTTP response), or the trigger's
  `sync_timeout` (1–120s) elapses → `504`. The run **may pause on a
  `tg.waitForReply` in between** — the request keeps waiting while the user
  answers in Telegram and the flow resumes (this is the "n8n → CTB" recipe).
  If the run finishes with no respond node → `200 {"ok":true,"executionId","status"}`;
  if it's still parked on a wait when `sync_timeout` fires → `504`.
- **`target_chat` (optional):** by default a webhook-started run is **chatless**
  (`chatId=null`), so conversation nodes can't run. Set the trigger's
  `target_chat` to bind the run to a Telegram chat — either a literal chat id
  (`"555"`) or a reference into the request body
  (`$json.body.chat_id`). This is what lets a sync webhook *ask a user and
  return the answer*. An unresolvable value leaves the run chatless.
- **Optional HMAC:** when the trigger's `verify_signature` is on, the request
  must carry `X-CTB-Signature: sha256=<hex>` = `HMAC-SHA256(rawBody, hmacKey)`
  where `hmacKey = flowWebhookHmacKey(flowId)` (a SEPARATE derivation from the
  path secret). Missing/invalid → `401`.

## Inbound: REST API (token auth) ✅ P4-T3

The "open protocol" surface for n8n / scripts / AI agents. Every request carries
a **bearer token** (NOT the panel cookie) — these routes live under `/api/v1/`,
which the app's cookie guard skips; the v1 router installs its own bearer-auth
preHandler.

```
Authorization: Bearer ctb_<…>

GET   /api/v1/node-types                                   (PC-T1) node catalog
POST  /api/v1/flows                    { botId|bot_id, name, graph? }  (PC-T2) create
PATCH /api/v1/flows/:id                { name?, graph?, settings? }    (PC-T2) edit
POST  /api/v1/flows/:id/validate                                       (PC-T2) dry-run
POST  /api/v1/flows/:id/activate                                       (PC-T2) activate
POST  /api/v1/flows/:id/deactivate                                     (PC-T2) deactivate
POST  /api/v1/flows/:id/trigger        { chat_id?, payload? }
POST  /api/v1/bots/:id/send            { chat_id, text, parse_mode?, keyboard? }
GET   /api/v1/executions?flow_id=&bot_id=&status=&limit=
GET   /api/v1/users?bot_id=&limit=&offset=
POST  /api/v1/mcp                      JSON-RPC 2.0            (PC-T3) MCP server
```

### Tokens

Created/listed/revoked from the panel (admin only) via `/api/api-tokens`:

```
GET    /api/api-tokens                 → { tokens: ApiTokenPublic[] }
POST   /api/api-tokens                 { name, botId? } → 201 { apiToken: ApiTokenCreated }
DELETE /api/api-tokens/:id             → 204 (404 if unknown)
```

- A token is a `ctb_`-prefixed string. Only its **SHA-256 hash** + a 10-char
  display prefix are stored (invariant I7) — the plaintext is returned **once**,
  in the `POST` response (`apiToken.token`), and never again.
- `botId` is optional. `null` ⇒ **instance-wide** token. A non-null `botId`
  (must reference an existing bot, else `400 unknown_bot`) ⇒ **bot-scoped**: the
  token may only act on that bot. Any v1 request targeting a different bot —
  flow's bot, `:id`, `bot_id` filter, or users' `bot_id` — returns
  `403 token_not_authorized_for_bot`, and `GET /executions` is silently filtered
  to the token's own bot.
- A successful auth stamps `last_used_at` (best-effort). Missing/garbage header →
  `401 missing_bearer_token`; unknown hash → `401 invalid_token`.

### Endpoints

- **`GET /api/v1/node-types`** ✅ PC-T1 — the machine-readable **node catalog**:
  the public bearer-auth promotion of the panel's internal `/api/node-types`. It
  returns `{ nodeTypes: NodeTypeInfo[] }` where each entry is
  `{ type, category, meta:{ labelKey, descriptionKey?, icon? }, ports:{ inputs[], outputs[] }, paramsJsonSchema, role?, inputSlots?, provides? }`.
  This is the SAME projection the engine registry serves the editor, so the
  catalog can never advertise a node the engine can't run; an external
  builder/agent reads it to learn exactly what bricks exist (their JSON-Schema
  params, their data ports, and — for the AI tier — their typed sub-connection
  slots: a consumer's `inputSlots` and a provider's `role:'provider'`/`provides`).
  `meta.labelKey`/`descriptionKey` are the i18n keys whose fa/en human text lives
  in the editor catalog. Any valid token (instance-wide OR bot-scoped) may read
  it — the node library is identical for every bot, so nothing is bot-scoped
  here. The bytes are identical to the internal `/api/node-types`.
#### Flow authoring (PC-T2)

An external agent can **build and activate** a flow, not just trigger one — every
write reuses the SAME shared schemas + validator as the panel's flows API (I5),
so a v1-authored flow is identical to an editor-built one. A bot-scoped token may
only author on its own bot (`403 token_not_authorized_for_bot`).

- **`POST /api/v1/flows`** ✅ PC-T2 — create a **draft** flow. Body
  `{ botId | bot_id, name, graph? }` (snake_case `bot_id` is accepted as an alias
  of `botId`); `graph` defaults to an empty graph and is validated by
  `FlowGraphSchema`. `400 invalid_body` on a bad body, `400 unknown_bot` if the
  bot doesn't exist. `201 { flow }` (a fresh `version:1` draft). A draft is NOT
  activation-checked here — call `/validate` or `/activate` for that.
- **`PATCH /api/v1/flows/:id`** ✅ PC-T2 — edit `name` / `graph` / `settings`.
  A `graph` change snapshots the outgoing version (rollback stays available) and
  bumps `version`; editing an **active** flow's graph re-arms its cron schedules.
  `settings.errorHandlerFlowId` must reference another flow OF THE SAME BOT
  (`400 error_handler_self` / `400 error_handler_not_same_bot`).
  `404 flow_not_found`. `200 { flow }`.
- **`POST /api/v1/flows/:id/validate`** ✅ PC-T2 — **dry-run**: report the stored
  graph's activation problems WITHOUT changing anything. `422 invalid_graph` if
  the stored graph fails `FlowGraphSchema`; otherwise
  `200 { ok, problems:[…strings], nodeProblems:[{ nodeId, message }] }` (the same
  problem shape `/activate` returns on 422). `ok:true` ⇒ activatable.
- **`POST /api/v1/flows/:id/activate`** ✅ PC-T2 — validate + flip to active.
  `422 not_activatable { problems, nodeProblems }` if not activatable (the flow
  stays a draft); `422 invalid_graph` on a malformed stored graph;
  `200 { ok:true, status:"active" }`.
- **`POST /api/v1/flows/:id/deactivate`** ✅ PC-T2 — flip an active flow back to
  draft. `200 { ok:true, status:"draft" }` (idempotent on an already-draft flow).

- **`POST /api/v1/flows/:id/trigger`** — starts a flow run (async, like the
  webhook async mode). `404 flow_not_found`; `422 invalid_graph` / `422
  no_trigger_node` if the flow has no enabled trigger node. The trigger item is
  `$json = { source:"api", payload?, chat_id? }`; entry is the flow's first
  enabled `category:"trigger"` node. `chat_id` is optional (numeric string is
  coerced to a number; omitted ⇒ chatless run). Responds
  `202 { ok:true, executionId }`; poll `GET /api/v1/executions` for the outcome.
- **`POST /api/v1/bots/:id/send`** — sends a Telegram message through the bot's
  centralized rate-limited sender. `404 bot_not_found`; `409 bot_not_running`
  (the bot exists but isn't started, so there's no sender). `keyboard` uses the
  shared `KeyboardSchema` and is converted to a Telegram `reply_markup`.
  `200 { ok:true, messageId }`, or `502 send_failed` on a Telegram error.
- **`GET /api/v1/executions`** — newest-first list. Optional `flow_id`, `bot_id`,
  `status` (`running|waiting|done|error|canceled`, else `400 invalid_status`),
  `limit` (1–200, default 50). Returns
  `{ executions: [{ id, flowId, botId, chatId, status, error, startedAt, updatedAt }] }`.
- **`GET /api/v1/users`** — `bot_id` required (`400 bot_id_required`). Optional
  `limit`/`offset`. Returns
  `{ users: [{ id, botId, tgUserId, profile, tags, firstSeen, lastSeen, displayName }] }`.

## MCP server — CTB as a tool surface ✅ PC-T3

CTB also speaks **MCP** (Model Context Protocol) so an *external* AI agent
(Claude Desktop, an IDE assistant, another orchestrator) can discover the node
library and build/run flows programmatically — the **inverse** of the
`ai.mcpClient` node (P5-T3, where a CTB agent *consumes* a remote MCP server).

- **Transport:** streamable-HTTP — a single endpoint, **`POST /api/v1/mcp`**,
  speaking plain **JSON-RPC 2.0** (the wire format MCP is built on). No MCP SDK
  dependency: the protocol is implemented natively *inside* the same bearer-auth
  `/api/v1` scope, so it reuses the exact same token guard and the exact same
  engine capabilities as the REST routes above (**no surface drift, I5** — a flow
  built over MCP is byte-identical to one built over REST or in the editor).
- **Auth:** `Authorization: Bearer ctb_…`. A bot-scoped token is bounded to its
  bot on every tool exactly like the REST surface; missing/garbage token → `401`
  before any JSON-RPC is parsed.
- **Protocol version:** `2025-06-18`. `serverInfo` = `{ name:"ctb", version:"1" }`.

### Methods

- **`initialize`** → `{ protocolVersion, capabilities:{ tools }, serverInfo, instructions }`.
- **`notifications/initialized`** (and any notification — a message with no `id`)
  → `202`, no JSON-RPC body.
- **`ping`** → `{}`.
- **`tools/list`** → the six tools below, each with a JSON-Schema `inputSchema`.
- **`tools/call` `{ name, arguments }`** → an MCP result with a single JSON
  `content` text block. A *tool-level* problem (unknown bot, not found, bad args,
  bot-scope violation) sets `isError:true` on the result (the call succeeded, the
  tool reported a failure); a *protocol* problem (malformed JSON-RPC, unknown
  method, unknown tool) returns a JSON-RPC `error` (`-32600/-32601/-32602/-32603`).

### Tools

- **`list_nodes`** — the node catalog (the **same** projection as
  `GET /api/v1/node-types`): every node's `type`, `category`, `meta`, `ports`,
  `paramsJsonSchema`, and typed sub-connection surface. Bot-agnostic — any valid
  token may call it.
- **`validate_flow` `{ graph }`** — dry-run the activation check; returns
  `{ ok, problems[], nodeProblems[] }`. Nothing is saved.
- **`create_flow` `{ bot_id, name, graph? }`** — create a **draft** flow (same
  contract as `POST /api/v1/flows`, incl. the snake_case `bot_id` alias). Returns
  `{ flow:{ id, botId, name, status:"draft", version } }`. Activate it afterwards
  via the REST `/activate` route.
- **`trigger_flow` `{ flow_id, chat_id?, payload? }`** — start a run (async,
  fire-and-forget). Returns `{ ok:true, executionId }`; poll
  `GET /api/v1/executions` for the outcome. The item carries `source:"mcp"`.
- **`query_collection` `{ bot_id, collection, filter? }`** — read records from a
  bot Collection by slug; `filter` is the standard record filter
  (`where`/`sort`/`limit`/`offset`). Returns `{ records, total }`. Reports
  `collections_not_available` when no collection store is wired.
- **`send_message` `{ bot_id, chat_id, text, parse_mode? }`** — send a Telegram
  message through the bot's centralized rate-limited sender (`parse_mode` is
  `HTML`/`MarkdownV2`, matching the REST send surface). The bot must be running
  (`bot_not_running` otherwise). Returns `{ ok:true, messageId }`.

### Quick start (Claude Desktop / any MCP client)

Point the client at `https://<your-ctb-host>/api/v1/mcp` with an
`Authorization: Bearer ctb_…` header. The agent can then `list_nodes`,
`validate_flow`, `create_flow`, activate via REST, and `trigger_flow` —
assembling and running a CTB workflow end-to-end without the panel.

## Outbound: instance webhooks ✅ P4-T4

CTB POSTs an event envelope to subscribed URLs when something happens. A
subscription (`instance_webhooks`) is admin-managed from the panel and scoped
per-bot or instance-wide.

```
POST <your url>
Content-Type: application/json
X-CTB-Event: execution.finished
X-CTB-Signature: sha256=<hex>     # only when the subscription has a secret

{
  "event": "execution.finished | execution.failed | user.first_seen",
  "bot_id": "...",
  "flow_id": "..." | null,        // null for user.first_seen
  "execution_id": "..." | null,   // null for user.first_seen
  "chat_id": 123 | null,
  "at": "2026-06-14T00:00:00.000Z",
  "data": { }                     // event-specific payload
}
```

### Events

| Event | Fires when | `data` |
|---|---|---|
| `execution.finished` | a flow run reaches status `done` | `{ status, error, user_id, steps }` |
| `execution.failed` | a flow run reaches status `error` | `{ status, error, user_id, steps }` |
| `user.first_seen` | a brand-new end user is first observed | `{ tg_user_id, profile, first_seen }` |

### Subscriptions

Managed (admin only) via `/api/instance-webhooks`:

```
GET    /api/instance-webhooks            → { webhooks: InstanceWebhookPublic[] }
POST   /api/instance-webhooks            { name, url, secret?, events[], botId?, active? } → 201
PATCH  /api/instance-webhooks/:id        { …any subset… }   → { webhook }
DELETE /api/instance-webhooks/:id        → { ok:true }       (404 if unknown)
```

- `events` is a non-empty subset of the three event names above.
- `botId` is optional: `null`/omitted ⇒ all bots; a non-null id (must reference
  an existing bot, else `400 unknown_bot`) ⇒ only that bot's events.
- `secret` is **write-only** — accepted on create/update, never returned; the
  public projection exposes only `hasSecret` (I7). When set, every delivery
  carries `X-CTB-Signature: sha256=HMAC-SHA256(rawBody, secret)`.
- `active:false` keeps the subscription but suppresses delivery.

### Delivery semantics

- **Fire-and-forget:** an event source (a run finishing, a user being seen) is
  never blocked or failed by a slow/broken endpoint.
- **Retry:** up to 3 attempts with linear backoff on a transport error or a
  `5xx`/`408`/`429`; a `4xx` is treated as a bad request and not retried.
- Each attempt stamps `last_fired_at`; the last error (or `null` on success) is
  stored in `last_error` and surfaced in `InstanceWebhookPublic`.
- A `2xx` from your endpoint is success. Verify `X-CTB-Signature` to authenticate.

## n8n recipes

Two complete, copy-pasteable recipes. They cover both directions of the
boundary: n8n driving a CTB conversation and getting the answer back (recipe 1),
and a CTB flow calling out into an n8n workflow mid-run (recipe 2). The
🎬 Phase 4 demo ([`docs/demos/phase-4-n8n.md`](demos/phase-4-n8n.md)) is recipe 1
exercised end-to-end against a fake Telegram transport.

Throughout, `$CTB` is your CTB origin (e.g. `https://ctb.example.com`) and
`$N8N` is your n8n origin.

---

### Recipe 1 — n8n → CTB (sync): ask a Telegram user, get the answer back

**Goal.** An n8n workflow needs a human's answer. It hits a CTB flow, CTB asks
the user in Telegram, waits for the reply, and CTB returns that reply as the
HTTP response to n8n — all in one synchronous request.

```
n8n  ──HTTP Request──▶  CTB Webhook Trigger (sync)
                          │  tg.sendMessage "…question…"
                          │  tg.waitForReply        ← user types an answer
                          │  flow.respondToWebhook  { answer: {{ $json.text }} }
n8n  ◀──── HTTP 200 ──────┘  { "answer": "…the user's words…" }
```

#### 1. Build the CTB flow

Create a flow with these nodes and **activate** it:

| # | Node | Params |
|---|---|---|
| 1 | **Webhook Trigger** | `mode: sync`, `sync_timeout: 90` (seconds), optionally `verify_signature: true` |
| 2 | `tg.sendMessage` | text e.g. `Quick question from the office: {{ $json.body.question }}` — sent to `chat_id` (see note) |
| 3 | `tg.waitForReply` | parks the run until the user replies; the reply lands as `$json.text` |
| 4 | `flow.respondToWebhook` | status `200`, body `{ "answer": "{{ $json.text }}" }` |

> **Which chat?** A sync webhook run is *chatless* unless you give it a chat to
> talk to. The simplest pattern: n8n sends the target `chat_id` in the body
> (`{{ $json.body.chat_id }}`) and `tg.sendMessage` targets it. (For a "ask the
> admin" pattern, hard-code the admin chat in the node instead.)

#### 2. Get the trigger URL

```http
GET $CTB/api/flows/<flowId>/webhook
→ { "url": "$CTB/hooks/flow/<flowId>/<secret>", "hmacKey": "<key for X-CTB-Signature>" }
```

The `<secret>` is a stable, unguessable path secret derived from `CTB_SECRET`
(no DB column; survives restarts). `hmacKey` is only needed if you turned on
`verify_signature`.

#### 3. Wire the n8n side

Add an **HTTP Request** node in n8n:

- **Method:** `POST`
- **URL:** the `url` from step 2 — `$CTB/hooks/flow/<flowId>/<secret>`
- **Body (JSON):**
  ```json
  { "chat_id": 123456789, "question": "Approve invoice #42?" }
  ```
  CTB exposes this to the flow as `$json.body` (`$json.body.question`,
  `$json.body.chat_id`).
- **Options → Timeout:** set it **higher** than the flow's `sync_timeout`
  (e.g. 100 000 ms for a 90 s flow) so n8n doesn't abandon the call first.
- **If `verify_signature` is on:** compute `HMAC-SHA256(rawBody, hmacKey)` and
  send it as header `X-CTB-Signature: sha256=<hex>`. (In n8n, a small Function/
  Code node before the HTTP Request can build the header with the `crypto`
  module.)

#### 4. What n8n receives

The HTTP Request node blocks until the user answers (or the timeout fires):

```jsonc
// HTTP 200 — the body your flow's respondToWebhook produced
{ "answer": "Yes, approved." }
```

In the next n8n node, the user's words are `{{ $json.answer }}`.

**Timeouts & errors.** If the user never replies within `sync_timeout`, CTB
returns **`504`** and the run is left parked (it still resolves later when the
user answers, but n8n has already given up — handle the 504 in n8n). A bad
secret / unknown flow → **`404`**. A failed signature check → **`401`**.

---

### Recipe 2 — CTB → n8n: call an n8n workflow mid-flow and use its JSON

**Goal.** A CTB flow needs something n8n is good at — look up a record in a CRM,
post to Slack, run an LLM chain — in the middle of a conversation, then keep
going with whatever n8n returns.

```
CTB  ──http.request──▶  n8n Webhook node
                          │  …n8n does its thing…
                          │  Respond to Webhook  { price: 42, currency: "EUR" }
CTB  ◀──── JSON ─────────┘  → available as {{ $json.price }} in the next node
```

#### 1. Build the n8n workflow

- **Webhook** node — Method `POST`, **Respond:** `Using 'Respond to Webhook' node`.
  Copy its **Production URL** (e.g. `$N8N/webhook/lookup-price`).
- …your logic…
- **Respond to Webhook** node — Response Body = JSON, e.g.:
  ```json
  { "price": 42, "currency": "EUR" }
  ```
- **Activate** the n8n workflow (the production URL is live only when active).

#### 2. Add an `http.request` node to the CTB flow

| Param | Value |
|---|---|
| **Method** | `POST` |
| **URL** | `$N8N/webhook/lookup-price` |
| **Body** | JSON — e.g. `{ "sku": "{{ $json.sku }}" }` |
| **Headers** | add your n8n webhook auth here if the workflow requires it |

CTB's `http.request` runs per item via the host-limited HTTP capability. A JSON
response is **auto-spread into `$json`**, so n8n's `{ "price": 42 }` becomes
`{{ $json.price }}` directly in the next node. (Toggle `never_error` if you want
a non-2xx response to flow through as data rather than fail the run.)

#### 3. Continue the flow

The node after `http.request` sees n8n's payload merged into `$json`:

```
tg.sendMessage  →  "That SKU costs {{ $json.price }} {{ $json.currency }}."
```

**Auth & errors.** Secure the n8n webhook (n8n's Header Auth, or a shared
secret you check in the workflow) and send the matching header from the CTB
node. On a transport error or non-2xx, the run fails the node unless
`never_error` is set — branch on `$json` in that case.

---

### Quick reference

| You want… | Use | Auth |
|---|---|---|
| n8n to **trigger one specific flow** and (optionally) wait for the result | Webhook Trigger (recipe 1) | path secret + optional HMAC |
| n8n to **trigger a flow** generically, or **send a message** / **query** state | REST API v1 ([§ REST API](#inbound-rest-api-token-auth--p4-t3)) | `Bearer ctb_…` |
| a CTB flow to **call n8n** mid-run | `http.request` node (recipe 2) | whatever the n8n webhook needs |
| n8n to **react when a CTB run finishes / a user shows up** | instance webhooks ([§ Outbound](#outbound-instance-webhooks--p4-t4)) → an n8n Webhook node | CTB-supplied `X-CTB-Signature` |
