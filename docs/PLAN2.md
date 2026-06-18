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

# PHASE E — Live voice AI (real-time Telegram calls) `🎙️ NEW`

> **Origin:** user request (2026-06-18). The headline ask: a node that connects an
> **AI to LIVE Telegram voice conversations** — (1) an **AI online voice-support
> agent** that answers callers in real time, and (2) a **channel-livestream Q&A
> moderator** that grants speaking turns to listeners (sequential / random,
> configurable) and answers them one by one. "We add the bot to a channel/group,
> make it admin, and a configurable node covers the different scenarios."
>
> **This is a NEW pillar, not an inline PB/PC task** — it breaks PLAN2's core
> "pure Telegram **Bot API** + stateless flow steps" assumption and adds a
> long-lived realtime audio pipeline. It is sequenced LAST (after the open-builder
> surface) and gated behind an explicit feasibility + design sign-off.

## E.0 — Feasibility findings (researched 2026-06-18, MUST read before building)

| Question | Finding | Consequence for CTB |
|---|---|---|
| Does the **Bot API** expose voice/video calls or group voice chats? | **No.** Confirmed by Telegram docs + community (Latenode, May 2025). The Bot API has *no* call/voice-chat methods at all. | The whole feature lives **outside** the Bot-API surface every existing CTB node uses. |
| What *can* join a Telegram voice chat / place a 1:1 call? | **MTProto** via `tgcalls`/`pytgcalls` (Python: Pyrogram/Telethon) or `tgcalls`/`gram-tgcalls` (JS: GramJS), all driving **WebRTC** through `ntgcalls`/`libtgcalls`. They stream **raw PCM** frames in/out of group calls and private calls. | Needs a **userbot CLIENT** + a native WebRTC media layer running as a **persistent process** — not a webhook handler. |
| Can a normal **bot token** do it? | **No.** Joining a voice chat / calling requires a **user account (phone-number session)**, i.e. a *userbot*. Even "join as channel" still uses a user MTProto session. | Introduces a brand-new credential type (`telegramUserSession` — an encrypted MTProto session string, I7) and the operational/ToS weight of running a userbot. The "add the bot as admin" mental model is *partly* right (admin rights ARE needed to manage a group call), but a **separate user session** does the audio, not the Bot-API bot. |
| Is the audio a request/response, like every other node? | **No.** It's a **continuous bidirectional stream** for the whole call. | The executor's "node runs, returns items, done" model can't host the call loop. We need a **host-side long-lived "call session" service** (like the scheduler/trigger runtime) that flows *attach to* via events — not a node that blocks for 30 minutes. |

**Verdict:** feasible and high-value, but it is the **heaviest** addition in PLAN2 —
a new process type, a new native dependency, a new credential, and real ToS /
abuse considerations. Treat it as its own phase with its own risk budget.

## E.1 — The architecture (how it fits CTB's invariants)

The trick is the **same one we used for Telegram updates and the scheduler**: the
*real-time, stateful* work lives in a **host capability/service**; flows stay
**stateless and event-driven**. A live call becomes a sequence of discrete
*events* (a caller joined, a question turn opened, an utterance was transcribed)
that **trigger** a flow, and a small set of *actions* (speak this audio, grant the
next turn, mute someone) the flow can **invoke** — never a node that holds the
socket open.

```
          ┌─────────────────── apps/server (host) ───────────────────┐
          │  Call Session Service (NEW, long-lived, like scheduler)   │
          │   • userbot MTProto session  (gram-tgcalls / pytgcalls)   │
          │   • WebRTC media in/out (PCM frames)                       │
          │   • turn-taking queue (sequential | random, configurable)  │
          │   • VAD + chunked STT  →  emits "utterance" events         │
          └───┬───────────────────────────────▲──────────────────────┘
   emits events│ (callJoined, turnOpened,      │ invokes actions
   → TRIGGER   │  utteranceFinal, callLeft)    │ (ctx.call.speak / grantTurn /
   a flow      ▼                               │  muteTurn / endTurn)
          ┌────────────────────── a CTB flow ───────────────────────┐
          │  trigger.callEvent  →  ai.speechToText (reuse PB-T7!) →   │
          │  ai.agent (model/memory/tools, reuse PB-T5/T6)  →         │
          │  ai.textToSpeech (reuse PB-T7)  →  call.speak             │
          └──────────────────────────────────────────────────────────┘
```

Crucially: **STT, the agent, and TTS are already built (PB-T5…PB-T7).** Phase E only
adds the *transport* (the call session) and the *glue* (a trigger + a few action
nodes + a credential). That is the payoff of having done speech first.

## E.2 — Tasks

