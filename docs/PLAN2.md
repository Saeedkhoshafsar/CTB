# PLAN2 — The n8n-parity expansion (post-PLAN.md roadmap)

> **Read order:** finish every task in `docs/PLAN.md` first. When PLAN.md is
> done (through Phase 6), this file becomes the active roadmap. Same constitution
> applies (CLAUDE.md): one task at a time, spec-before-code, `npm run verify`
> green at every commit, STATE.md updated in the same commit, work on
> `genspark_ai_developer`, one open PR to main.
>
> **Why this file exists.** PLAN.md takes CTB to a complete, self-contained
> conversational-automation platform. PLAN2 closes the gap with what power users
> expect from **n8n** specifically: a rich library of generic data-transform
> nodes, real database connectors, full Telegram media, an **AI Agent with
> attached sub-nodes** (Chat Model / Memory / Tool), and a friction-free
> **API + MCP surface** so external agents can discover and wire our nodes.
>
> **The vision in one line (the user's words):** *"a space where API and MCP can
> reach this project without much effort, see that the nodes and code we'd
> otherwise spend hours writing already exist, and just snap them together into
> the workflow they want."*

---

## North-star principles (carried from PLAN.md, never broken)

- **I2 — generic only.** No domain nodes. A "Postgres" node is generic
  infrastructure; a "shop order" node is not. Database/AI/media nodes are all
  generic primitives; any business meaning lives in user schemas/templates.
- **I3 — dependency direction.** `shared ← sandbox ← core ← nodes ← apps/server`.
  `core` never imports a DB driver / Telegram / an LLM SDK — capabilities are
  injected by the host (`apps/server`).
- **I5 — Zod schema first in `shared`.** Every node param + every new contract
  (incl. the new sub-connection types) is a Zod schema in `packages/shared`
  before any implementation.
- **I6 — no ambient authority.** Nodes touch the world only through injected
  `NodeCtx` capabilities. New capabilities (`db`, `agent`, `mcp`, `speech`,
  `files`) follow the exact pattern: nullable, fail-loud when absent.
- **I7 — secrets encrypted at rest** (AES-256-GCM via `CTB_SECRET`), never
  logged/committed/returned; the host resolves `credentialId → secret`, the node
  only ever sees the id.

---

## The one big new architectural idea: typed sub-connections

Today every edge is a `main`-style data edge (`FlowEdge.from/to.port`, default
`main`). n8n's AI nodes use a *second kind* of wire: an **attachment** that says
"this Chat-Model node IS the brain of that Agent", drawn from a port *below* the
consumer, not a left-to-right data hop.

CTB already supports this with **zero schema breakage** because `PortName` allows
`:` — we reserve a namespace:

| Sub-connection | Reserved port id | Provider node category | Consumer |
|---|---|---|---|
| Chat Model | `ai:model` | `model` | `ai.agent`, future chains |
| Memory | `ai:memory` | `memory` | `ai.agent` |
| Tool | `ai:tool` | `tool` | `ai.agent` |
| (future) Retriever | `ai:retriever` | `retriever` | RAG chains |
| (future) Embeddings | `ai:embeddings` | `embeddings` | vector store |

**Rules (enforced in `shared/flow-validate.ts` + editor `canConnect`):**
- A provider node (category `model`/`memory`/`tool`/…) exposes a single output
  port `ai:<kind>` and **no `main` output** — it can't sit in the data stream.
- The consumer (`ai.agent`) declares typed *input slots* (`ai:model` required,
  `ai:memory` optional, `ai:tool` repeatable) separate from its `main` in/out.
- The executor never "runs" a provider node as a step; instead the host resolves
  the agent's attached providers at agent-execution time (they're config, not
  flow steps). This keeps the executor's main loop unchanged (I3/I4-safe).

This is the single most important deliverable of PLAN2 — everything in Phase B
depends on it.

---

# PHASE A — Telegram media completeness + data-transform node library

> Goal: a CTB flow can do everything an n8n "core nodes" flow can, for the
> conversational domain. No AI required to be useful.

