# CTB External Integration Protocol

> The contract for talking to CTB from the outside world — n8n, scripts, AI
> agents, other services — and for CTB talking back out. Built across Phase 4
> (P4-T1 … P4-T5, the integration surfaces) and Phase C (PC-T1 … PC-T5, the open
> **builder** surface — discover the node library and assemble flows from outside).

CTB exposes three integration surfaces:

| Direction | Surface | Auth | Section |
|---|---|---|---|
| **In** | per-flow **Webhook Trigger** — fire a specific flow, optionally sync (wait for a reply) | unguessable path secret + optional HMAC | [§ Webhook Trigger](#inbound-webhook-trigger--p4-t1) |
| **In** | the **REST API v1** (`/api/v1/*`) — discover nodes, author/validate/activate flows, trigger flows, send messages, query users/executions — and the **MCP server** (`POST /api/v1/mcp`) for AI agents | `Authorization: Bearer ctb_…` | [§ REST API](#inbound-rest-api-token-auth--p4-t3) · [§ MCP server](#mcp-server--ctb-as-a-tool-surface--pc-t3) |
| **Out** | **instance webhooks** — CTB POSTs an event envelope to your URLs when things happen | optional HMAC signature CTB adds | [§ Outbound](#outbound-instance-webhooks--p4-t4) |

The **[§ Authoring & MCP](#authoring--mcp--building-flows-from-outside--pc-t5)**
chapter ties the catalog + authoring + MCP endpoints into one
*discover → build → validate → activate → trigger* lifecycle (with `curl` + MCP
recipes); two end-to-end **n8n recipes** (the canonical "open protocol" use case)
are at the bottom: [§ n8n recipes](#n8n-recipes).

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
GET   /api/v1/audit?bot_id=&token_id=&limit=               (PD-T3) audit trail
POST  /api/v1/mcp                      JSON-RPC 2.0            (PC-T3) MCP server
```

### Tokens

Created/listed/revoked from the panel (admin only) via `/api/api-tokens`:

```
GET    /api/api-tokens                 → { tokens: ApiTokenPublic[] }
POST   /api/api-tokens                 { name, botId?, rateLimitPerMin? } → 201 { apiToken: ApiTokenCreated }
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
- `rateLimitPerMin` is optional (default **120**, `0` = unlimited) — the
  per-token request cap (see [Rate limiting & audit](#rate-limiting--audit-pd-t3)).
- A successful auth stamps `last_used_at` (best-effort). Missing/garbage header →
  `401 missing_bearer_token`; unknown hash → `401 invalid_token`.

### Rate limiting & audit ✅ PD-T3

The bearer surface is hardened with a **per-token rate limit** and an
**append-only audit log** — both owned by the host (the bearer edge never sees
either; invariant I6).

- **Rate limiting.** Every token carries `rateLimitPerMin` (default 120). The
  bearer-auth preHandler checks an in-memory **sliding window** (60 s) keyed by
  the token; once a token exceeds its cap in the window, the request is refused
  with `429 { error:"rate_limited", retryAfterSec }` **and** an RFC-7231
  `Retry-After` (seconds) header. `0` = unlimited. The window is process-local —
  the right scope for CTB's single-process architecture, and a restart simply
  resets the windows (it can never *under*-count within a window). A rejected
  check does **not** record a hit (so a blocked caller doesn't push its own
  recovery further out), and a rate-limited call is **not** audited (it never
  reached an authenticated handler).
- **Audit log.** Every **authoring / trigger / send** call writes one row to
  `api_audit` (the host owns the table): `{ id, tokenId, botId, action, method,
  route, targetId, status, ts }`. `botId` is the **target** bot the call acted
  on (resolved from the body / flow / path — not the token's scope), `action` is
  the logical operation (`flow.create`, `flow.update`, `flow.validate`,
  `flow.activate`, `flow.deactivate`, `flow.trigger`, `bot.send`), and `status`
  is the response code — so a `403`/`422` is recorded just like a `201`/`202`.
  Plain reads (`node-types`, `executions`, `users`, `audit` itself) are **not**
  audited; MCP calls audit themselves inside the JSON-RPC handler scope.
- **`GET /api/v1/audit`** — read the trail, newest-first. Optional `bot_id`,
  `token_id`, `limit` (1–500, default 100). An **instance-wide** token sees all
  entries (optionally narrowed by `bot_id`); a **bot-scoped** token is locked to
  its own bot's entries (asking for another bot → `403`). Returns
  `{ entries: ApiAuditEntry[] }`.

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
  - **In-panel docs site ✅ PD-T4.** The same catalog (via the panel's internal
    `/api/node-types`) is rendered as a browsable, bilingual (fa/en) reference at
    the editor's **`/docs`** route ("Node Library" in the nav). Nothing is
    hardcoded: a pure transform groups every node by category and shows its
    params (key, required, type summary, default, description — derived from the
    same `paramsJsonSchema`), ports, and typed-connection facts, with a free-text
    search. It's the human face of this endpoint — "the work is already done,
    just connect them," made browsable.
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
- **`GET /api/v1/audit`** ✅ PD-T3 — the authoring/trigger/send **audit trail**,
  newest-first (`{ entries: ApiAuditEntry[] }`). Optional `bot_id`, `token_id`,
  `limit` (1–500, default 100). Scoped like every other read: an instance-wide
  token sees all (filterable by `bot_id`); a bot-scoped token is locked to its
  own bot (`403` on another bot). See [Rate limiting & audit](#rate-limiting--audit-pd-t3).

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

## Authoring & MCP — building flows from outside ✅ PC-T5

Phase C gives an external system — an n8n flow, a deploy script, or an AI agent
(over MCP) — everything it needs to **discover the node library and assemble,
validate, activate, and run a CTB flow without ever opening the editor**. This
chapter ties the PC-T1…PC-T3 endpoints into one lifecycle and shows two
copy-pasteable recipes.

> The whole lifecycle below is exercised end-to-end against the **real** wired
> engine + a fake Telegram transport by
> [`apps/server/test/e2e-phaseC-authoring-demo.test.ts`](../apps/server/test/e2e-phaseC-authoring-demo.test.ts)
> (walkthrough: [`docs/demos/phase-C-authoring.md`](demos/phase-C-authoring.md)).
> Run it with:
>
> ```bash
> npm run test --workspace=@ctb/server -- e2e-phaseC-authoring-demo
> ```

### The lifecycle: discover → build → validate → activate → trigger

```
            ┌──────────────────────── the same bearer token throughout ───────────────────────┐
  DISCOVER  GET  /api/v1/node-types                 → the catalog: every node's type, ports,
                                                       JSON-Schema params, and AI slot surface
     BUILD  POST /api/v1/flows  { bot_id, name,     → a DRAFT flow assembled from ONLY catalog
                                  graph }              node types (status:"draft", version:1)
  VALIDATE  POST /api/v1/flows/:id/validate         → dry-run; { ok, problems, nodeProblems },
                                                       nothing saved — fix until ok:true
  ACTIVATE  POST /api/v1/flows/:id/activate         → 200 { status:"active" }  (or 422 with the
                                                       problem list; the flow stays a draft)
   TRIGGER  POST /api/v1/flows/:id/trigger          → 202 { executionId } (async)
      POLL  GET  /api/v1/executions?flow_id=:id     → watch status reach done | error
            └──────────────────────────────────────────────────────────────────────────────────┘
```

Two invariants make this safe to automate:

- **The catalog is the single source of truth (I5).** `GET /api/v1/node-types`
  is the *same* projection the editor and the engine registry use, so a node it
  doesn't advertise cannot run. A graph referencing an unknown type (a domain
  node like `shop.checkout` that, by **I2**, doesn't exist) fails `validate`
  (`ok:false`) and `activate` (`422 not_activatable`) — you can never activate a
  flow the engine can't execute.
- **A v1-authored flow is byte-identical to an editor-built one (I5).** `create`
  / `validate` / `activate` reuse the panel's exact shared schemas + validator,
  so a flow assembled by a script behaves identically to one drawn on the canvas.

The same five steps are available over **MCP** (PC-T3): `list_nodes` =
`GET /node-types`, `validate_flow` = `/validate`, `create_flow` = `POST /flows`,
`trigger_flow` = `/trigger`; activation is the REST `/activate` route. An MCP
client (Claude Desktop, an IDE assistant) points at `POST /api/v1/mcp` and walks
the identical lifecycle.

### Recipe A — a script builds a flow with `curl`

`$CTB` is your CTB origin; `$TOK` a bearer token; `$BOT` a bot id.

```bash
# 1. DISCOVER — learn the node types + their params (jq to scan the catalog)
curl -s $CTB/api/v1/node-types -H "Authorization: Bearer $TOK" \
  | jq '.nodeTypes[] | {type, category, inputs: .ports.inputs}'

# 2. BUILD — assemble a 3-node draft from catalog types only
FLOW=$(curl -s $CTB/api/v1/flows -H "Authorization: Bearer $TOK" \
  -H 'Content-Type: application/json' -d '{
    "bot_id": "'"$BOT"'",
    "name": "agent-built greeting",
    "graph": {
      "nodes": [
        { "id":"trig", "type":"flow.manualTrigger", "params":{ "sample":"{}" },
          "position":{ "x":0,"y":0 }, "disabled":false },
        { "id":"compose", "type":"data.setFields",
          "params":{ "fields":[ { "target":"json","name":"greeting",
            "value":"Hello from a script 👋","op":"set" } ] },
          "position":{ "x":220,"y":0 }, "disabled":false },
        { "id":"send", "type":"tg.sendMessage",
          "params":{ "chat_id":"555","text":"{{ $json.greeting }}" },
          "position":{ "x":440,"y":0 }, "disabled":false }
      ],
      "edges": [
        { "id":"e1","from":{ "node":"trig","port":"main" },"to":{ "node":"compose","port":"main" } },
        { "id":"e2","from":{ "node":"compose","port":"main" },"to":{ "node":"send","port":"main" } }
      ]
    }
  }' | jq -r '.flow.id')

# 3. VALIDATE — dry-run (expect { "ok": true })
curl -s $CTB/api/v1/flows/$FLOW/validate -H "Authorization: Bearer $TOK" -X POST | jq

# 4. ACTIVATE — flip the draft to active
curl -s $CTB/api/v1/flows/$FLOW/activate -H "Authorization: Bearer $TOK" -X POST | jq

# 5. TRIGGER — run it, then poll for the result
EXEC=$(curl -s $CTB/api/v1/flows/$FLOW/trigger -H "Authorization: Bearer $TOK" \
  -H 'Content-Type: application/json' -d '{ "chat_id": 555 }' | jq -r '.executionId')
curl -s "$CTB/api/v1/executions?flow_id=$FLOW" -H "Authorization: Bearer $TOK" \
  | jq '.executions[] | select(.id=="'"$EXEC"'") | .status'   # → "done"
```

The run sends `Hello from a script 👋` to chat `555` through the bot's
centralized rate-limited sender — the `{{ $json.greeting }}` expression resolved
against the `data.setFields` output, exactly as it would in an editor-built flow.

### Recipe B — an AI agent builds a flow over MCP

Point an MCP client at `POST /api/v1/mcp` (bearer token). A typical agent turn:

```
1. tools/call  list_nodes {}
      → scan the catalog; pick flow.manualTrigger + data.setFields + tg.sendMessage
2. tools/call  validate_flow { "graph": { …the assembled 3-node graph… } }
      → { ok: true }   (iterate on the graph until ok)
3. tools/call  create_flow   { "bot_id": "$BOT", "name": "agent flow",
                               "graph": { …the validated graph… } }
      → { flow: { id, status: "draft" } }
4. (activate)  POST /api/v1/flows/<id>/activate        # REST — MCP create makes a draft
5. tools/call  trigger_flow  { "flow_id": "<id>", "chat_id": 555 }
      → { executionId };  then GET /api/v1/executions to confirm "done"
```

`validate_flow` lets the agent **self-correct before committing** — it returns
the same `{ ok, problems, nodeProblems }` shape as the REST `/validate`, so a
model can read a `nodeProblems[].message`, fix the offending node's params, and
re-validate, never persisting a broken flow.

### Quick reference — which surface for which job

| You want… | Use | Endpoint(s) |
|---|---|---|
| to **see what bricks exist** (types, params, slots) | catalog | `GET /api/v1/node-types` · MCP `list_nodes` |
| to **assemble a flow** from outside | authoring | `POST /api/v1/flows` · MCP `create_flow` |
| to **check before committing** | dry-run validate | `POST /api/v1/flows/:id/validate` · MCP `validate_flow` |
| to **make a flow live** | activate | `POST /api/v1/flows/:id/activate` |
| to **run a flow now** | trigger | `POST /api/v1/flows/:id/trigger` · MCP `trigger_flow` |
| to **watch the outcome** | poll | `GET /api/v1/executions?flow_id=` |
| to **let an AI agent do all of the above** | MCP | `POST /api/v1/mcp` ([§ MCP server](#mcp-server--ctb-as-a-tool-surface--pc-t3)) |

## Live voice — real-time Telegram calls ✅ PE

Phase E adds **live voice**: a flow can *hear* a caller, *reason*, and *speak
back in real time* on a Telegram call — in two scenarios served by the **same
nodes** (behaviour is config, not forks — invariant I2):

1. **AI voice support** — a Channel-Direct **1:1 voice call** an AI answers live.
2. **Channel Q&A moderator** — a group / channel **live voice broadcast**
   (پخش زنده) with a turn-taking line (`mode:'lineup'`).

> 🎬 Both, built end-to-end from generic nodes and run on the real engine, are
> documented in `docs/demos/phase-E-voice.md`. The node reference is `docs/NODES.md`
> → **"Live voice"** (`trigger.callEvent` + the six `call.*` actions).

### Why a separate transport

Telegram's **Bot API has no call methods at all** — a bot token cannot join or
stream a voice chat. Live audio therefore rides **MTProto over a Telegram USER
session + WebRTC**, not the Bot API. CTB isolates that entire native dependency
behind a single host-side `VoiceConnector` interface (invariant I3): `core` and
`nodes` never import it. A flow only ever calls the typed **`ctx.call`**
capability — it never holds a media socket (invariant I4). The long-lived
**Call Session Service** (a sibling of the Scheduler) owns each connection, the
inbound-audio VAD sink, and the per-call turn/queue state.

### Connector kinds — "one interface, many adapters"

The media engine is chosen **only** by the referenced `voiceConnection`
credential's `kind`, never by node type:

| `kind` | Transport | Required fields | Notes |
|---|---|---|---|
| `userbot` | MTProto USER session + WebRTC (e.g. a `pytgcalls`/`ntgcalls` engine) | `apiId`, `apiHash`, `session` | The real production adapter. A **user** account joins the call on the bot's behalf. |
| `companion` | Same as `userbot`, kept distinct so a host can run a dedicated "companion" account | `apiId`, `apiHash`, `session` | Same resolution + fields as `userbot`. |
| `external` | An out-of-process bridge service the host calls | `bridgeUrl` (+ optional `bridgeToken`) | For hosts that run the media engine as a separate sidecar/service. |
| *(default)* `loopback` | In-memory, dependency-free echo connector | — | Ships as the safe default + the test connector. No secrets, no sockets; a host with no native engine still boots and the whole runtime is testable. |

Resolution is **fail-closed** (`resolveVoiceConnection`, PE-T1): a credential
that is not a `voiceConnection`, or is missing a field its `kind` requires,
throws a **clear, secret-free** error rather than yielding a half-configured
connector that fails mid-call. Swapping the loopback for the userbot adapter is a
one-line change at the composition root — **zero** node/flow change (I2/I3).

### The `voiceConnection` credential

```jsonc
// kind: 'userbot' | 'companion'
{
  "type": "voiceConnection",
  "kind": "userbot",
  "apiId": 123456,                 // MTProto app id  (my.telegram.org)
  "apiHash": "…",                  // MTProto app hash         — encrypted at rest (I7)
  "session": "1Ab…"               // MTProto USER session string — NEVER logged (I6/I7)
}
// kind: 'external'
{ "type": "voiceConnection", "kind": "external",
  "bridgeUrl": "https://voice-bridge.internal", "bridgeToken": "…" }
```

The secret `session` / `apiHash` / `bridgeToken` are **encrypted at rest** and
stay **host-side only** — they are decrypted by the host when it resolves the
credential and never reach node code, which only ever sees a `credentialId`
(invariants I6/I7). The panel's **"test connection"** route —
`POST /api/credentials/:id/voice-health` — decrypts host-side, validates
fail-closed, and (with a real adapter wired) probes the login; the response is
always leak-free: `{ ok, kind, account?, error? }`.

### Hard caps (host safety)

A live call is an open socket, so the Call Session Service enforces tunable hard
caps (safe defaults): max concurrent calls host-wide (`25`), max concurrent
calls per bot (`5`), and max wall-clock seconds per call (`3600`, then
auto-leave). Exceeding a cap fails `connect` **loudly** (a node surfaces it)
rather than silently overloading the host.

### Telegram Terms-of-Service posture ⚠️

Because live voice needs a **user account** (MTProto) — the Bot API cannot do
it — operating this feature carries obligations the host operator owns:

- **Use a session you are authorized to use.** The `session` must come from an
  account the operator controls and has consent to automate. Automating a third
  party's account, or joining calls without participants' awareness, is not
  acceptable.
- **Respect Telegram's Terms of Service and local law** on automation and on
  recording/processing calls. Participants should be informed that an automated
  agent is on the call (e.g. the moderator greeting in the Q&A demo doubles as
  disclosure).
- **CTB ships no session and dials nothing by default.** The default connector
  is the in-memory `loopback`; a real call happens only after an operator
  deliberately supplies a `userbot`/`external` `voiceConnection` credential.
- **Secrets stay host-side and encrypted** (I6/I7). CTB never logs the session
  and never exposes it to flow/node code.

> In short: live voice is **opt-in, operator-configured, and accountable**. The
> platform provides the mechanism behind a clean interface; the operator is
> responsible for using it within Telegram's ToS and applicable law.

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
