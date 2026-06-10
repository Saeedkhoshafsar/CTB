# CTB Roadmap

> Principle: every phase ends with something **demoable end-to-end** — a real bot doing a real conversation through the visual editor. No phase ships engine work without a way to see it.

## Phase 0 — Foundation (repo & contracts)

**Goal:** monorepo skeleton compiles, contracts frozen.

- [ ] npm workspaces: `apps/server`, `apps/editor`, `packages/{shared,core,nodes,sandbox}`
- [ ] `packages/shared`: FlowGraph / FlowItem / NodeDef / Execution types + Zod schemas
- [ ] Drizzle schema + migrations (SQLite), `CTB_SECRET` crypto helper
- [ ] Fastify server boots, health endpoint, admin auth (env user/pass), editor served
- [ ] CI: typecheck + test on push; Dockerfile + docker-compose
- [ ] docs/PROTOCOL.md stub

**Demo:** `docker compose up` → login page → empty dashboard.

## Phase 1 — Engine core + Telegram gateway

**Goal:** the pause/resume engine works against a real bot — flows defined in JSON (no editor yet), driven by tests + one sample flow.

- [ ] `core`: executor loop (step, edges, ports), execution persistence, checkpointing
- [ ] WAIT mechanics: serialize → store → resume on matching update; timeout scanner
- [ ] Expression engine (sandbox-backed `{{ }}`, full `$` scope)
- [ ] grammY gateway: register bot (token → webhook/polling), normalized TgEvent, centralized rate-limited sender
- [ ] Update router: waiting-execution match → resume; else trigger match → start
- [ ] Nodes (minimal set, code-defined): Telegram Trigger, Send Message, Wait for Reply, IF, Set Fields, Stop & Error
- [ ] Unit tests: engine stepping, wait round-trip serialization, expression eval

**Demo:** register a bot token via API → sample "ask name → ask age (validated, retry) → greet with both" flow JSON → works on real Telegram, survives a server restart mid-conversation.

## Phase 2 — Visual editor (MVP) ✨

**Goal:** build that same flow with the mouse. This is the moment CTB becomes a product.

- [ ] React Flow canvas: add/drag/connect/delete nodes, multi-port edges, zoom/minimap
- [ ] Side panel auto-generated from node `paramsSchema` (text, multiline, select, button-grid builder, condition rows, expression hints)
- [ ] Flow CRUD + versioning (save = new version, rollback), draft vs active
- [ ] Bots page: add token, set webhook, status
- [ ] Executions page: list, status, per-node log inspector (input/output JSON)
- [ ] Manual Trigger ("test with sample data")
- [ ] Remaining MVP nodes: Menu (button ports), Switch, Wait/Delay, HTTP Request, Storage (KV), Code (JS) with sandbox + code editor (CodeMirror)
- [ ] RTL-friendly UI, fa/en i18n scaffold

**Demo:** non-programmer builds "menu → branch → form (3 questions) → HTTP POST results → confirmation" entirely in the browser.

## Phase 3 — Flow power features

**Goal:** modularity and the rest of the Telegram surface.

- [ ] Execute Sub-Flow + Return node
- [ ] Loop, Merge
- [ ] Edit/Delete Message, Answer Callback, Send Chat Action
- [ ] Credentials store (encrypted) + credential selector in HTTP node
- [ ] User Profile node + Users page (per-bot user list, tags)
- [ ] Execution policies per flow (replace/queue/ignore concurrent), global error-handler flow
- [ ] Import/export flow as JSON; starter template gallery (generic: feedback form, quiz, FAQ menu, reminder)

**Demo:** a reusable "collect contact info" sub-flow used by two different parent flows; flows exported/imported as JSON.

## Phase 4 — Open protocol (n8n & the outside world)

**Goal:** CTB triggers and is triggered by anything.

- [ ] Webhook Trigger (async + sync with Respond to Webhook), per-flow secrets, HMAC option
- [ ] Schedule Trigger (cron, timezone, for-each-user fan-out with rate limits)
- [ ] REST API (token-auth) for external systems: trigger flow, send message, query users/executions
- [ ] Outgoing instance webhooks (execution.finished, user.first_seen, …)
- [ ] docs/PROTOCOL.md complete + n8n recipe examples (n8n→CTB and CTB→n8n)

**Demo:** an n8n workflow triggers a CTB flow that messages a user, waits for their reply, then POSTs the answer back to n8n.

## Phase 5 — AI nodes

**Goal:** AI-native bot building.

- [ ] LLM Chat (OpenAI-compatible credential: base_url+key), conversation memory via KV
- [ ] AI Classify (LLM-powered Switch), AI Extract (schema-constrained)
- [ ] MCP Client node (list/call tools)
- [ ] AI Agent node (tool loop; tools = MCP tools + flows-as-tools), budget caps

**Demo:** support bot: AI Classify routes intent → FAQ branch answers from LLM with memory → "human" branch notifies admin chat and bridges messages.

## Phase 6 — Hardening & 1.0

- [ ] Postgres support, execution pruning/retention settings
- [ ] Sandbox v2 evaluation (isolated-vm / out-of-process) for hostile multi-tenant
- [ ] Metrics (per-flow runs, errors, latency) + simple dashboard
- [ ] Multi-admin accounts & roles
- [ ] Plugin/custom-node loading spec (community nodes)
- [ ] Docs site, screencast, sample flow library

---

## Cross-cutting rules (every phase)

1. **Every code change → commit → PR** (`genspark_ai_developer` branch workflow).
2. New node = spec in NODES.md + Zod schema + contract tests, *then* implementation.
3. Engine changes require a pause/resume serialization round-trip test.
4. No business-specific nodes in core — ever. Generic primitives only.

## Decision log

| # | Decision | Why |
|---|---|---|
| 1 | TypeScript everywhere, drop PHP | one language across engine/editor/sandbox; ecosystem (grammY, React Flow); the old PHP code is reference-only |
| 2 | SQLite default, Postgres later | zero-config self-hosting first |
| 3 | Code node = JS only (v1) | matches stack & n8n habit; Python via HTTP/sub-process possible later |
| 4 | Conversation state via durable `executions` table, not in-memory sessions | survive restarts; long waits (days) are first-class |
| 5 | Editor-first roadmap (editor at Phase 2, not last) | the product *is* the visual builder; engine without UI is invisible |
| 6 | No domain nodes (shop/VPN) | CTB is a general tool; domains live in flows/templates/plugins |
