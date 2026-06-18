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

### Webhook Trigger `+P4` ✅ (`webhook.trigger`)
- `POST /hooks/flow/:flowId/:secret`; request → `$json = { body, headers, query, method }`. Modes: async (202 + `executionId` immediately) | sync (wait for `Respond to Webhook` node, bounded by `sync_timeout` 1–120s → 504 on overrun; no respond node → 200 ack).
- Auth: unguessable per-flow path `:secret` derived from `CTB_SECRET` (no DB column). Optional HMAC: `verify_signature` requires `X-CTB-Signature: sha256=<hex>` over the raw body. See PROTOCOL.md §Inbound.
- A pure pass-through (route does the work host-side, like `collection.recordChanged`). Webhook-started runs have no implicit chat (`chatId=null`).
- Param `target_chat`: expression resolving which chat the conversation nodes talk to (e.g. `{{ $json.body.chat_id }}`) — used by the Telegram nodes themselves, not the route (a raw param the executor never `{{ }}`-resolves).

### Schedule Trigger `+P4` ✅ (`schedule.trigger`)
- `cron` expression evaluated in `timezone` (IANA name; empty = server tz). The host-side **Scheduler** (`apps/server/src/triggers/schedule.ts`) runs ONE croner job per enabled `schedule.trigger` node of an ACTIVE flow; on fire it builds the item and starts the run, so the node is a pure pass-through (like tg.trigger / webhook.trigger).
- **Emits:** `{ json: { now, cron, timezone, scheduled: true, user? } }` — `user` (`{ id, profile, tags }`) only on a fan-out run.
- Plain mode → ONE chatless run (chatId null; the flow resolves its own chat, same rule as Webhook/recordChanged). `for_each_user` → one run per KNOWN bot user, each run's chat = that user's tg id, throttled to `rate_per_min` starts/min (0 = unlimited).
- Reconciled against the DB: the flows API re-runs the Scheduler's `reconcile()` on activate / deactivate / edit / delete, so cron jobs always track the live active-flow set; the job set survives restart (re-armed on boot from active flows). Invalid cron/timezone strings are logged and skipped, never fatal.
- Params `cron` / `timezone` / `target_chat` are raw (host directives, never `{{ }}`-resolved).

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

### Send Media `M` — *bytes upload + albums*
Sends photo/video/document/audio — including raw **bytes** (not just URL/`file_id`) — and can group 2–10 items into a single album (media group). The node never touches disk: bytes come from `ctx.files` (a stored Collection file) or are decoded from base64, and the host (`ctx.tg.sendMedia`) owns the actual Bot-API upload.
- **In:** 1 → **Out:** 1 (passthrough items + `{ sent_message_ids: number[], sent_message_id }`)
- **Parameters:**
  - `chat`: default current chat | expression
  - `media`: 1–10 rows, each `{ kind, source, value, caption?, filename?, mime? }`
    - `kind`: photo | video | document | audio
    - `source`: `url` | `file_id` (Telegram-side, no upload) | `file` (Collection file id → bytes via `ctx.files.read`) | `base64` (decoded to bytes; `data:` prefix stripped)
    - **album rule:** 2–10 items ⇒ media group; album items must all be `photo`/`video`, and no keyboard is allowed (enforced by schema `superRefine`)
  - `caption` / `parse_mode`: caption attaches to the first item in an album
  - `keyboard`: inline/reply (single-item only)
  - `options`: protect_content, reply_to, silent
- **Capabilities:** requires `ctx.tg.sendMedia`; `source: file` additionally requires `ctx.files`. Fail-loud when absent (I6).

### Get a File `M` — *download + store*
The RECEIVE half of the media pair (Send Media being the SEND half). Given a Telegram `file_id` (captured by the trigger from a photo/voice/document/video the user sent), it **downloads the bytes** and optionally **stores** them so downstream nodes (Send Media `source: file`, future Speech-to-Text) can reuse them. The node never touches the token, the network, or disk: it asks `ctx.tg.getFile` for the bytes (the host calls the Bot-API `getFile`, then downloads from Telegram's file endpoint with the bot token, held host-side per I3/I6), and — when `store` is on — hands them to `ctx.files.write` (the host stamps the run's bot and writes them under the file-store).
- **In:** 1 → **Out:** 1 (passthrough items + a result object merged under `save_as`)
- **Result:** `{ file_id, path, url, mime, size, stored_file_id? }` — `stored_file_id` + the file-store `url` appear only when `store` is on; otherwise `url` is the temporary Telegram download URL.
- **Parameters:**
  - `file_id` (default `''`): empty ⇒ auto-resolved from the incoming item (`$json.file_id`, then nested `reply`/`photo`/`voice`/`document`/`audio`/`video` `.file_id`). An explicit value (literal or `{{ }}`) always wins.
  - `store` (default `true`): store the bytes (file-store) and emit a CTB file id; `false` ⇒ URL + metadata only, no disk write
  - `save_as` (default `file`, identifier regex): the `$json` field the result is written to
