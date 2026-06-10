# STATE — Current truth of the CTB repository

> **Read me first, every session.** I am the single source of "where are we".
> I am updated in the SAME COMMIT as the code I describe (CLAUDE.md §4).

## Current position

```
Phase     : 1 — Engine core + Telegram gateway
Task      : → current: P1-T1 (Expression engine)   [not started]
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
# Boot smoke (Phase 0 demo):
CTB_SECRET=devsecret0123456 CTB_ADMIN_PASS=hunter2hunter2 CTB_DB_PATH=/tmp/ctb.sqlite npm run dev:server
curl localhost:3000/healthz                       # → {"ok":true}
curl -X POST localhost:3000/api/auth/login -H 'content-type: application/json' \
  -d '{"username":"admin","password":"hunter2hunter2"}' -c /tmp/c.txt   # → {"ok":true,...}
curl localhost:3000/api/auth/me -b /tmp/c.txt     # → {"user":{"username":"admin"}}
```

Expected right now: Phase 0 complete — contract types, DB layer, bootable authed server.
No engine yet (Phase 1 starts at P1-T1 expression engine).

## What exists / what doesn't

| Area | Status |
|---|---|
| Vision/architecture/node specs/plan docs | ✅ complete (docs/) incl. Collections layer (§13, Phase 3.5) |
| Monorepo skeleton (P0-T1) | ✅ 6 workspaces, verify green, editor vite build works |
| Shared contract types (P0-T2) | ✅ FlowGraph/FlowItem/Execution/WaitSpec/NodeDef + Zod, 20 contract tests, sample-flow fixture |
| Database (P0-T3) | ✅ Drizzle schema (§4+§13, 11 tables), migration 0000_init, AES-256-GCM crypto, env validation, 16 tests |
| Server boot (P0-T4) | ✅ Fastify 5 app factory, /healthz, signed-cookie admin auth (login/logout/me), /api/* guard, SPA static serving, .env.example, Dockerfile+compose, GitHub Actions CI |
| Engine | ❌ (P1-T1 next) |
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
| 2026-06-10 | P0-T4 | Server boot: `app.ts` factory (testable via inject, no port), `/healthz`, stateless HMAC signed-cookie sessions (`lib/session.ts`, 7d TTL, timing-safe compare, tamper/expiry tests), login/logout/me + preHandler guard on `/api/*` (503 if CTB_ADMIN_PASS unset), `@fastify/static` SPA fallback for editor dist, `main.ts` = env→openDb→migrate→listen + graceful shutdown. `.env.example`, multi-stage Dockerfile (tsx runtime), docker-compose (named volume, env guards), CI workflow (install→verify→migrate smoke→editor build) — ⚠️ lives at `docs/ci/github-actions-ci.yml` because the sandbox GitHub App token lacks `workflows` permission; copy to `.github/workflows/ci.yml` manually to enable. 14 new tests (8 app inject + 6 session); verify green (53 tests). Boot demo verified with real curl: healthz/login/me/401. **🎬 PHASE 0 COMPLETE.** Next: P1-T1. |
| 2026-06-10 | P0-T3 | DB layer: Drizzle schema exactly per ARCHITECTURE §4 incl. Collections tables (§13) — 11 tables, FKs+cascade, kv unique index, executions waiting/timeout indexes (wait_timeout_at denormalized for scanner). openDb (WAL, FK on, :memory: supported), migrate.ts (CLI+programmatic), drizzle-kit 0000_init. lib/crypto.ts AES-256-GCM (scrypt key, random IV, tamper tests), lib/env.ts zod-validated (refuses CTB_SECRET <16). 16 server tests incl. execution-state JSON round-trip (I4). verify green; db:migrate CLI verified. Next: P0-T4. |
| 2026-06-10 | P0-T2 | THE CONTRACT in @ctb/shared: item.ts (FlowItem/BinaryRef discriminated union), flow.ts (FlowGraph with superRefine integrity — dup ids, dangling edges; port naming convention incl. "btn:<key>"), execution.ts (ExecutionState/WaitSpec reply|callback|delay/Execution), node-def.ts (NodeResult union + out/wait/goto/end/fail helpers, NodeCtx capability interface, NodeDef with dynamicOutputs for Menu/Switch), errors.ts (typed CtbError family). Fixture: P1 demo flow (ask name→age→IF→greet, fa text). 20 tests incl. serialization round-trip. verify green. Next: P0-T3. |
| 2026-06-10 | P0-T1 | Monorepo skeleton: npm workspaces (shared/core/nodes/sandbox/server/editor), tsconfig.base (strict, ES2022, Bundler resolution), per-ws tsconfig with explicit `paths` showing dependency direction, placeholder src+tests proving chain shared←core←nodes←server, editor = Vite+React19 placeholder (RTL html). `npm run verify` green. Version note: @vitejs/plugin-react pinned ^5 (v6 needs vite 8; we pin vite ^7 LTS) — PLAN table updated. Next: P0-T2. |
| 2026-06-10 | docs: Collections layer | Answered "how does a non-technical manager get an admin panel without code?" → NOT UI-nodes; adopted schema-driven Collections (Directus/PocketBase pattern). ARCHITECTURE §13, NODES.md (`data.collection`, `collection.recordChanged`), new Phase 3.5 in ROADMAP+PLAN (tasks P3.5-T1…T6), Decision Log #9–#11, P2-T3 re-scoped to a reusable form engine. Code phase position unchanged — next is still P0-T1. |
| 2026-06-10 | bootstrap | Repo created. Constitution (CLAUDE.md), PLAN.md (atomic tasks P0–P6), STATE.md, ARCHITECTURE/NODES/ROADMAP/PROTOCOL docs pushed. Stack versions pinned in PLAN.md against live npm registry. Next: P0-T1. |