| Task | Scope |
|---|---|
| **PE-T1** | **`telegramUserSession` credential + userbot health.** New encrypted credential (MTProto session string + api_id/api_hash, AES-256-GCM, I7). A host-side connect/validate path that logs the user account in, reports health in the panel, and **fails closed** if the session is invalid/expired. Doc the ToS/abuse posture clearly (a userbot is the operator's own account; rate-limit-friendly defaults). **No audio yet** — just a verified, reusable session. |
| **PE-T2** | **Call Session Service (host runtime, the hard part).** A long-lived service in `apps/server` (sibling to the scheduler) that, given a `telegramUserSession` + a target chat, **joins a group voice chat / places-or-answers a 1:1 call** via a JS MTProto-calls layer (`gram-tgcalls`/`tgcalls`, `ntgcalls` native). Streams **PCM in** (downlink) and **PCM out** (uplink), with VAD-based utterance segmentation. Exposes a **typed internal API**: `join/leave`, `speak(pcm|fileId)`, `onUtterance(cb)`, plus participant controls. Hard caps: max concurrent calls, max call duration, per-bot budget (cost/abuse safety). Native dep isolated behind an interface so `core`/`nodes` never import it (I3). |
| **PE-T3** | **`trigger.callEvent` (entry node).** A new trigger that starts a flow on call events: `callJoined`, `utteranceFinal` (a caller finished speaking — carries the downlink audio as a CTB file id, ready for `ai.speechToText`), `turnOpened`, `callLeft`. Config: which chat(s), which events, and the **moderation mode** — `support` (answer everyone, possibly concurrent-safe queue) vs `lineup` (a Q&A queue: `sequential` or `random` turn order, max turn length, auto-advance). This is where the user's "sequential / random, configurable" lives. |
| **PE-T4** | **`call.*` action nodes (what the flow does back).** `call.speak` — play synthesized audio into the live call (takes a `fileId` from `ai.textToSpeech`, or raw text + a voice for a one-shot). `call.grantTurn` / `call.endTurn` — open/close a speaker's turn in `lineup` mode (the moderator handing the mic around). `call.mute` / `call.leave`. All go through `ctx.call` (the PE-T2 service), injected like every other capability (I6). |
| **PE-T5** | **🎬 Demos + docs.** Two scripted, fake-transport e2e demos matching the user's two scenarios: (a) **AI voice support** — caller speaks → `utteranceFinal` → STT → agent → TTS → `call.speak`, full duplex; (b) **channel Q&A moderator** — N listeners raise hands, the node grants turns `sequential`/`random`, each question is answered, then `call.endTurn`+`call.grantTurn` advances. NODES.md + a PROTOCOL.md "Live voice" chapter covering the userbot setup, the credential, and the ToS posture. |

## E.3 — Open questions to confirm with the user (before PE-T1)

1. **Userbot is mandatory** — are you OK operating a dedicated **user account** (phone number + MTProto session) for the audio leg? (A plain bot token cannot join calls.)
2. **Runtime stack** — CTB's host is TypeScript/Node. The most mature calls stack is Python (`pytgcalls`). Acceptable options: (a) a **Node-native** path (`gram-tgcalls`+`ntgcalls`) inside `apps/server`, or (b) a **separate Python sidecar microservice** the host talks to over a local socket. Which do you prefer? (Trade-off: (a) keeps one process + one language but rides a less-trodden JS lib; (b) uses the battle-tested Python lib but adds a service to deploy.)
3. **Scope of v1** — start with **group/channel voice chats only** (the livestream-moderator case), and add **1:1 private calls** in a follow-up? Or both at once?
4. **Sequencing** — Phase E is currently **last**. Do you want it pulled **earlier** (e.g. right after the agent/speech of Phase B, since it reuses them directly), or kept after the open-builder Phase C?

> Until these are answered, Phase E stays a **design proposal**; no PE-T* code starts.

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
   because it adds a new process type + native media dep + a userbot credential —
   the heaviest, most ToS-sensitive addition. It directly **reuses** PB-T5…PB-T7
   (agent + STT + TTS), so it *could* be pulled forward right after Phase B if the
   user prioritizes it; that ordering call is one of the E.3 open questions.

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
| **Phase E** userbot ToS / abuse risk | a userbot is the operator's OWN account; rate-limit-friendly defaults, hard caps on concurrent calls + duration + per-bot budget (PE-T2), fail-closed on an invalid session (PE-T1), and an explicit ToS chapter in the docs (PE-T5); gated behind the E.3 sign-off before any code |
| **Phase E** native media dep (`ntgcalls`/WebRTC) is heavy/less-trodden in JS | E.3 lets the user choose a Node-native path or a Python (`pytgcalls`) sidecar; either way it sits behind the PE-T2 `ctx.call` interface so the rest of CTB is agnostic to the choice |

---

## Status

PLAN2 is the **forward roadmap**; it activates only after `docs/PLAN.md` is
complete. Until then it is a living design doc — refine it as PLAN.md phases
teach us more. The active task pointer always lives in `docs/STATE.md`.
