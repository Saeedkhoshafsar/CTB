# CTB Execution Plan (the real, buildable plan)

> This is not a vision document — it is an **ordered list of atomic tasks**, each small enough
> for one working session, each with explicit **files**, **acceptance criteria**, and **verify
> commands**. An agent with zero memory must be able to pick the `→ current` task from
> docs/STATE.md, read it here, and build it correctly.
>
> Rules of engagement: see CLAUDE.md (the constitution). Architecture contracts: docs/ARCHITECTURE.md.
> Node behavior: docs/NODES.md.

## Pinned stack (checked against npm registry, 2026-06)

| Package | Version | Role |
|---|---|---|
| typescript | ^5.9 (NOT 6.x until ecosystem settles) | language |
| fastify | ^5 | HTTP server |
| grammy | ^1.43 | Telegram |
| zod | ^4 | schemas |
| drizzle-orm + better-sqlite3 | ^0.45 / ^12 | DB |
| vitest | ^4 | tests |
| react | ^19 | editor |
| @xyflow/react | ^12 | canvas |
| zustand | ^5 | editor state |
| vite | ^7 (LTS line) | editor build |
| @vitejs/plugin-react | ^5 (v6 requires vite 8) | editor build |
| croner | ^10 | schedule trigger |
| pino | ^10 | logging |
| @codemirror/* | ^6 | code editor |

Node.js >= 20. Engines field enforced. Renovate/upgrades are a P6 concern — do not bump majors mid-phase.

## Task ID convention

`P<phase>-T<number>` — referenced in commit messages, STATE.md, and PR descriptions.

---

# PHASE 0 — Foundation

### P0-T1 · Monorepo skeleton
**Files:** root `package.json` (npm workspaces), `tsconfig.base.json`, per-workspace `package.json` + `tsconfig.json` for `packages/shared`, `packages/core`, `packages/nodes`, `packages/sandbox`, `apps/server`, `apps/editor` (editor = empty Vite React TS placeholder). Root scripts: `verify` (typecheck+test all), `dev`, `build`.
**Accept:**
- `npm install` succeeds from clean clone
- `npm run verify` green (placeholder tests allowed)
- dependency rule visible in tsconfig `references`/paths: shared←core←nodes←server
**Verify:** `npm install && npm run verify`

### P0-T2 · Shared types & schemas (THE CONTRACT)
**Files:** `packages/shared/src/`: `flow.ts` (FlowGraph, FlowNode, FlowEdge, port naming), `item.ts` (FlowItem, BinaryRef), `node-def.ts` (NodeDef, NodeResult = `items|WAIT|GOTO|END|ERROR`, NodeCtx interface), `execution.ts` (ExecutionState, WaitSpec, statuses), `errors.ts`, Zod schemas for all of the above, barrel `index.ts`.
**Accept:**
- Schemas round-trip: `FlowGraphSchema.parse(sample)` works for a hand-written sample flow JSON committed as `packages/shared/test/fixtures/sample-flow.json`
- Unit tests cover parse-success + parse-failure cases
**Verify:** `npm run verify`

### P0-T3 · Database layer
**Files:** `apps/server/src/db/schema.ts` (Drizzle: bots, flows, flow_versions, credentials, executions, exec_logs, kv_store, users — exactly per ARCHITECTURE §4), `db/index.ts` (SQLite connect, `CTB_DB_PATH` env, default `data/ctb.sqlite`), `db/migrate.ts`, generated migrations dir, `src/lib/crypto.ts` (AES-256-GCM encrypt/decrypt using `CTB_SECRET`).
**Accept:**
- `npm run db:migrate` creates the SQLite file with all tables
- crypto round-trip test; refuses to boot without `CTB_SECRET` (min 16 chars)
**Verify:** `CTB_SECRET=devsecret0123456 npm run db:migrate && npm run verify`

### P0-T4 · Server boot + auth + CI
**Files:** `apps/server/src/main.ts` (Fastify, pino, env config via zod), `/healthz`, admin auth (env `CTB_ADMIN_USER/PASS`, signed-cookie session, login/logout routes), static serving of editor build, `.env.example`, `Dockerfile`, `docker-compose.yml`, `.github/workflows/ci.yml` (install → verify).
**Accept:**
- `npm run dev:server` boots; `/healthz` → `{ok:true}`; protected route 401 without session, 200 after login
- CI workflow file passes lint of its own syntax (runs on push)
**Verify:** boot + `curl localhost:3000/healthz`
**🎬 PHASE 0 DEMO:** clean clone → `npm install`, migrate, boot, login via curl.

---

# PHASE 1 — Engine core + Telegram gateway

### P1-T1 · Expression engine
**Files:** `packages/core/src/expression/` — tokenizer for `{{ … }}` segments, evaluator executing the inner JS expression inside the sandbox primitive (see P1-T2; for this task use a stub evaluator with `new Function` + frozen scope, swapped later), scope builder (`$json,$items,$vars,$user,$chat,$execution,$flow,$env,$now` per ARCHITECTURE §6).
**Accept:** tests: plain string passthrough; interpolation; nested paths; missing path → empty string + warning collected; expression throwing → typed `ExpressionError`; 50ms budget enforced.
**Verify:** `npm run verify`

### P1-T2 · Sandbox primitive
**Files:** `packages/sandbox/src/` — `runInSandbox(code, scope, {timeoutMs, capabilities})` on `worker_threads` pool; frozen realm (no require/process/fs); capability proxies over MessagePort; console capture; hard timeout kill + worker recycle.
**Accept:** tests: returns value; `while(true)` killed at timeout and pool survives; `process` / `require` are `undefined` inside; capability call (`$kv.get` stub) round-trips; 20 parallel runs don't deadlock.
**Verify:** `npm run verify`
**Note:** after this task, swap P1-T1's stub evaluator to the sandbox. (One-line Decision Log entry.)

### P1-T3 · Execution store
**Files:** `packages/core/src/store/types.ts` (`ExecutionStore` interface: create/load/save/checkpoint/findWaiting/listTimedOut), `apps/server/src/engine/sqlite-store.ts` implementation, plus an in-memory implementation in `core` for tests.
**Accept:** serialization round-trip test: ExecutionState (items+vars+cursor+wait) → save → load → deep-equal. `findWaiting(botId, chatId)` honors match filters.
**Verify:** `npm run verify`

### P1-T4 · Executor loop
**Files:** `packages/core/src/engine/executor.ts` — step loop per ARCHITECTURE §7: resolve node, eval params (expressions), run `nodeDef.execute`, route items per output port via edges, handle `WAIT` (persist+return), `GOTO`, `END`, `ERROR`; safety: maxSteps=1000, per-step logging hook; `packages/core/src/registry/` node registry.
**Accept:** tests with fake nodes: linear flow; branching (2 ports); GOTO; WAIT suspends → `resume(executionId, injectedItems)` continues from the exact node; maxSteps abort; error path writes log entry.
**Verify:** `npm run verify` — **this task requires the pause/resume round-trip test (invariant I4).**

### P1-T5 · Telegram gateway
**Files:** `apps/server/src/telegram/` — `gateway.ts` (bot lifecycle: register token → grammY instance; webhook route `/tg/:botId/:secret` + polling mode for dev), `normalize.ts` (raw Update → `TgEvent`: command/text/photo/document/contact/location/callback), `sender.ts` (centralized send: token-bucket per bot, 429 retry_after handling, parse-mode safe, splitting >4096).
**Accept:** unit tests with grammY transformer (no network): normalization table-driven tests; sender retries on simulated 429.
**Verify:** `npm run verify`

### P1-T6 · Update router (the conversational core)
**Files:** `apps/server/src/engine/router.ts` — on TgEvent: (1) `findWaiting(bot,chat)` + wait-spec match (expect-type, validation) → resume executor; (2) else match flow triggers (priority: command > button > text-pattern > any_message) → start execution; (3) else drop (log). Per-chat mutex. Timeout scanner (croner, every 30s → resume via `timeout` port).
**Accept:** integration tests (in-memory store + fake sender): trigger starts execution; reply resumes the waiting one and NOT a new one; validation failure re-prompts and stays waiting; timeout fires `timeout` port; two chats run independently.
**Verify:** `npm run verify`

### P1-T7 · MVP node set, wave 1
**Files:** `packages/nodes/src/`: `tg.trigger`, `tg.sendMessage`, `tg.waitForReply`, `flow.if`, `data.setFields`, `flow.stopError` — each exactly per docs/NODES.md, with Zod param schemas in `shared`, contract tests per node.
**Accept:** every node has ≥3 contract tests (happy, edge, error). `tg.waitForReply` covers: prompt sent, expect=number validation, retries→invalid port, save_to writes `$vars`.
**Verify:** `npm run verify`

### P1-T8 · Bots API + end-to-end wiring
**Files:** `apps/server/src/api/bots.ts` (CRUD: create with token→encrypted, set webhook/polling, status), `api/flows.ts` (CRUD graph JSON + activate), seed script `scripts/demo-flow.ts` writing the demo flow below.
**Accept — 🎬 PHASE 1 DEMO (manual, documented in STATE.md when done):**
- register a real test bot (polling mode, no domain needed)
- demo flow: `/start` → ask name (wait) → ask age (number, validated, 2 retries) → send "سلام {{name}}, {{age}} ساله!"
- **kill the server mid-conversation, restart, answer — flow resumes correctly** ← the whole point
**Verify:** `npm run verify` + scripted e2e test using fake transport replicating the demo

---

# PHASE 2 — Visual editor (MVP)

### P2-T1 · Editor shell
Vite+React+TS app for real: routing (login, bots, flows list, flow editor, executions), zustand stores, typed API client generated from server route schemas, RTL layout + fa/en i18n scaffold, dark theme base.
**Accept:** login → bots list → create flow (empty) → persists via API.

### P2-T2 · Canvas
React Flow canvas: node palette (from `GET /api/node-types` — server exposes registry + param schemas), drag-add, connect (port-aware, type-checked edges), delete, undo/redo, minimap, autosave-draft.
**Accept:** build the P1 demo flow graph visually; saved JSON validates against `FlowGraphSchema` and **byte-equivalent semantics** to the seed flow.

### P2-T3 · Param side-panel (schema-driven forms)
Auto-render forms from Zod schemas: string/multiline/select/number/boolean/duration; expression-aware inputs (`{{ }}` highlight + scope hint dropdown); button-grid builder widget (for keyboards/Menu); condition-rows widget (for IF/Switch).
**Architecture note (binding):** build this as a standalone, schema-driven **form engine** (widget registry keyed by field/param type), NOT hardcoded to node params — Phase 3.5 reuses the same engine to render Collection record forms (ARCHITECTURE §13.5).
**Accept:** every P1 node fully configurable from UI without touching JSON; form engine importable independently of the node panel.

### P2-T3.5 · Node detail view (n8n-style NDV) + data mapping
Double-click a node → modal with INPUT pane | parameters | OUTPUT pane (schema/table/JSON views, per-port tabs). Data comes from the latest execution: executor records capped per-step I/O snapshots (`StepLogEntry.input/output`, 20-item cap) → server persists into `exec_logs` → `GET /api/executions[/:id]` → editor run-data store maps logs onto canvas nodes. Drag a field row from a data pane onto any expression input → inserts `{{ $json.path }}` at the caret (custom MIME `application/x-ctb-field-expr`, defined in the form engine's pure half so form/* stays canvas-free). Per-node "n items" run badge on canvas.
**Accept:** run demo flow → double-click any node → see real input/output items; drag `name` from output schema onto a sendMessage text param → expression inserted; core/server/editor tests green.

### P2-T4 · Flow lifecycle UI
Save = new `flow_versions` row; activate/deactivate; version list + rollback; validation errors surfaced on canvas (badge on offending node).
**Accept:** rollback restores older graph; activating an invalid flow is blocked with a pointed error.

### P2-T5 · Executions inspector
Executions page: list w/ status filter; detail view = node-by-node log (input/output JSON, duration, error), live-ish refresh; "waiting" executions show what they wait for; cancel button.
**Accept:** run demo flow, inspect every node's I/O in UI; cancel a waiting execution.

### P2-T6 · MVP nodes, wave 2
`tg.menu` (buttons→ports, edit_in_place), `flow.switch`, `flow.wait` (durable delay), `http.request`, `data.kv`, `flow.manualTrigger` — specs per NODES.md, contract tests, panel widgets.
**Accept:** node tests green; menu ports render as separate edges on canvas.

### P2-T7 · Code node + editor
`data.code` per NODES.md on the P1-T2 sandbox (run-once / per-item modes, `$http` capability with allow-list, console→exec log); CodeMirror integration with `$`-scope autocomplete stubs.
**Accept:** contract tests incl. timeout & capability limits; write code in UI, run via manual trigger, see console output in inspector.
**🎬 PHASE 2 DEMO:** non-programmer builds: menu → 2 branches → 3-question form → Code node transforms answers → HTTP POST to webhook.site → confirmation message. Entirely in the browser.

---

# PHASE 3 — Flow power features

| Task | Scope | Accept |
|---|---|---|
| P3-T1 | `flow.executeSubFlow` + `flow.return` | parent⇄child item passing test; recursion depth cap |
| P3-T2 | `flow.loop` (batches) + `flow.merge` (append/wait-both) | n8n-semantics contract tests |
| P3-T3 | `tg.editMessage`, `tg.deleteMessage`, `tg.answerCallback`, `tg.chatAction` | per NODES.md |
| P3-T4 | Credentials store (encrypted CRUD + UI) + credential selector in `http.request` | secrets never returned by API in plaintext |
| P3-T5 | Users page + `data.userProfile` node (tags, profile fields) | generic only — no domain fields |
| P3-T6 | Execution policies (replace/queue/ignore) + per-flow error-handler flow | router tests for each policy |
| P3-T7 | Flow import/export JSON + starter template gallery (feedback form, quiz, FAQ menu, reminder — all generic) | export→import→identical semantics |

**🎬 DEMO:** reusable "collect contact info" sub-flow used by two parent flows; one exported and re-imported.

# PHASE 3.5 — Collections (structured data + auto-generated admin panel)

> Contract: ARCHITECTURE §13. Node specs: NODES.md (`data.collection`, `collection.recordChanged`).
> Decision log #9–#11. Core stays domain-agnostic — these are generic primitives (invariant I2 intact).

### P3.5-T1 · Collections data layer
**Files:** `packages/shared/src/collection.ts` (`CollectionSchema` Zod: field types text/longText/number/boolean/select/multiSelect/date/dateTime/image/file/json/relation/group + validation/display props; `RecordFilter` shape per §13.4), Drizzle tables `collections`/`records`/`files` + migration, `apps/server/src/collections/store.ts` (CRUD + filter→`json_extract` SQL compiler + computed-index DDL for fields flagged `indexed`), record validation against collection schema (additive-safe defaults, lazy migrate on write).
**Accept:** round-trip tests: define schema with `group`+`relation` → insert/validate/find with where+sort+limit; invalid write rejected with field-level errors; indexed field actually creates an SQLite expression index; schema field-add then read old record → defaults applied.
**Verify:** `npm run verify`

### P3.5-T2 · Records REST API + operator role
**Files:** `apps/server/src/api/collections.ts` (collections CRUD — admin only) + `api/records.ts` (records CRUD + query, filter shape shared with store), auth: `role: admin|operator` on sessions (env-configured operator user in v1), route guards (operator → records/files only), file upload endpoint backed by `files` table (local disk dir `CTB_DATA_DIR/files`).
**Accept:** API tests: operator can CRUD records but gets 403 on `/api/bots`, `/api/flows`; admin can do both; uploaded image retrievable; filter query parity with store tests.
**Verify:** `npm run verify`

### P3.5-T3 · Schema builder UI
**Files:** editor Data section: collections list, "new collection" → visual field-row builder (type picker, label fa/en, required/default/validation, indexed toggle, `group` sub-field editor, `relation` target picker), display hints (list columns, default sort).
**Accept:** create the demo `products` + `shipping_methods` + `orders` collections entirely in UI; resulting schema JSON validates against `CollectionSchema`; destructive edit (remove field) shows record-count warning.
**Verify:** `npm run verify` + manual checklist in PR

### P3.5-T4 · Auto-generated CRUD panel
**Files:** list view (server-side pagination, search, filter builder, sortable columns from display hints) + record form rendered by the P2-T3 form engine extended with widgets: image upload, `group` repeating rows, `relation` picker (search dropdown). RTL/fa verified.
**Accept:** operator persona test: add a product with 3 variants and a photo, edit stock of one variant, filter list by select field — zero canvas exposure; all writes validated.
**Verify:** `npm run verify` + manual checklist in PR

### P3.5-T5 · `data.collection` node + `collection.recordChanged` trigger
**Files:** `packages/nodes/src/data.collection.ts`, `collection.recordChanged.ts` per NODES.md; record-write event bus in server (panel/API/flow writes → trigger router; `suppress_events`; depth-1 loop guard); editor widgets: collection selector, where-rows, field-mapping rows.
**Accept:** contract tests per NODES.md (find→N items, empty port, insert validation failure, update merge/replace on group, count, delete guard); trigger fires on panel write, does NOT re-fire from its own flow's write; condition + field_filter honored.
**Verify:** `npm run verify`

### P3.5-T6 · Starter templates: catalog + order intake (generic)
**Files:** template gallery additions: sample `catalog` + `orders` collection schemas + two flows — "browse records → variant menus → KV cart → insert order" and "recordChanged(status) → notify chat" — written only against generic primitives.
**Accept — 🎬 PHASE 3.5 DEMO (the manager test):** documented end-to-end run: operator builds data in panel; customer browses/orders in Telegram; operator flips order status; customer gets notified. Kill server mid-order-conversation → resumes (I4).
**Verify:** `npm run verify` + scripted e2e with fake transport

# PHASE 4 — Open protocol (n8n & the outside world)

| Task | Scope |
|---|---|
| P4-T1 | Webhook Trigger (async + sync) + `flow.respondToWebhook`, per-flow secrets, optional HMAC |
| P4-T2 | Schedule Trigger (croner, timezone; for-each-user fan-out w/ rate limit) |
| P4-T3 | Public REST API (bearer tokens): trigger flow, send message, query users/executions |
| P4-T4 | Outgoing instance webhooks (`execution.finished`, `user.first_seen`, …) |
| P4-T5 | Complete docs/PROTOCOL.md + two documented n8n recipes |

**🎬 DEMO:** n8n workflow triggers a CTB flow → CTB converses with a user → user's answer returns to n8n (sync webhook).

# PHASE 5 — AI nodes

| Task | Scope |
|---|---|
| P5-T1 | `ai.llmChat` — OpenAI-compatible credential (base_url+key), memory=conversation via KV |
| P5-T2 | `ai.classify` (LLM-powered switch, port per category) + `ai.extract` (schema-constrained JSON) |
| P5-T3 | `ai.mcpClient` — list/call tools on an MCP server credential |
| P5-T4 | `ai.agent` — tool loop (tools = MCP tools + flows-as-tools), step/cost budget caps |

**🎬 DEMO:** support bot: classify intent → FAQ branch answers via LLM w/ memory → "human" branch notifies an admin chat.

# PHASE 6 — Hardening & 1.0

Postgres driver option · execution retention/pruning · sandbox v2 evaluation (isolated-vm) · metrics dashboard · multi-admin/roles · community node loading spec · docs site + sample flow library.

---

## ➡️ After PLAN.md: see `docs/PLAN2.md`

When every phase above is complete, the active roadmap becomes **`docs/PLAN2.md`**
— the n8n-parity expansion: full Telegram media, a generic data-transform node
library (Edit Fields / Filter / Split Out / Aggregate / Sort / Date-Time incl.
Jalali), real **database connectors** (Postgres / MySQL), an **AI Agent with
attached sub-nodes** (Chat Model / Memory / Tool) via a new typed-sub-connection
model, **speech** nodes (STT/TTS), and an **API + MCP** builder surface so
external agents can discover the node library and assemble workflows. PLAN2 is a
design doc until PLAN.md is done; the active task pointer always lives in STATE.md.

---

## Risk register (read when stuck)

| Risk | Mitigation |
|---|---|
| Wait-matching ambiguity (which execution gets the update?) | one waiting execution per (flow,chat); policies in P3-T6; deterministic priority documented in router tests |
| Sandbox escape | capability-injection only (I6); sandbox tests are blocking; v2 isolated-vm planned |
| Graph JSON drift between editor and engine | single Zod schema in `shared` is the only definition; both sides parse with it |
| Telegram rate limits on broadcasts/fan-out | centralized sender token-bucket from day one (P1-T5) |
| TS/tooling major-version churn | versions pinned above; majors only in P6 |
| Scope creep toward domain features | invariant I2; refuse in PR review. Collections/`data.collection` are generic primitives — any "product"/"order" semantics live only in user schemas and templates |
| Collections JSON storage hits query limits | computed `json_extract` indexes; documented bot-scale expectation (§13.3); Postgres JSONB path in P6 |