| Task | Scope |
|---|---|
| **PA-T1** | **Telegram media — send.** Extend `tg.sendMessage` (or a sibling `tg.sendMedia`) to upload **bytes** (not just URL/file_id): from a Collection file id, a `data.code`/`http.request` binary, or base64. Add **media groups / albums** (2–10 photos/videos in one message). Caption + parse-mode + keyboard preserved. |
| **PA-T2** | **Telegram media — receive.** New `tg.getFile` node: given a `file_id` (from a photo/voice/document/video message the trigger captured), download it via the Bot API and store it (reuse the P3.5 `SqliteFileStore`), emitting `{file_id, path, mime, size, url}` for downstream nodes. This is the left half of the user's screenshot ("Get a file"). |
| **PA-T3** | **`data.editFields`** — the n8n **Edit Fields / Set** node, first-class. (We have `data.setFields`; this task makes it a power node: keep-only-set vs keep-all modes, dotted-path set/unset, rename, JSON-value mode, per-row enable, and an editor label "Edit Fields (Set)" so n8n users find it.) Likely an evolution of `data.setFields` + a relabel, not a brand-new node. |
| **PA-T4** | **`data.filter`** — pass through only items whose conditions hold (reuses the `flow.if` condition engine; outputs `kept` / `discarded` ports). |
| **PA-T5** | **`data.splitOut` + `data.aggregate`** — split an array field into one item per element (n8n Split Out); aggregate many items back into one array/summary (n8n Aggregate). The inverse pair, hugely used. |
| **PA-T6** | **`data.sort` + `data.limit` + `data.removeDuplicates`** — ordering, top-N, dedupe-by-key. Small, pure, high-value item-list ops. |
| **PA-T7** | **`data.dateTime`** — parse / format / add-subtract / diff, IANA timezones **and Jalali (Persian) calendar** output (our users are Iranian — formatting `۱۴۰۴/۰۳/۲۴` is a real need). Pure, well-tested. |
| **PA-T8** | **🎬 Phase-A demo** — a flow using only Phase-A nodes: user sends a list/photo → flow splits, filters, formats dates (Jalali), aggregates, replies with a media album. Doc + scripted e2e. |

**Phase-A acceptance:** every node generic (I2), Zod-first (I5), ≥3 contract
tests each, `npm run verify` green, NODES.md updated.

---

# PHASE B — Database connectors + the AI Agent with sub-nodes

> Goal: reproduce the user's screenshot end-to-end — Telegram voice → transcribe
> → **AI Agent (Chat Model + Memory + Tool)** → TTS → send audio — using CTB's
> own generic primitives.

## B.1 — Typed sub-connections (foundation)

| Task | Scope |
|---|---|
| **PB-T1** | **Sub-connection contract.** Shared (I5): extend `NodeDef` with optional typed input *slots* (`{ kind:'ai:model'\|'ai:memory'\|'ai:tool', required, repeatable }`) and a node `role: 'data' \| 'provider'`. Add provider-port rules to `flow-validate.ts` + editor `canConnect` (a `model` node only plugs into an `ai:model` slot, etc.). Render attached sub-nodes *below* the consumer on the canvas (dashed wire), distinct from data edges. Executor: providers are resolved as agent config, never run as steps. **No behavior change to existing flows.** |

## B.2 — Database connectors (generic, I2)