- **Runs once per node run** (one download), merging the result onto every item.
- **Capabilities:** requires `ctx.tg.getFile`; `store: true` additionally requires `ctx.files` (with `write`). Fail-loud when absent (I6).

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

### Edit Fields (Set) `+PA` — *the n8n "Edit Fields / Set" power node* (`data.editFields`)
A richer sibling of Set Fields, labelled **"Edit Fields (Set)"** so n8n users find it. Same immutable, per-item model (input items are never mutated; `$vars` rows apply once per run; empty input still emits one shaped item to seed a pipeline) plus three powers per row:
- **op `rename`** — move a value from one dotted path (`name`) to another (`value` = the destination path), deleting the source. Works in `keep_only_set` mode too (the source is read from the original item).
- **`value_mode: 'json'`** — interpret a STRING `value` as raw JSON (`"[1,2]"` → a real array; a non-string value passes through unchanged).
- **`enabled`** (default true) — a disabled row is kept in config but skipped entirely.
- **Parameters:** `fields` (≥1 rows, each `{ name, value?, op: set|remove|rename, target: json|vars, value_mode: value|json, enabled }`) · `keep_only_set` (output `$json` starts empty, holding only the fields this node sets/renames).
- **In:** 1 → **Out:** 1 (passthrough, edited). Dotted names create nested objects (`user.level` → `{user:{level}}`).
- **Fails loudly** on a `value_mode:'json'` value that isn't valid JSON, or a `rename` with an empty destination (validated up front, before any item is touched).

### Split Out `+PA` (`data.splitOut`)
Splits one item that contains an **array field** into one item per element (n8n "Split Out"). The inverse of `data.aggregate`.

- **In:** many → **Out:** `main` (one item per array element) + `empty` (original item when the array is empty/missing).
- **Parameters:** `field` (dotted path to the array field, e.g. `"tags"` or `"result.items"`) · `include` (`selected_field_only` | `all_fields`, default `all_fields`; `selected_field_only` → output `$json` contains only the extracted element, `all_fields` → full original item with the field replaced by the element).
- When `field` resolves to a non-array value, treats it as a single-element array (same as n8n).
- Items are never mutated; original array field is replaced by the element in `all_fields` mode.

### Aggregate `+PA` (`data.aggregate`)
Merges many items into **one** by collecting a field (or all fields) into an array (n8n "Aggregate"). The inverse of `data.splitOut`.

- **In:** many → **Out:** 1 (single item with the aggregated array).
- **Parameters:** `mode` (`aggregate_individual_fields` | `aggregate_all_items`, default `aggregate_individual_fields`):
  - `aggregate_individual_fields`: for each row in `fields`, collect the value of that dotted `field` across all items into `dest` (also a dotted path); additional fields from the first item are carried through.
  - `aggregate_all_items`: wrap the entire `$json` of each item into an array under `dest_field` (default `"data"`).
- Empty input emits a single item with an empty array.

### Filter `+PA` (`data.filter`)
Passes each item through the `kept` port if its conditions hold, or the `discarded` port otherwise. Reuses the **`flow.if` condition engine** exactly — same operators, same AND/OR combine logic — so a flow author who knows IF already knows Filter.

- **In:** many → **Out:** `kept` (passing items) + `discarded` (failing items). Both ports are always emitted (possibly empty) so downstream branches always exist.
- **Parameters:** `conditions` (≥1 condition rows, each `{ value1, operator, value2? }` — same schema as `flow.if`; operators: equals, notEquals, contains, regex, gt, gte, lt, lte, exists, is_empty) · `combine` (and | or, default and).
- Each item is evaluated independently; items are never mutated.
- Differs from `flow.if` in intent and output names: IF **branches the whole batch** at a decision point; Filter **partitions items** and keeps both sets in the same pipeline.

### Sort `+PA` (`data.sort`)
Orders items by one or more keys (n8n "Sort"). Pure, stable, multi-key.

