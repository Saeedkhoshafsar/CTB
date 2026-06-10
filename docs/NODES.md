# CTB Node Specifications

> Each node is defined by: **inputs/outputs**, **parameters** (this is what the editor side-panel renders, generated from the node's Zod schema), and **behavior**. All string parameters accept `{{ expressions }}` unless noted.

Legend: `M` = MVP (Phase 2), `+` = post-MVP phase noted in ROADMAP.

---

## Triggers

### Telegram Trigger `M`
Starts a flow from a Telegram update.

- **Outputs:** 1 (`main`)
- **Parameters:**
  - `event`: `command` | `text` | `button_click` | `any_message` | `photo` | `document` | `contact` | `location` | `chat_join`
  - `command` (when event=command): e.g. `/start` — supports deep-link payload → `$json.payload`
  - `pattern` (when event=text): exact | contains | regex
  - `button_key` (when event=button_click): matches `Menu` node buttons marked as *global*
- **Emits:** `{ json: { text, user{id,first_name,last_name,username,lang}, chat{id,type}, message_id, payload?, raw } }`
- Multiple Telegram Triggers per bot allowed; most-specific match wins (command > button > text-pattern > any_message). Conflicts shown in editor.

### Webhook Trigger `+P4`
- `POST /hooks/flow/:flowId/:secret`; body → `$json`. Modes: async (202 immediately) | sync (wait for `Respond to Webhook` node, with timeout).
- Param `target_chat`: expression resolving which chat the conversation nodes talk to (e.g. `{{ $json.chat_id }}`) — required if flow contains Telegram nodes.

### Schedule Trigger `+P4`
- `cron` expression + timezone. Optional `for_each_user` mode: emit one item per known bot user (rate-limited fan-out).

### Record Changed Trigger `+P3.5` (`collection.recordChanged`)
Starts a flow when a record in a Collection is created/updated/deleted (from the admin panel, the records API, or another flow — unless that write set `suppress_events`).

- **Outputs:** 1 (`main`)
- **Parameters:**
  - `collection`: collection selector
  - `events`: subset of `created | updated | deleted`
  - `field_filter` (optional, for `updated`): only fire when one of these fields actually changed
  - `condition` (optional): expression on the new record, e.g. `{{ $json.record.status === 'shipped' }}`
- **Emits:** `{ json: { event, record, previous? (updated only), source: 'panel'|'api'|'flow' } }`
- No implicit chat: flows using Telegram nodes must resolve a chat themselves (e.g. `chat` expression on Send Message reading `{{ $json.record.customer_chat_id }}`), same rule as Webhook Trigger's `target_chat`.
- Loop guard: writes performed by a flow that was itself started by this trigger do not re-trigger (depth 1).

### Manual Trigger `M`
- "Test flow" button in editor; emits a configurable sample payload.

---

## Telegram nodes

### Send Message `M`
- **In:** 1 → **Out:** 1 (passthrough items + `{ sent_message_id }`)
- **Parameters:**
  - `chat`: default current chat | expression
  - `type`: text | photo | video | document | audio | sticker
  - `text` / `caption` (multiline, expressions, Markdown/HTML parse mode selector)
  - `media`: URL | uploaded file | `file_id` expression
  - `keyboard`: none | inline | reply — visual button-grid builder
    - inline button kinds: `callback` (emits `button_click` events / connects to Menu logic), `url`, `web_app`
  - `options`: disable_preview, protect_content, reply_to, silent

### Wait for Reply `M` — *the conversation primitive*
Pauses the execution until the user replies.

- **In:** 1 → **Out:** `reply` | `timeout` | `invalid` (3 ports)
- **Parameters:**
  - `prompt` (optional): message to send before waiting (full Send Message powers)
  - `expect`: text | number | photo | document | contact | location | any
  - `validation` (for text/number): regex, min/max, custom expression `{{ ... }}` must return true
  - `invalid_message`: sent on validation failure; `max_retries` then → `invalid` port
  - `save_to`: variable name → `$vars.<name>` (and appended to `$json.answers`)
  - `timeout`: duration (e.g. `15m`, `2d`) → `timeout` port
  - `allow_commands`: whether `/commands` cancel the wait (default: `/cancel` cancels)
- **Emits on reply:** `{ json: { ...passthrough, reply: { text|file_id|contact|location, raw } } }`

### Menu `M`
Sends a message with inline buttons; each button is an **output port**.

- **In:** 1 → **Out:** one port per button (+ optional `timeout`)
- **Parameters:** `text`, button grid (label, optional value), `timeout`, `edit_in_place` (edit previous menu message instead of sending new), `answer_callback_text`
- Pauses execution like Wait for Reply; resumes through the clicked button's port with `{ json: { clicked: { key, label, value } } }`.

### Edit Message `+P3` / Delete Message `+P3`
- Edit text/caption/keyboard of a message by `message_id` (expression; defaults to last sent in this execution). Delete by id.

### Answer Callback `+P3`
- Toast/alert on button click (when handling raw callbacks outside Menu).

### Send Chat Action `+P3`
- typing / upload_photo / etc., optional auto-while-next-node-runs.

---

## Flow control

### IF `M`
- **Out:** `true` | `false`
- Condition builder rows (value1, operator, value2) with AND/OR, operators: equals, contains, regex, gt/lt, exists, is_empty… or a single raw expression.

### Switch `M`
- **Out:** N rules + `default`. Each rule: expression/value match on a chosen field.

### Set Fields `M`
- Set/rename/remove keys on `$json` and/or `$vars`. Rows of `name = value(expression)`; option "keep only set fields".

### Wait / Delay `M`
- Fixed duration (`30s`…`7d`) or until datetime (expression). Persisted — survives restarts (uses the same wait machinery).

### Loop `+P3`
- Split items into batches (n8n `splitInBatches` style): `loop` port ↔ `done` port.

### Merge `+P3`
- Combine two branches: append | wait-for-both | choose-first.

### Execute Sub-Flow `+P3`
- Call another flow of the same bot, passing current items; sub-flow's `Return` node sends items back. Param: flow selector, mode (wait for result | fire-and-forget).

### Stop & Error `M`
- End execution with status error + message (visible in execution log; optional message to user).

### Respond to Webhook `+P4`
- Produces the HTTP response for a sync Webhook Trigger: status, headers, body (expression).

---

## Data & code

### Code (JavaScript) `M` — *the escape hatch*
- **In:** 1 → **Out:** 1
- **Parameters:** `mode`: run-once (gets `$items`) | per-item (gets `$json`); `code` (editor with syntax highlight, autocomplete of `$` scope)
- **Scope:** everything from expressions + `await $http.request(...)`, `$kv.get/set`, `$vars`, `console.log` (captured into exec log). Returns `FlowItem[]` / object / array — auto-normalized like n8n.
- **Limits:** 10s timeout, 64MB, no require/fs/process. See ARCHITECTURE §8.

### HTTP Request `M`
- method, url, query rows, header rows, body (json/form/raw), credential selector, timeout, retries with backoff
- `response`: auto-parse JSON → `$json`; binary → `binary` ref; option "never error" (status into `$json.statusCode`).

### Storage (KV) `M`
- op: get | set | delete | increment; scope: user | bot | flow; key, value (expressions). Backs persistent per-user data ("points", "state") without external DB.
- Rule of thumb (documented in UI): conversation-scoped scratch data → KV; durable entities the operator should see in a table → Collection.

### Collection `+P3.5` (`data.collection`)
Generic CRUD against user-defined Collections (ARCHITECTURE §13). As domain-agnostic as KV — CTB has no idea whether records are products, tickets, or recipes.

- **In:** 1 → **Out:** 1 (`found` items / written record) + `empty` port (find/get with no result)
- **Parameters:**
  - `collection`: collection selector (dropdown from this bot's collections)
  - `operation`: `find | get | insert | update | delete | count`
  - `find`: `where` rows (field · op · value-expression) per ARCHITECTURE §13.4, `sort`, `limit`, `offset` → emits one item per record `{ json: { record, record_id } }`
  - `get`: `record_id` (expression)
  - `insert` / `update`: field mapping rows `field = value(expression)`; `update` needs `record_id` or `where` (first match); option `merge | replace` for `group` fields
  - `delete`: `record_id` or `where` + `confirm_many` guard (refuses multi-delete unless enabled)
  - `suppress_events` (bool, default false): writes don't fire `collection.recordChanged`
- Writes are validated against the collection schema; validation failure → node error with field-level messages in the exec log.
- **Emits:** find → N items; get/insert/update → `{ json: { record, record_id } }`; count → `{ json: { count } }`; delete → `{ json: { deleted: n } }`.

### User Profile `+P3`
- Read/update CTB user record: tags add/remove, profile fields. (Generic CRM-ish primitive, still domain-agnostic.)

---

## AI nodes `+P5`

### LLM Chat
- credential (OpenAI-compatible: base_url + key → works for OpenAI/OpenRouter/Anthropic-via-proxy/local), model, system prompt, user prompt (expression), temperature, max_tokens
- `memory`: none | conversation (last N turns persisted per chat via KV)
- **Out:** `{ json: { reply, usage } }`

### AI Classify
- prompt + list of categories → **one output port per category** (Switch powered by LLM). For routing user intents.

### AI Extract
- prompt + target JSON schema (Zod-style) → structured `$json.extracted`. Retries on invalid JSON.

### AI Agent (tools)
- LLM with tool-calling; tools = selected MCP server tools and/or other flows exposed as tools. Multi-turn loop with budget caps.

### MCP Client
- credential: MCP server (SSE/stdio-over-http); action: list tools | call tool (name, args expression) → `$json.result`.

---

## Node implementation contract (for `packages/nodes`)

```ts
export interface NodeDef<P = unknown> {
  type: string;                  // "tg.sendMessage"
  category: 'trigger'|'telegram'|'flow'|'data'|'ai';
  ports: { inputs: string[]; outputs: string[] };
  paramsSchema: ZodType<P>;      // → editor form + validation
  execute(ctx: NodeCtx, params: P, items: FlowItem[]):
    Promise<NodeResult>;         // items per port | WAIT(spec) | GOTO | END | ERROR
}
```

`NodeCtx` injects capabilities: `ctx.tg` (sender), `ctx.kv`, `ctx.http`, `ctx.vars`, `ctx.log`, `ctx.eval(expr, item)` — nodes never touch globals, which keeps everything testable.
