# STATE — Current truth of the CTB repository

> **Read me first, every session.** I am the single source of "where are we".
> I am updated in the SAME COMMIT as the code I describe (CLAUDE.md §4).

## Current position

```
Phase     : 0 — Foundation
Task      : → current: P0-T4 (Server boot + auth + CI)   [not started]
Branch    : genspark_ai_developer
Blockers  : none
```

## Repo health — verification commands

Run these to confirm the repo is in the expected state before working:

```bash
git status                 # must be clean
git log --oneline -3       # last task IDs should match the session log below
npm install && npm run verify          # → must be green
CTB_SECRET=devsecret0123456 CTB_DB_PATH=/tmp/ctb.sqlite npm run db:migrate
# → prints 11 tables: bots, collections, credentials, exec_logs, executions,
#   files, flow_versions, flows, kv_store, records, users
```

Expected right now: monorepo skeleton with placeholder sources/tests proving the dependency
chain `shared←core←nodes←server`. No real engine/API code yet.

## What exists / what doesn't

| Area | Status |
|---|---|
| Vision/architecture/node specs/plan docs | ✅ complete (docs/) incl. Collections layer (§13, Phase 3.5) |
| Monorepo skeleton (P0-T1) | ✅ 6 workspaces, verify green, editor vite build works |
| Shared contract types (P0-T2) | ✅ FlowGraph/FlowItem/Execution/WaitSpec/NodeDef + Zod, 20 contract tests, sample-flow fixture |
| Database (P0-T3) | ✅ Drizzle schema (§4+§13, 11 tables), migration 0000_init, AES-256-GCM crypto, env validation, 16 tests |
| Engine | ❌ |
| Telegram gateway | ❌ |
| Editor | placeholder page only |
| Open PR | #1 genspark_ai_developer → main (keep updating it) |

## Environment notes

- Node.js >= 20 required. Sandbox has Node 20.x.
- `CTB_SECRET` env (≥16 chars) required for anything touching DB/crypto.
- Old PHP project (github.com/Saeedkhoshafsar/mirzabot) = **reference only**, never copy code.

## Session log (append-only, newest first)

| Date | Task(s) | Result / notes |
|---|---|---|
| 2026-06-10 | P0-T3 | DB layer: Drizzle schema exactly per ARCHITECTURE §4 incl. Collections tables (§13) — 11 tables, FKs+cascade, kv unique index, executions waiting/timeout indexes (wait_timeout_at denormalized for scanner). openDb (WAL, FK on, :memory: supported), migrate.ts (CLI+programmatic), drizzle-kit 0000_init. lib/crypto.ts AES-256-GCM (scrypt key, random IV, tamper tests), lib/env.ts zod-validated (refuses CTB_SECRET <16). 16 server tests incl. execution-state JSON round-trip (I4). verify green; db:migrate CLI verified. Next: P0-T4. |
| 2026-06-10 | P0-T2 | THE CONTRACT in @ctb/shared: item.ts (FlowItem/BinaryRef discriminated union), flow.ts (FlowGraph with superRefine integrity — dup ids, dangling edges; port naming convention incl. "btn:<key>"), execution.ts (ExecutionState/WaitSpec reply|callback|delay/Execution), node-def.ts (NodeResult union + out/wait/goto/end/fail helpers, NodeCtx capability interface, NodeDef with dynamicOutputs for Menu/Switch), errors.ts (typed CtbError family). Fixture: P1 demo flow (ask name→age→IF→greet, fa text). 20 tests incl. serialization round-trip. verify green. Next: P0-T3. |
| 2026-06-10 | P0-T1 | Monorepo skeleton: npm workspaces (shared/core/nodes/sandbox/server/editor), tsconfig.base (strict, ES2022, Bundler resolution), per-ws tsconfig with explicit `paths` showing dependency direction, placeholder src+tests proving chain shared←core←nodes←server, editor = Vite+React19 placeholder (RTL html). `npm run verify` green. Version note: @vitejs/plugin-react pinned ^5 (v6 needs vite 8; we pin vite ^7 LTS) — PLAN table updated. Next: P0-T2. |
| 2026-06-10 | docs: Collections layer | Answered "how does a non-technical manager get an admin panel without code?" → NOT UI-nodes; adopted schema-driven Collections (Directus/PocketBase pattern). ARCHITECTURE §13, NODES.md (`data.collection`, `collection.recordChanged`), new Phase 3.5 in ROADMAP+PLAN (tasks P3.5-T1…T6), Decision Log #9–#11, P2-T3 re-scoped to a reusable form engine. Code phase position unchanged — next is still P0-T1. |
| 2026-06-10 | bootstrap | Repo created. Constitution (CLAUDE.md), PLAN.md (atomic tasks P0–P6), STATE.md, ARCHITECTURE/NODES/ROADMAP/PROTOCOL docs pushed. Stack versions pinned in PLAN.md against live npm registry. Next: P0-T1. |
