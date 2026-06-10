# CTB Architecture

> Status: v0.1 — design document. This is the contract the codebase is built against.

## 1. Goals & non-goals

**Goals**

- A general-purpose, node-based automation engine specialized for **conversational** Telegram bots.
- n8n-grade developer experience: item pipeline, expressions, Code node, credentials, sub-flows, webhooks.
- Single-binary-feeling deploy: `docker compose up` or `npm start` with SQLite — no mandatory external services.
- Multi-bot: one CTB instance hosts many bot tokens, each with its own flows.

**Non-goals**

- No business-domain nodes in core (no shop/VPN/CRM nodes). Domain logic = flows + Code + HTTP + future plugins.
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

**Dependency rule:** `shared ← core ← nodes ← server`. The editor depends only on `shared` + server API. `core` never imports Telegram or Fastify — it executes flows against injected *services* (sender, storage, http), which makes it unit-testable and future-proof (e.g., a Discord gateway later).

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
