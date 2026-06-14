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
| **PB-T8** | **🎬 Phase-B demo** — rebuild the user's exact screenshot in CTB: Telegram voice note → `tg.getFile` → `ai.speechToText` → `ai.agent` (OpenRouter model + Postgres memory + Think/HTTP tools) → `ai.textToSpeech` → `tg.sendMedia` (audio). Doc + scripted e2e with a fake LLM/transcribe/TTS transport. |

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
| **PC-T1** | **Node catalog API.** `GET /api/v1/node-types` (already internal via `/api/node-types`) promoted to the public bearer-auth v1 surface: every node's type, category, role, ports, JSON-Schema params, and human description (fa/en) — a machine-readable catalog so an external builder/agent knows exactly what bricks exist. |
| **PC-T2** | **Flow authoring API.** `POST/PATCH /api/v1/flows` with full graph validation (reuse `FlowGraphSchema` + `validateFlowForActivation`) so an external agent can *build and activate* a workflow, not just trigger one. Dry-run/validate endpoint that returns node problems without saving. |
| **PC-T3** | **CTB as an MCP _server_.** Expose CTB's capabilities as MCP tools to *external* AI agents (Claude/IDE/etc.): `list_nodes`, `validate_flow`, `create_flow`, `trigger_flow`, `query_collection`, `send_message`. This is the inverse of PLAN P5-T3 (`ai.mcpClient`, where CTB consumes MCP). Auth via the existing API tokens (I7). Transport: streamable-HTTP MCP. |
| **PC-T4** | **MCP _client_ tool node** (if not already shipped as PLAN P5-T3): `tool.mcp` — attach a remote MCP server's tools to our `ai.agent`, so a CTB agent can use any MCP tool in the wild. |
| **PC-T5** | **Builder docs + recipes.** Extend PROTOCOL.md with an "Authoring & MCP" chapter: catalog→build→validate→activate lifecycle, an MCP quick-start (point Claude Desktop at CTB), and 2 end-to-end recipes. 🎬 demo: an external agent reads the catalog, assembles a 3-node flow via the API, activates it, and triggers it. |

---

# PHASE D — Hardening for the new surface

| Task | Scope |
|---|---|
| **PD-T1** | **DB connection pooling + safety** — pool limits, statement timeouts, read-only credential option, SQL-injection test battery for `db.postgres`/`db.mysql`. |
| **PD-T2** | **Agent cost governance** — per-bot token/step budgets, daily caps, per-credential spend metering surfaced in the panel. |
| **PD-T3** | **MCP/API rate limiting + audit** — per-token quotas, an audit log of authoring/trigger calls. |
| **PD-T4** | **Node library docs site** — auto-generated from the catalog API: every node with params, examples, fa/en. The "the work is already done, just connect them" promise made browsable. |

---

## Sequencing rationale (my recommendation, for the record)

1. **Phase A first** — pure value, zero new infra risk, makes CTB feel like n8n
   immediately; unblocks richer flows for everyone.
2. **Phase B.1 (sub-connections) is the hinge** — do it before any agent/db work;
   everything attaches to it.
3. **DB connectors before the Agent** — the Agent's best memory backend is
   Postgres, so the driver/credential/pool must exist first.
4. **Agent + tools + speech** complete the screenshot.
5. **Phase C (API + MCP)** last — it *exposes* a library that must already be
   rich and stable to be worth discovering.

## Risk register (PLAN2-specific)

| Risk | Mitigation |
|---|---|
| Sub-connection model leaks into the executor's main loop | providers resolved as *config* at agent-run time, never scheduled as steps; covered by executor tests that assert no provider node ever produces a `StepLogEntry` |
| New DB drivers violate I3 (core importing `pg`) | drivers live only in `apps/server`; `core`/`nodes` see the injected `ctx.db` interface; lint/dep-graph test guards it |
| Agent runaway cost/loops | hard step+token+wall-clock caps in PB-T5, budgets in PD-T2; default-deny without caps |
| SQL injection via `db.*` | parameterized queries only; a dedicated injection test battery (PD-T1); string-concat SQL refused in review |
| MCP server exposes too much | every MCP tool maps to an existing bearer-auth-scoped API action; bot-scoped tokens stay isolated (as in P4-T3) |
| Scope creep toward a domain | I2 unchanged: Postgres/MySQL/Agent/Speech are infrastructure; "order", "ticket", "lead" never appear in node code |

---

## Status

PLAN2 is the **forward roadmap**; it activates only after `docs/PLAN.md` is
complete. Until then it is a living design doc — refine it as PLAN.md phases
teach us more. The active task pointer always lives in `docs/STATE.md`.