| Task | Scope |
|---|---|
| **PB-T2** | **`db.postgres`** — a generic Postgres node: `query` (parameterized SQL, bound params — never string-concat), `insert`/`update`/`select`/`delete` helpers, connection via a new `postgres` credential (host/port/db/user/pass/ssl, encrypted I7). Host owns the `pg` pool (I3 — driver lives in `apps/server`, injected as `ctx.db`). Result rows → items. |
| **PB-T3** | **`db.mysql`** — same shape over MySQL/MariaDB (`mysql2` driver, `mysql` credential). Shares the `ctx.db` capability contract so flows look identical except the credential. |
| **PB-T4** | **Postgres Chat Memory provider** — a `memory`-role node `ai.memory.postgres` that the Agent attaches via `ai:memory`. Persists rolling chat history in a Postgres table (the screenshot's "Postgres Chat Memory"); also a default `ai.memory.kv` provider backed by our existing KV so users without Postgres still get memory. |

## B.3 — The AI Agent + tools

| Task | Scope |
|---|---|
| **PB-T5** | **`ai.agent`** — the orchestrator. Inputs: `main` (the user turn) + typed slots `ai:model` (required), `ai:memory` (optional), `ai:tool` (repeatable). Runs the tool-calling reasoning loop (OpenAI-functions style) with **hard caps**: max steps, max tokens, wall-clock budget (cost safety). Streams each reasoning step / tool call into the execution log (observability like n8n). Built on the existing `ctx.ai` capability + a new `ctx.agent` runner in the host. |
| **PB-T6** | **Tool nodes (nodes-as-tools).** Make selected nodes attachable as `tool`-role: **`tool.httpRequest`** (agent calls an API), **`tool.code`** (sandboxed JS tool), **`tool.think`** (the screenshot's "Think" — a no-op scratchpad that improves reasoning), **`tool.subflow`** (expose any CTB flow as a callable tool = n8n "Workflow Tool", our killer feature since flows are already pausable/resumable). Each tool's description drives agent tool-selection. |
| **PB-T7** | **Speech nodes** — `ai.speechToText` (transcribe a voice/audio file via an OpenAI-compatible `/audio/transcriptions`) + `ai.textToSpeech` (`/audio/speech` → an audio file id usable by `tg.sendMedia`). Completes the screenshot's transcribe + TTS legs. Provider via the `openAiApi` credential we already have. |
| **PB-T8** ✅ | **🎬 Phase-B demo (DONE)** — rebuilt the user's exact screenshot in CTB: Telegram voice note → `ai.speechToText` (owns the `ctx.tg.getFile` download) → `ai.agent` (model+memory+tool **slots**: `ai.modelOpenai` + `ai.memoryPostgres` + `tool.think` + `tool.httpRequest`) → `ai.textToSpeech` → `tg.sendMedia` (audio, `source:'file'`). Fixture `packages/shared/test/fixtures/phase-b-voice-flow.json`; scripted e2e `apps/server/test/e2e-phaseB-voice-demo.test.ts` (2 tests: the full hear→reason→speak loop incl. the HTTP-tool call, and cross-call **Postgres memory replay**) on the REAL Executor + slot resolver + agent loop with fake transports; walkthrough `docs/demos/phase-B-voice.md`. **Phase B COMPLETE.** |

## B.4 — Carry-over from PLAN.md Phase 5 (kept, sequenced here)

`ai.classify`, `ai.extract` (PLAN P5-T2) and `ai.mcpClient` (P5-T3) land in
PLAN.md's Phase 5; PLAN2's Agent (PB-T5) supersedes/absorbs PLAN P5-T4's
`ai.agent` with the richer sub-node design above. If P5-T4 ships first as a
minimal agent, PB-T5 upgrades it to the attached-provider model.

---

# PHASE C — The open builder surface: API + MCP discovery

> Goal: the user's headline ask — external systems and AI agents reach CTB with
> minimal effort, **discover** the node/credential/flow library, and assemble
> workflows programmatically.

| Task | Scope |
|---|---|
| **PC-T1** ✅ | **Node catalog API (DONE).** `GET /api/v1/node-types` — the internal `/api/node-types` projection promoted to the public bearer-auth v1 surface: each node's `type`, `category`, `meta` (labelKey/descriptionKey/icon → the i18n keys for fa/en human text), `ports`, JSON-Schema `params`, and the typed sub-connection surface (`role`/`inputSlots`/`provides`). SAME projection as the engine registry (so it can never advertise a node the engine can't run); any valid token (instance-wide or bot-scoped) may read it — the library is bot-agnostic. `apps/server/src/api/v1.ts` reuses `nodeTypeInfos(registry)`; tests in `api-v1.test.ts` (6: auth 401×2, registry parity, the AI typed-slot surface, bot-scoped read, byte-identical to internal). PROTOCOL.md §REST API updated. |
| **PC-T2** ✅ | **Flow authoring API (DONE).** `POST /api/v1/flows` (create draft; `botId`/`bot_id` alias; `graph` defaults empty) + `PATCH /api/v1/flows/:id` (edit name/graph/settings; graph change snapshots the old version + bumps `version`; same-bot error-handler rule) + `POST /api/v1/flows/:id/validate` (DRY-RUN — returns `{ ok, problems, nodeProblems }` without saving) + `/activate` (422 `not_activatable` with problems, else flips to active + re-arms schedules) + `/deactivate`. All reuse the SAME shared `CreateFlowBodySchema`/`UpdateFlowBodySchema`/`FlowGraphSchema` + `validateFlowForActivation` as the panel (I5), so a v1-authored flow is identical to an editor-built one. Bot-scoped tokens may only author on their own bot (403). `apps/server/src/api/v1.ts` + `app.ts` (`onFlowsChanged`→`scheduler.reconcile`); tests in `api-v1.test.ts` (+13). PROTOCOL.md §REST API updated. |
| **PC-T3** ✅ | **CTB as an MCP _server_ (DONE).** `POST /api/v1/mcp` — a streamable-HTTP **JSON-RPC 2.0** endpoint (implemented natively, NO MCP SDK dep) mounted INSIDE the existing bearer-auth `/api/v1` scope, so it shares the same token guard + the same engine handles + the same shared schemas as the REST routes (I5 — a flow built over MCP equals one built over REST). Methods: `initialize` (protocol `2025-06-18`, `serverInfo {name:"ctb"}`), `notifications/*` (202 ack), `ping`, `tools/list`, `tools/call`. Six tools, each bounded by the token's bot scope: `list_nodes` (= the PC-T1 catalog), `validate_flow` (dry-run), `create_flow` (draft; `bot_id` alias), `trigger_flow` (async run, item `source:"mcp"`), `query_collection` (read a bot Collection by slug + record filter), `send_message` (centralized sender). Tool-level problems set `isError` on the result; protocol problems return JSON-RPC errors. This is the inverse of PLAN P5-T3 (`ai.mcpClient`, where CTB consumes MCP). New `apps/server/src/api/mcp.ts` + `mcp-deps.ts`; shared MCP envelope types in `api.ts`; `v1.ts` mounts it + passes `collectionStore`; `app.ts` wires the store. Tests in `apps/server/test/mcp.test.ts` (+23). PROTOCOL.md §MCP server added. |
| **PC-T4** ✅ DONE | **MCP _client_ tool node:** `tool.mcp` — a `role:'provider'`/`provides:'ai:tool'` node (no data ports; one `mcpServer` `credentialId` param) that attaches a remote MCP server's tools to `ai.agent`, so a CTB agent can use any MCP tool in the wild. The agent maps it to an `mcp` tool source by node type (`toolSourcesFromSlots`) and expands it via `ctx.mcp` (reuses P5-T3). NOT the same as P5-T3's `ai.mcpClient` (a standalone main-flow list_tools/call_tool node) — PC-T4 is the canvas/slot form for the agent. Registry 53→54; NODES.md + fa/en i18n + tests (`ai-tool-nodes.test.ts` e2e, `node-types.test.ts`). |
| **PC-T5** ✅ | **Builder docs + recipes (DONE).** PROTOCOL.md gained the **"Authoring & MCP"** chapter: the *discover → build → validate → activate → trigger* lifecycle (diagram + the I5/I2 safety invariants), **Recipe A** (a `curl` script that walks all five steps) and **Recipe B** (an AI agent doing the same over MCP — `list_nodes`/`validate_flow`/`create_flow`/`trigger_flow` + self-correction on validate), and a "which surface for which job" quick-reference; the intro table + the MCP quick-start now point at it. 🎬 demo `apps/server/test/e2e-phaseC-authoring-demo.test.ts` (2 tests on the REAL wired engine + fake Telegram transport): an external agent reads `GET /api/v1/node-types`, assembles a 3-node flow (`flow.manualTrigger → data.setFields → tg.sendMessage`), `validate`s it (ok, nothing saved), `activate`s it, `trigger`s it, polls `GET /api/v1/executions` to `done`, and asserts the bot sent the composed `{{ $json.greeting }}` message; plus a safety-rail test proving a graph with a non-catalog type (`shop.checkout`) fails validate/activate. Walkthrough `docs/demos/phase-C-authoring.md`. **Phase C COMPLETE.** |

---

# PHASE D — Hardening for the new surface

| Task | Scope |
|---|---|
| **PD-T1** ✅ | **DB connection pooling + safety** — pool limits, statement timeouts, read-only credential option, SQL-injection test battery for `db.postgres`/`db.mysql`. |
| **PD-T2** ✅ | **Agent cost governance (DONE)** — per-bot daily AI budget (`maxCallsPerDay`/`maxTokensPerDay`/`maxTokensPerRun`, stored in `bots.settings.aiBudget`) enforced **fail-closed BEFORE** each provider call and **metered AFTER** in an `ai_usage` ledger. The `ctx.ai` capability became a per-run factory `(botId, flowId, executionId)` (`makeAiFactory` in wire.ts) so it can read the bot's budget + today's totals and refuse a call that would exceed the cap (`0` = unlimited), then record one `ai_usage` row per successful chat (attributed to bot/flow/execution + credential + model). Panel: a per-bot **AI budget** panel + **usage** view (`GET /api/bots/:id/ai-usage`, `PUT /api/bots/:id/ai-budget`); fa/en i18n. Tests `ai-cost-governance.test.ts` (6). |
| **PD-T3** ✅ | **MCP/API rate limiting + audit (DONE)** — **per-token rate limiting**: each `api_tokens` row carries `rate_limit_per_min` (default 120, `0`=unlimited); the v1 bearer-auth preHandler checks an in-memory sliding-window `RateLimiter` (process-local — the right scope for CTB's single-process architecture) and returns **429 + `retry-after`** on breach, keyed per-token. **Append-only audit log**: a new `api_audit` table + `SqliteApiAuditStore`; a v1 `onResponse` hook records one row (tokenId, target botId, action, method, route, targetId, status, ts) per AUDITED authoring/trigger/send call — plain reads are not audited, a 403/422 is logged just like a success, and a rate-limited (429) call leaves no row. `GET /api/v1/audit` surfaces the trail (instance-wide token sees all/filterable by bot; a bot-scoped token is locked to its own bot). Migration `0005`. Tests `api-rate-audit.test.ts` (25 — limiter + store unit tests + e2e 429/audit/scope). |
| **PD-T4** ✅ | **Node library docs site (DONE)** — a browsable, bilingual (fa/en) reference of every node, **auto-generated from the catalog** (`GET /api/node-types`). No node is hardcoded: a pure transform (`pages/node-docs/model.ts`) groups the `NodeTypeInfo[]` by category (palette order; unknown categories appended) and projects each node's **params** (key, required\*, type summary, default, description — reusing the form engine's `objectFields` so the documented shape can't drift from what the form collects, I5), **ports** (in/out, dynamic-out flagged), and **typed-connection facts** (role / input slots / provides, PB-T1). Page `pages/NodeDocsPage.tsx` at `/docs` (nav "Node Library"): fetches the catalog once, renders category sections + node cards with fa/en label/description from the `meta` i18n keys, plus a free-text search over type/label/description/param keys. The "the work is already done, just connect them" promise made browsable — copy a node's `type` straight into a v1/MCP call. Tests `node-docs-model.test.ts` (21 — summarizeType/defaultText/paramsOf/buildDocs/filterDocs + a build against the live fake `/api/node-types`). |

---

# PHASE E — Live voice AI (real-time Telegram calls) `🎙️ NEW`

> **Origin:** user request (2026-06-18). The headline ask: a node that connects an
> **AI to LIVE Telegram voice conversations** — (1) an **AI online voice-support
> agent** that answers callers in real time, and (2) a **channel-livestream Q&A
> moderator** that grants speaking turns to listeners (sequential / random,
> configurable) and answers them one by one. "We add the bot to a channel/group,
> make it admin, and a configurable node covers the different scenarios."
>
> **Design principle the user set (2026-06-18, MUST honour):** *don't bake a single
> path into the roadmap and thereby narrow the other options* — instead **make the
> nodes multi-purpose and put the choice in the node's own settings.** So Phase E
> picks **no** transport/mode here; every fork below is a **node/credential
> setting**, decided per-flow by the author, not a phase-level decision. (This is
> just invariant **I2 — generic only** — applied to voice: a "Voice Call" node is a
> generic capability, the scenario lives in the user's config.) The user also noted
> that, like adding a helper bot such as `@myidbot` alongside our own bot, the
> design must allow **a companion/helper account to carry a leg** — so the *who
> connects the audio* is also a setting, not a hard-coded assumption.

## E.0 — Feasibility findings (researched 2026-06-18) — turned into SETTINGS, not forks

| Question | Finding | How it becomes a *node/credential setting* (no roadmap lock-in) |
|---|---|---|
| Does the **Bot API** expose voice/video calls or group voice chats? | **No.** Confirmed by Telegram docs + community (Latenode, May 2025). The Bot API has *no* call/voice-chat methods. | Not a choice — it's a constraint. The audio leg always rides MTProto; the **`voiceConnection` credential** (E.2) abstracts "who connects", so a flow never hard-codes it. |
| What *can* join a Telegram voice chat / place a 1:1 call? | **MTProto** via `tgcalls`/`pytgcalls` (Python) or `tgcalls`/`gram-tgcalls` (JS), driving **WebRTC** (`ntgcalls`). Streams raw **PCM** in/out of group **and** 1:1 calls. | The **same** Call Session Service handles both group and 1:1; *which* a given flow uses is the `trigger.callEvent` / `call.connect` **`target` setting** (a chat id, a channel, or a user) — one node, every scenario. |
| Who carries the audio — our bot, or a companion account? | A **bot token cannot join calls**; a **user session** must. But that user session can be **the operator's own userbot OR a delegated "companion" account** added to the group alongside our Bot-API bot (the `@myidbot`-style helper the user described). | The **`voiceConnection` credential** has a `kind` setting: `userbot` (a session string the operator owns) — and is forward-shaped for `companion`/`external` providers. The flow just references a credential; swapping the connector never touches the graph. |
| Node-native (JS) vs Python (`pytgcalls`) media engine? | Both exist; Python is more battle-tested, JS keeps one language. | **Not a user-facing choice and not locked here.** It's an **internal host adapter** behind the `ctx.call` interface (E.1). The host can ship a JS adapter and/or a Python-sidecar adapter; nodes/flows are 100% agnostic. We pick the implementation when we build PE-T2, and can change it later without touching a single node. |
| Is the audio a request/response, like every other node? | **No** — a continuous bidirectional stream for the whole call. | The stream stays in a **host service**; flows see discrete **events** (trigger) + **actions** (`ctx.call.*`). Unchanged executor model. |

**Verdict:** feasible and high-value. The weight (a long-lived service + a native
media dep + a session credential) is **isolated in the host**; the *product surface*
is just a few generic, **fully-configurable** nodes — so building it narrows
nothing else.

## E.1 — The architecture (how it fits CTB's invariants)

Same move as Telegram updates + the scheduler: the *real-time, stateful* work lives
in a **host service**; flows stay **stateless and event-driven**. A live call
becomes discrete *events* that **trigger** a flow, and a small set of *actions* the
flow can **invoke**. The connector and the mode are **settings**, not branches.

```
          ┌─────────────────── apps/server (host) ───────────────────┐
          │  Call Session Service (NEW, long-lived, like scheduler)   │
          │   • pluggable connector adapters behind ONE ctx.call iface:│
          │       - userbot   (gram-tgcalls / pytgcalls sidecar)       │
          │       - companion (a delegated helper account)   [later]   │
          │       - external  (a 3rd-party voice bridge)     [later]   │
          │   • WebRTC media in/out (PCM frames)                       │
          │   • turn-taking queue: mode + order are PER-CALL settings  │
          │   • VAD + chunked STT  →  emits "utterance" events         │
          └───┬───────────────────────────────▲──────────────────────┘
   emits events│ (callJoined, turnOpened,      │ invokes actions
   → TRIGGER   │  utteranceFinal, callLeft)    │ (ctx.call.speak / grantTurn /
   a flow      ▼                               │  muteTurn / endTurn / leave)
          ┌────────────────────── a CTB flow ───────────────────────┐
          │  trigger.callEvent  →  ai.speechToText (reuse PB-T7!) →   │
          │  ai.agent (model/memory/tools, reuse PB-T5/T6)  →         │
          │  ai.textToSpeech (reuse PB-T7)  →  call.speak             │
          └──────────────────────────────────────────────────────────┘
```

Two design rules that keep everything open:
- **One interface, many adapters.** `ctx.call` is a single typed capability; the
  *connector* (userbot now; companion/external later) is chosen by the referenced
  **`voiceConnection` credential**, never by the node type. Adding a new connector
  is a host adapter + a credential `kind` — **zero** changes to flows or node code.
- **Behaviour = config.** `support` vs `lineup`, `sequential` vs `random`, group vs
  1:1, max turn length, barge-in on/off — all are **fields on the trigger/action
  nodes**, so one set of nodes covers every scenario the user described and more.

Crucially: **STT, the agent, and TTS are already built (PB-T5…PB-T7).** Phase E only
adds the *transport* (the call session) + the *glue* (a trigger + a few action
nodes + a credential). That is the payoff of having done speech first.

## E.2 — Tasks (each fork is a SETTING, not a separate task)

| Task | Scope |
|---|---|
| **PE-T1 ✅** | **`voiceConnection` credential (abstracts "who connects the audio").** ✅ DONE — **Phase E begins.** New encrypted credential (AES-256-GCM, I7) added to the shared `CredentialDataSchema` discriminated union with a **`kind` setting**: `userbot` (`apiId`+`apiHash`+ an MTProto session string the operator owns) shipped first; the schema is forward-shaped so `companion` (a delegated helper account beside our bot, the `@myidbot`-style idea) and `external` (a 3rd-party `bridgeUrl`/`bridgeToken`) drop in later **without a node change**. `credentialHint`/`credentialAuthHeaders` extended exhaustively (the hint shows `kind · ••••<session-tail>`, never the secret; a voice connection injects no HTTP headers — it resolves into a media engine, not a request). **Host (`apps/server/src/engine/voice-connector.ts`, I3):** the `VoiceConnector` adapter interface (`checkHealth`/`connect`/`speak`/`onUtterance`/`leave`) + `CallTarget`/`PcmFrame`/`CallUtterance` types the PE-T2 media engine will implement; `resolveVoiceConnection` validates **fail-closed** (wrong type / a `kind` missing its required fields throws a clear, secret-free `VoiceConnectionError`); `validateVoiceConnection` is the panel's leak-free probe (no adapter wired yet → "structurally valid, login not attempted"; a wired adapter's health surfaced verbatim; any throw → `{ok:false,error}`). **API:** `POST /api/credentials/:id/voice-health` (decrypts host-side, 404 unknown / 409 non-voice, returns `{health}`). **Editor:** Credentials form gained the `voiceConnection` type — a `kind` picker that shows api_id/api_hash/session for userbot/companion or bridge URL/token for external; fa/en i18n parity. **Tests:** NEW `voice-connector.test.ts` (15 — resolve happy/fail-closed per kind, never-leak, health probe with/without adapter) + `api-credentials.test.ts` (+6 — create/encrypt/hint, voice-health 200/false/404/409/401). No audio yet — a verified, swappable connector. (Started a prior session, completed + committed now.) |
| **PE-T2 ✅** | **Call Session Service + the `ctx.call` interface (host runtime, the hard part).** ✅ DONE. **Shared (`node-def.ts`, I5):** `CallTargetRef`/`CallMode`/`CallTurnOrder`/`CallSpeakRequest`/`CallParticipant`/`CallStatus` + the `CallCapability` interface (`connect`/`speak`/`grantTurn`/`endTurn`/`mute`/`leave`/`status`); a **nullable** `call: CallCapability \| null` cap on `NodeCtx` (null on a host with no voice runtime → a `call.*` node fails loudly, I6). **Core (`executor.ts`):** `ExecutorServices.call?` factory + `buildCtx` wiring (mirrors `ai`/`files`; core imports no driver, I3). **Host (`apps/server`):** the long-lived **`CallSessionService`** (`triggers/call-session.ts`, a sibling to the scheduler) holding the connection + per-call state — participants, the lineup **turn queue** (sequential/random `grantTurn` + explicit line-jump, `endTurn`, optional `maxTurnSeconds` auto-advance), `status`, and an `onUtterance` sink (the seam PE-T3 subscribes to). It resolves the `voiceConnection` credential **fail-closed** (host-side decrypt, I6/I7) and drives a **pluggable** `VoiceConnector` — chosen ONLY by the credential, never the node type. `target`/`mode` are **settings** so the SAME service handles a group/channel `lineup` broadcast **and** a 1:1 `support` call. **Hard caps = config + safe defaults (`DEFAULT_CALL_CAPS`, I4):** max concurrent calls (host + per-bot) + max duration (auto-leave); `connect` fails loudly past a cap. The default **`LoopbackVoiceConnector`** (`engine/loopback-connector.ts`) carries NO native dep, so the service is fully testable without MTProto and the userbot engine swaps in at the composition root with zero node/flow change (I3). **Wiring (`wire.ts` + `main.ts`):** built per-process, exposed on `Engine.callSessionService`, `call` factory added to `ExecutorServices`, shutdown `stop()`. **Tests:** NEW `call-session.test.ts` (24). Docs: NODES.md §"Call Session Service + ctx.call". |
| **PE-T3 ✅** | **`trigger.callEvent` (entry node) — one node, all scenarios via settings.** ✅ DONE. Starts a flow on `callJoined` / `utteranceFinal` (carries the caller audio as a CTB file id, ready for `ai.speechToText`) / `turnOpened` / `callLeft`. Settings (this is where the user's "configurable" lives): `connection` (which `voiceConnection` credential), `targetKind`+`targetId` (chat/channel/user), `events` (which to fire on), `mode` = `support` (answer everyone) \| `lineup` (Q&A queue), and for `lineup`: `order` = `sequential` \| `random`, `maxTurnSeconds`, `autoAdvance`. No mode is privileged — they're enum fields. **Shared:** `CallEventTriggerParamsSchema` (`node-params.ts`, I5). **Node:** `callEventTrigger` (`packages/nodes/src/flow/call-event-trigger.ts`) — a pure pass-through like `schedule.trigger` (registry 54→55). **Host:** NEW `triggers/call-events.ts` — the **`CallEventBus`** (sibling of the record-write bus): subscribes to the Call Session Service's `onUtterance` + the NEW `onLifecycle` stream, matches via the PURE `matchCallEvent` (target kind+id + events list — `mode` is carried, not matched), persists an `utteranceFinal` PCM **once** as a CTB file id (`audio/l16`, I6), and fires each matching active flow CHATLESS via the new `router.fireCallEvent`; never throws. `call-session.ts` gained `CallLifecycleEvent`/`onLifecycle`/`emitLifecycle` (fired on connect/grantTurn/leave). Wired into `wire.ts` (`Engine.callEventBus`) + `main.ts` (start/stop). **i18n** en/fa. **Docs:** NODES.md §Live-voice Trigger. **Tests:** `call-event-trigger.test.ts` (7) + `call-events.test.ts` (15, incl. end-to-end via the real service + loopback). |
| **PE-T4 ✅** | **`call.*` action nodes (what the flow does back) — also setting-driven.** ✅ DONE. `call.connect` (join/start a call to a `target` using a `voiceConnection` + `mode`/`order`/`maxTurnSeconds`), `call.speak` (a `source` setting: `file` = a CTB file id like `ai.textToSpeech` output read host-side, or `pcm` = base64 PCM + sample rate), `call.grantTurn` (lineup — next-in-queue or explicit `userId`, saves the granted id under `save_as`)/`call.endTurn`, `call.mute`, `call.leave`. All six are plain flow-category nodes (`main` in/out) going through `ctx.call` (I3/I4/I6), so they work identically across every connector kind + target type, and each FAILS LOUD when `ctx.call === null`. **Shared:** six param schemas in `node-params.ts` (I5). **Nodes:** `packages/nodes/src/call/{connect,speak,grant-turn,end-turn,mute,leave}.ts` (registry 55→61). **i18n** en/fa. **Docs:** NODES.md §`call.*` action nodes. **Tests:** `call-nodes.test.ts` (19 — registration, the request each node hands `ctx.call`, speak file/pcm decode + empty-source fail, grantTurn save_as/explicit-user, mute flag, and a `ctx.call===null` fail-loud per node). |
| **PE-T5 ✅** | **🎬 Demos + docs.** ✅ DONE. Two scripted, fake-transport e2e demos — (a) **AI voice support** (1:1: `utteranceFinal` → STT → agent(model+memory+tools) → TTS → `call.speak`, with memory keyed by the CALL + replay across utterances) and (b) **channel Q&A moderator** (two listeners queue; `call.grantTurn` → TTS greeting → `call.speak` → `call.endTurn` advances the line `[111,222]`→`[222]`→`[]`) — both built from the **same nodes**, differing only in settings (a static test asserts the shared node set + support-vs-lineup mode). Both run the **real** Executor + **real** CallSessionService + **real** LoopbackVoiceConnector. **Fixtures:** `packages/shared/test/fixtures/phase-e-{voice-support,qa-moderator}-flow.json`. **Tests:** `apps/server/test/e2e-phaseE-voice-demo.test.ts` (4 — support full loop, support memory replay, lineup queue advance, same-nodes invariant). **Supporting:** `call.grantTurn`/`call.mute` `userId` → `z.coerce.string()` (accept a numeric `{{ $json.speakerId }}`), CallSessionService grant queue filter unified by `String()`. **Docs:** `docs/demos/phase-E-voice.md` walkthrough, NODES.md §Live voice cross-ref, **PROTOCOL.md "Live voice" chapter** (why a separate transport, connector kinds, the `voiceConnection` credential, hard caps, ToS posture). |

## E.3 — Implementation choices CTB makes internally (so the user doesn't have to)

Per the user's instruction, these are **CTB's calls, not roadmap forks** — and none
of them constrains a flow author, because each lives behind the `ctx.call` interface
or a credential setting:

1. **Connector:** ship **`userbot`** first (it's the only thing that can join a call today); keep the credential `kind` open for `companion`/`external` so the `@myidbot`-style helper-account idea is a *future credential*, not a rewrite.
2. **Media engine:** start with whichever adapter is fastest to ship correctly (likely a **Python `pytgcalls` sidecar** for reliability, talked to over a local socket); it's an internal adapter, so we can add/replace a JS-native one later with zero node/flow impact.
3. **Call type:** the service supports **group and 1:1 from day one** because `target` is just a setting — no "group-only v1" lock-in.
4. **Sequencing:** Phase E stays **after** Phase C/D by default (it's the heaviest infra), **but** since it reuses PB-T5…PB-T7 directly it can be pulled forward on request. This is the one genuinely scheduling-level question; everything else is a node setting.

> Phase E remains a **design proposal** until we actively start it; when we do, PE-T1
> begins with the `voiceConnection` credential. No flow author is ever asked to pick
> a transport — they pick a credential and toggle node settings.

---

## Sequencing rationale (my recommendation, for the record)

1. **Phase A first** — pure value, zero new infra risk, makes CTB feel like n8n
   immediately; unblocks richer flows for everyone.
2. **Phase B.1 (sub-connections) is the hinge** — do it before any agent/db work;
   everything attaches to it.
3. **DB connectors before the Agent** — the Agent's best memory backend is
   Postgres, so the driver/credential/pool must exist first.
4. **Agent + tools + speech** complete the screenshot.
5. **Phase C (API + MCP)** — it *exposes* a library that must already be
   rich and stable to be worth discovering.
6. **Phase E (live voice AI)** is a **separate pillar**, sequenced last by default
   because it adds a new process type + native media dep + a session credential —
   the heaviest, most ToS-sensitive addition. Per the user's principle, every
   transport/mode fork is a **node/credential setting** (not a phase decision), so
   building it narrows nothing else. It directly **reuses** PB-T5…PB-T7 (agent +
   STT + TTS), so it *could* be pulled forward right after Phase B on request — the
   only genuine scheduling question, since everything else is config.

## Risk register (PLAN2-specific)

| Risk | Mitigation |
|---|---|
| Sub-connection model leaks into the executor's main loop | providers resolved as *config* at agent-run time, never scheduled as steps; covered by executor tests that assert no provider node ever produces a `StepLogEntry` |
| New DB drivers violate I3 (core importing `pg`) | drivers live only in `apps/server`; `core`/`nodes` see the injected `ctx.db` interface; lint/dep-graph test guards it |
| Agent runaway cost/loops | hard step+token+wall-clock caps in PB-T5, budgets in PD-T2; default-deny without caps |
| SQL injection via `db.*` | parameterized queries only; a dedicated injection test battery (PD-T1); string-concat SQL refused in review |
| MCP server exposes too much | every MCP tool maps to an existing bearer-auth-scoped API action; bot-scoped tokens stay isolated (as in P4-T3) |
| Scope creep toward a domain | I2 unchanged: Postgres/MySQL/Agent/Speech are infrastructure; "order", "ticket", "lead" never appear in node code |
| **Phase E** live calls break the "pure Bot API + stateless steps" model | the realtime call loop lives in a host **Call Session Service** (PE-T2, like the scheduler), never in a node; flows only see discrete *events* (trigger) + *actions* (`ctx.call.*`); the native MTProto/WebRTC dep is isolated in `apps/server` behind an interface (I3) so `core`/`nodes` stay clean |
| **Phase E** userbot ToS / abuse risk | a userbot is the operator's OWN account; rate-limit-friendly defaults, hard caps on concurrent calls + duration + per-bot budget (PE-T2), fail-closed on an invalid session (PE-T1), and an explicit ToS chapter in the docs (PE-T5) |
| **Phase E** native media dep (`ntgcalls`/WebRTC) is heavy/less-trodden in JS | it's an **internal host adapter** behind the PE-T2 `ctx.call` interface — CTB chooses it (likely a Python `pytgcalls` sidecar first) and can add/replace a JS-native one with **zero** node/flow change; the rest of CTB never imports it (I3) |
| **Phase E** locking one transport/mode would narrow other options | per the user's principle, every fork is a **node/credential setting** (connector `kind`, `target`, `mode`, `order`), not a phase decision — one generic node set covers all scenarios (I2); a new connector (e.g. an `@myidbot`-style companion account) is a future credential `kind`, not a redesign |

---

## Status

PLAN2 is the **forward roadmap**; it activates only after `docs/PLAN.md` is
complete. Until then it is a living design doc — refine it as PLAN.md phases
teach us more. The active task pointer always lives in `docs/STATE.md`.