- **In:** many → **Out:** `main` (same items, new order).
- **Parameters:** `fields` (≥1 rows, each `{ field, order }` — `field` is a dotted path, `order` is `asc` | `desc`, default `asc`). The first row is the primary key; later rows break ties.
- **Comparison:** if both values are numbers (or numeric strings) they compare numerically; otherwise they compare as locale-aware strings. A missing/null/empty value always sorts **last**, regardless of direction (n8n-compatible). The sort is stable, so equal keys preserve input order.
- Items are never mutated — only the output order changes.

### Limit `+PA` (`data.limit`)
Keeps only the first or last N items (n8n "Limit"). Pure, tiny, high-value.

- **In:** many → **Out:** `main` (the surviving items, original relative order).
- **Parameters:** `max_items` (integer ≥ 0; `0` = no limit; coerced from a string) · `keep` (`first` | `last`, default `first`).
- When `max_items` is `0` or ≥ the input length, everything passes through unchanged. Items are never mutated.

### Remove Duplicates `+PA` (`data.removeDuplicates`)
Drops repeated items, keeping the **first** occurrence (n8n "Remove Duplicates").

- **In:** many → **Out:** `main` (de-duplicated items, order of survivors preserved).
- **Parameters:** `compare` (`all_fields` | `selected_fields`, default `all_fields`) · `fields` (≥1 dotted field paths, required only when `compare=selected_fields`).
  - `all_fields`: an item is a duplicate when its **entire** `$json` is deep-equal to one already seen (compared via a stable, key-sorted serialization, so key order doesn't matter).
  - `selected_fields`: an item is a duplicate when the combined value at the chosen `fields` matches an already-seen item. A missing field is encoded distinctly so it never collides with a literal `null`.
- Fails loudly when `compare=selected_fields` but no `fields` are given. Items are never mutated.

### Date & Time `+PA` (`data.dateTime`)
Parse / format / add-subtract / diff a date, with IANA timezones **and Jalali (Persian) calendar** output — our users are Iranian, so formatting `۱۴۰۴/۰۳/۲۴` is a first-class need. Pure (no runtime deps; the Gregorian↔Jalali conversion is a small hand-written algorithm). Runs **per item**.

- **In:** many → **Out:** `main` (each input item with the result merged in).
- **Parameters:**
  - `operation` (`format` | `add` | `diff`, default `format`).
  - `source` — where the input date comes from: `now` (the injected `ctx.now()` clock) or `value` (a dotted-path/expression value the row supplies). Default `now`.
  - `value` — when `source=value`: an ISO-8601 string, an epoch-millis number, or a `{{ }}` expression resolving to one. Lenient parse (ISO, `YYYY-MM-DD`, `YYYY/MM/DD`, epoch).
  - `timezone` — IANA tz (e.g. `Asia/Tehran`); empty = the server's local zone. Applied to BOTH formatting and the calendar/field math.
  - `calendar` (`gregorian` | `jalali`, default `gregorian`) — for `format` output only. `jalali` converts the (timezone-adjusted) date to the Persian calendar before applying the format pattern.
  - `format` — a token pattern (`YYYY MM DD HH mm ss` + `MMMM` month name in the chosen calendar/locale); default `YYYY-MM-DD`. `digits` (`latin` | `persian`, default `latin`) optionally maps output digits to Persian (`۰۱۲۳…`).
  - `amount` + `unit` (`years|months|days|hours|minutes|seconds`) — for `operation=add` (negative `amount` subtracts).
  - `to_value` + `diff_unit` — for `operation=diff` (difference between the source date and `to_value`, expressed in `diff_unit`; default `days`).
  - `save_as` — output key on `$json` (default `datetime`).
- **Output shape** merged under `save_as`: `format` → `{ formatted, iso, epoch }`; `add` → `{ iso, epoch }` (the shifted instant); `diff` → `{ diff, unit }` (a number, may be fractional).
- Fails loudly on an unparseable input date or an invalid timezone. Items are never mutated (result is added to a clone).

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

### Respond to Webhook `+P4` ✅ (`flow.respondToWebhook`)
- Produces the HTTP response for a sync Webhook Trigger: `status`, `body_type` (json | text), `body` (expression), header rows. A `Content-Type` header row overrides the body_type default.
- Parks `{status, bodyType, body, headers}` under the reserved `$vars` key `__webhook_response__` (the same handshake `flow.return` uses); the route reads it after the run. NOT terminal — items pass through on `main`, so the flow can keep going (e.g. send a Telegram confirmation) after replying.

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

## Database connectors `+PB`

Generic SQL database nodes (invariant I2 — "Postgres" is infrastructure, never a domain). The driver lives ONLY in `apps/server` (invariant I3); the node reaches the database through the injected `ctx.db` capability and never imports `pg`/`mysql2`. The connection is a stored, encrypted credential (invariant I7) — the node only ever passes a `credentialId`, never a host/password.

### Postgres `+PB` (`db.postgres`)
- **In:** 1 → **Out:** 1 (`main`) — the node maps result rows back onto items.
- **Parameters:**
  - `credentialId`: a `postgres` credential (host/port/database/user/password/ssl), resolved host-side — the host owns the connection pool (invariant I3/I6/I7).
  - `operation`: `query | select | insert | update | delete`.
  - `query` (operation=`query`): a raw parameterized SQL string. Bind values are supplied as `params` rows (a JSON array, expression-aware) and referenced by **`$1, $2, …` placeholders** — values are bound by the driver, NEVER string-concatenated, so this is SQL-injection-safe.
  - `table` (operation=`select|insert|update|delete`): the table name (validated as a SQL identifier — letters/digits/`_`, optionally schema-qualified `schema.table`).
  - `select`: optional `where` (field · op · value-expression) rows, `limit`, `order_by`. Emits one item per row.
  - `insert`: `values` field-mapping rows (`column = value(expression)`) → `INSERT … RETURNING *`. Emits the inserted row.
  - `update`: `values` rows + `where` rows → `UPDATE … SET … WHERE … RETURNING *`. Emits each updated row.
  - `delete`: `where` rows + a `confirm_many` guard (refuses an unfiltered/multi-row delete unless enabled) → `DELETE … RETURNING *`. Emits each deleted row.
  - `return_mode`: `rows` (default — one output item per result row, `{ json: row }`) | `single` (merge `{ rows, rowCount }` onto every input item under `save_as`, default `db`).
- **Runs ONCE per node run** (one SQL round-trip — a query is execution-external work that targets the resolved params, like the AI/MCP nodes). The result is mapped per `return_mode`.
- Fails LOUDLY when `ctx.db` is absent (no driver wired), the credential is missing/undecryptable/not a `postgres` credential, a `where`/`values` row is empty, an identifier is unsafe, a `delete`/`update` would touch many rows without `confirm_many`, or the database returns an error.

### MySQL `+PB` (`db.mysql`)
- **In:** 1 → **Out:** 1 (`main`) — the node maps result rows back onto items.
- The MySQL/MariaDB mirror of `db.postgres`: same shape, same `ctx.db` capability contract, same `operation`/`return_mode`/`confirm_many`/`save_as` semantics. A flow author sees an identical node — only the credential type and the SQL dialect differ. The host owns the `mysql2` connection pool (the node never imports `mysql2`); the node passes a `credentialId` + a `dialect: 'mysql'` marker so the host routes to the MySQL factory and refuses a non-`mysql` credential.
- **Parameters:**
  - `credentialId`: a `mysql` credential (host/port[default 3306]/database/user/password/ssl), resolved host-side (invariant I3/I6/I7).
  - `operation`: `query | select | insert | update | delete`.
  - `query` (operation=`query`): a raw parameterized SQL string. Bind values are supplied as `params` rows (a JSON array, expression-aware) and referenced by **`?` placeholders** (the MySQL convention) — values are bound by the driver, NEVER string-concatenated, so this is SQL-injection-safe.
  - `table` (operation=`select|insert|update|delete`): the table name (validated as a SQL identifier — letters/digits/`_`, optionally schema-qualified `schema.table`) and **backtick-quoted** (`` `col` ``) rather than double-quoted.
  - `select`: optional `where` (field · op · value-expression) rows, `limit`, `order_by`. Emits one item per row.
  - `insert` / `update` / `delete`: same builders as Postgres, but **without `RETURNING *`** (MySQL has none). A write returns the driver's OK packet, which the host normalizes to a synthetic row `{ affectedRows, insertId? }` so the `rows`/`single` return modes still behave sensibly.
  - `return_mode`: `rows` (default — one output item per result row; a write emits the normalized `{ affectedRows, insertId? }` row) | `single` (merge `{ rows, rowCount }` onto every input item under `save_as`, default `db`).
- **Runs ONCE per node run** (one SQL round-trip). The result is mapped per `return_mode`.
- Fails LOUDLY when `ctx.db` is absent (no driver wired), the credential is missing/undecryptable/not a `mysql` credential, a `where`/`values` row is empty, an identifier is unsafe, a `delete`/`update` would touch many rows without `confirm_many`, or the database returns an error.

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

### AI Agent (tools) `+PB` — PB-T5 slots
- LLM with tool-calling; multi-turn reasoning loop with budget caps
  (`max_steps`/`max_tool_calls`/`max_tokens_total`). The result
  (`{reply, steps, toolCalls, usage, stopReason}`) merges onto every item under
  `$json.<save_as>` (default `agent`).
- **Typed sub-connection slots (PB-T5):** the agent is a **consumer** that
  declares `inputSlots`:
  - **`ai:model`** — the chat model to drive. Filled by an `ai.modelOpenai`
    provider (see below). *Backward-compatible:* when no model slot is attached
    the agent falls back to its inline `credentialId`/`model` params, so Phase-A
    agent flows keep working. With neither source it fails loudly (`no model: …`).
  - **`ai:memory`** *(optional)* — a chat-memory provider (`ai.memoryKv` /
    `ai.memoryPostgres`). When attached, the agent replays the rolling window
    (`loadChatHistory`) before the first model turn and persists the new
    user+assistant pair (`appendChatTurn`) after the final answer (best-effort —
    a store hiccup is logged, never loses the reply). Blank provider `session_key`
    defaults to `<nodeId>:<chatId>` (per-node, per-chat isolation).
  - **`ai:tool`** *(repeatable)* — callable tools, merged **alongside** the
    inline `tools` param and resolved through the same path. The dedicated tool
    provider nodes land in **PB-T6**; until then a tool provider whose validated
    params already match an `AgentToolSource` (`{type:'mcp'|'subflow', …}`) is
    accepted, and anything else is skipped with a warning (forward-compatible).
- Tools come from MCP server tools and/or other flows exposed as tools (from
  either the inline param or the `ai:tool` slots). I6/I7 hold — the node only
  ever passes a `credentialId`; the host resolves the key.

### AI model providers `+PB` (`ai.modelOpenai`) — PB-T5
- **Role:** `provider`, **provides:** `ai:model`. A *sub-node* (no data ports —
  a single dashed `provider` wire) attached to an AI Agent's **required**
  `ai:model` slot — the n8n "OpenAI Chat Model" sub-node. Generic infrastructure
  (I2 — a model is a capability, never a domain).
- **`ai.modelOpenai`** — carries an OpenAI-compatible `credentialId` (base_url +
  key → OpenAI / OpenRouter / Anthropic-via-proxy / local), `model` (default
  `gpt-4o-mini`, must support tool/function calling), and optional `temperature`
  / `max_tokens`. The node **never** touches the network: it only declares which
  model + credential the agent should use; the agent calls the LLM through the
  injected `ctx.ai` capability (I3/I6), passing the id the host decrypts (I7).
- A provider is never executed as a data step — the executor resolves it as the
  agent's config (`ctx.slots['ai:model'][0]`); its `execute()` fails loudly if a
  malformed graph ever routes data into it.

### Chat memory providers `+PB` (`ai.memoryKv`, `ai.memoryPostgres`) — PB-T4
- **Role:** `provider`, **provides:** `ai:memory`. These are *sub-nodes* (no data
  ports — a single dashed `provider` wire), attached to an AI Agent's `ai:memory`
  slot to give it a **rolling conversation memory** (the n8n "Chat Memory"
  nodes). Generic infrastructure (I2 — memory is a capability, never a domain).
- **`ai.memoryKv`** — the **default**. Persists the rolling window in the
  built-in KV store (`ctx.kv`, scope `user`, key `__ai_mem__:<session>`), exactly
  like `ai.llmChat`'s `memory:'conversation'` — so a bot with **no database**
  still remembers the last N turns. Params: `session_key` (blank → keyed per
  node+chat), `memory_window` (turns, default 10).
- **`ai.memoryPostgres`** — the n8n "Postgres Chat Memory". Persists turns as
  rows in a Postgres table via the injected `ctx.db` (the `pg` pool lives in the
  host, I3; the decrypted secret never reaches node code, I7). Params:
  `credentialId` (a `postgres` credential), `table` (validated SQL identifier,
  default `ctb_chat_memory`), `session_key`, `memory_window`, `auto_create`
  (issues `CREATE TABLE IF NOT EXISTS` before first use).
- **Shared runtime (`chat-memory.ts`, I5):** a provider is never executed; the
  consumer resolves its params into a `ChatMemoryConfig` (`{kind:'kv'|'postgres',
  …}`) and drives `loadChatHistory()` (replay the rolling window before a model
  turn) + `appendChatTurn()` (persist the new user+assistant pair after). Both
  operate **only** through the injected `ctx.kv` / `ctx.db` capabilities. SQL
  values are **always** bound (`$1,$2,…`), never concatenated; the table
  identifier is validated against `/^[A-Za-z_][A-Za-z0-9_]*$/` per dot-segment
  and double-quoted (`quotePgIdent`) — a hostile table name throws loudly. Fails
  loud when the needed capability (`ctx.kv` for kv, `ctx.db` for postgres) is
  absent. **Consumed by the AI Agent via the `ai:memory` slot (PB-T5, done).**

### MCP Client
- credential: MCP server (SSE/stdio-over-http); action: list tools | call tool (name, args expression) → `$json.result`.

---

## Node implementation contract (for `packages/nodes`)

```ts
export interface NodeDef<P = unknown> {
  type: string;                  // "tg.sendMessage"
  category: 'trigger'|'telegram'|'flow'|'data'|'ai';
  role?: 'data' | 'provider';    // PB-T1; defaults to 'data' (see below)
  inputSlots?: readonly InputSlot[]; // PB-T1; typed provider slots (consumers)
  provides?: SlotKind;           // PB-T1; the kind a provider satisfies
  ports: { inputs: string[]; outputs: string[] };
  paramsSchema: ZodType<P>;      // → editor form + validation
  execute(ctx: NodeCtx, params: P, items: FlowItem[]):
    Promise<NodeResult>;         // items per port | WAIT(spec) | GOTO | END | ERROR
}
```

`NodeCtx` injects capabilities: `ctx.tg` (sender), `ctx.kv`, `ctx.http`, `ctx.vars`, `ctx.log`, `ctx.eval(expr, item)` — nodes never touch globals, which keeps everything testable.

---

## Sub-connections — typed provider slots (PB-T1)

Some nodes (an **AI Agent**, a chat node with memory) need helper nodes attached
to them — a Chat Model, a Memory, one or more Tools — that are **not** part of
the data flow. CTB models these as **sub-connections**: a typed wire that
*attaches* a provider node to a consumer's input **slot**, distinct from a data
edge. This mirrors the n8n "AI" canvas (model/memory/tool plugged in below a
node) while staying generic (invariant I2).

**Contract (shared, I5 — one Zod schema, two consumers):**

- `SlotKind = 'ai:model' | 'ai:memory' | 'ai:tool'`. A slot's `kind` **doubles
  as the target port name** the sub-connection edge lands on (`PortName` allows
  `:`), so a sub-connection is an ordinary `FlowEdge` whose `to.port` is the
  slot kind.
- A consumer declares `inputSlots: { kind, required, repeatable }[]`. Its
  `role` stays `'data'`.
- A provider declares `role:'provider'` + `provides: SlotKind`. It has **no data
  ports** and is wired only through the dashed slot edge.

**Rules (enforced in `flow-validate.ts` `validateSubConnections` and the editor
`canConnect`):**

| Rule | Verdict / error |
|------|-----------------|
| a slot port must be fed by a provider of the **same** kind | `slotKindMismatch` / "slot must be fed by a `<kind>` provider" |
| a provider may attach **only** to a matching slot, never a data port | `providerNotAttachedToSlot` / "provider can only attach to a matching slot" |
| a `required` slot must be connected | "required slot `<kind>` is not connected" |
| a non-`repeatable` slot accepts **one** provider | `slotNotRepeatable` / "slot accepts only one provider" |
| disabled nodes are ignored; a provider never counts as a trigger | — |

**Back-compat:** every new field is **optional**. Server validation only runs
slot rules when the registry-derived `nodeMeta` map is passed
(`validateFlowForActivation(graph, paramSchemas, nodeMeta)`); the editor only
styles slot edges when `byType` is passed to `flowToRfEdges`. Phase-A nodes
declare no slots/role, so their payloads and behavior are byte-identical.

**Executor:** providers are resolved as the consumer's **config**, never run as a
step. A correctly-wired graph never routes data into one; if a malformed graph
parks the cursor on a provider the executor skips it (emits nothing, ends the
branch) instead of calling `execute()`.

**Canvas:** slot handles render along the **bottom** edge of the consumer
(target handles, labeled with the kind, `*` = required); providers expose a
single bottom `provider` output handle. Sub-connection edges are drawn **dashed**
(`ctb-slot-edge`, AI accent color) to read distinctly from solid data edges.
