# STATE — Current truth of the CTB repository

> **Read me first, every session.** I am the single source of "where are we".
> I am updated in the SAME COMMIT as the code I describe (CLAUDE.md §4).

## Current position

```
Phase     : 1 — Engine core + Telegram gateway
Task      : → current: P1-T5 (Telegram gateway)   [not started]
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
Expression engine (P1-T1) + worker sandbox (P1-T2) + execution store (P1-T3) +
**executor loop (P1-T4)** done. The engine can now run a full graph: param
expressions → Zod validation → execute → port routing → WAIT persists & resume()
continues from the exact node. Next: Telegram gateway (P1-T5).

## What exists / what doesn't

| Area | Status |
|---|---|
| Vision/architecture/node specs/plan docs | ✅ complete (docs/) incl. Collections layer (§13, Phase 3.5) |
| Monorepo skeleton (P0-T1) | ✅ 6 workspaces, verify green, editor vite build works |
| Shared contract types (P0-T2) | ✅ FlowGraph/FlowItem/Execution/WaitSpec/NodeDef + Zod, 20 contract tests, sample-flow fixture |
| Database (P0-T3) | ✅ Drizzle schema (§4+§13, 11 tables), migration 0000_init, AES-256-GCM crypto, env validation, 16 tests |
| Server boot (P0-T4) | ✅ Fastify 5 app factory, /healthz, signed-cookie admin auth (login/logout/me), /api/* guard, SPA static serving, .env.example, Dockerfile+compose, GitHub Actions CI |
| Expression engine (P1-T1) | ✅ tokenizer + $-scope builder + **sandbox-backed async evaluator** (stub swapped in P1-T2) |
| Sandbox primitive (P1-T2) | ✅ `@ctb/sandbox` worker_threads pool: fresh frozen vm realm, capability proxies over MessagePort, console capture, vm CPU timeout + host hard-kill & worker recycle, 16 tests |
| Execution store (P1-T3) | ✅ `ExecutionStore` interface + `MemoryExecutionStore` in core, `SqliteExecutionStore` in server (denormalized `wait_timeout_at` for the timeout scanner), shared contract suite runs against BOTH (13 tests) |
| Executor loop (P1-T4) | ✅ `NodeRegistry` (Zod param validation, dynamicOutputs) + `Executor` (step loop per ARCH §7: items/WAIT/GOTO/END/ERROR, fan-out FIFO, disabled-node passthrough, maxSteps + per-run wall-time budgets, periodic checkpoints, NodeCtx with vars/eval/log) + recursive param `{{ }}` resolution; 26 tests incl. I4 pause→JSON round-trip→fresh-executor resume |
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
| 2026-06-10 | P1-T4 | Executor loop (the heart of the engine, ARCH §7): `packages/core/src/registry/` (`NodeRegistry`: register/get/list, `parseParams` → typed `NodeParamsError`, `outputsFor` handles dynamicOutputs) + `packages/core/src/engine/` — `params.ts` (recursive `{{ }}` resolution through raw params; single-expr → raw value so number/bool schemas pass; plain strings skip the sandbox) and `executor.ts` (`Executor.start/resume`; step loop: resolve node → eval params → Zod → execute → route per port via edge index; WAIT persists state+wait (executor stamps `wait.nodeId` — nodes don't know their graph id) and returns; `resume(executionId, port, items)` injects router items as the wait node's output on any port (reply/timeout); GOTO jumps; END/ERROR finalize; disabled nodes pass items through `main`; synchronous fan-out via in-run FIFO, WAIT-with-queued-branches fails loudly (v1 limit); maxSteps=1000 default; **wall-time budget is per RUN not per execution — initial version measured from `startedAt` which broke resumes days later; caught by test**; checkpoint every N steps; `StepLogger` hook for exec_logs; `NodeCtx` built per node: vars get/set on live state, `eval()` via renderTemplate, injected kv/http/tg). 26 new tests across `executor.test.ts` + `executor-wait.test.ts` incl. the I4-mandated round-trip: pause → JSON.stringify/parse deep-equal → brand-new Executor instance resumes purely from the store. verify green (120 tests). Next: P1-T5 Telegram gateway. |
| 2026-06-10 | P1-T3 | Execution store (durability behind pause/resume, I4): `packages/core/src/store/` — `types.ts` (`ExecutionStore` interface: create/load/save/checkpoint/findWaiting/listTimedOut + `waitDeadline()` helper: delay→resumeAt, reply/callback→timeoutAt), `memory.ts` (`MemoryExecutionStore`, structuredClone on every boundary so shared-mutable-state bugs surface in tests, injectable clock). `apps/server/src/engine/sqlite-store.ts` (`SqliteExecutionStore` over Drizzle; `wait_timeout_at` denormalized from WaitSpec so the timeout scanner hits the `(status,wait_timeout_at)` index instead of parsing JSON; save/checkpoint of unknown id → throw via `changes===0`). **Shared contract suite** `packages/core/test/store-contract.ts` (rich fa/RTL+binary state round-trip deep-equal, unknown-id semantics, checkpoint preserves status/wait, findWaiting bot/chat/kind filters waiting-only, listTimedOut reply+delay deadlines, resume clears wait) runs against BOTH implementations → semantics can never drift. Fixed binary fixture kind `telegram`→`tg_file_id` per BinaryRefSchema. 13 new tests; verify green (~102 tests). Next: P1-T4 executor loop. |
| 2026-06-10 | P1-T2 | Sandbox primitive in `packages/sandbox/`: `worker-source.ts` (CJS string booted via `new Worker(src,{eval:true})` — no TS loader needed in worker; fresh `vm.createContext` per run with `codeGeneration:{strings:false,wasm:false}`, deep-freeze re-applied post-clone, `$now` rebuilt from `{__ctbKind:'now',ts}` wire marker, console capture, SHADOW list → undefined, globalThis self-reference hidden) + `pool.ts` (`SandboxPool`: queue + maxWorkers=4, 64MB old-gen cap, two-layer timeout — vm CPU timeout kills sync `while(true)` WITHOUT losing the worker; host hard-kill (+50ms) terminates async hangs and recycles the worker; capability host objects → method-name manifest → realm proxies → MessagePort round-trip with error propagation; `runInSandbox`/default-pool helpers; `destroy()` for tests). Evaluator swap done: `@ctb/core` evaluator now async, runs each `{{}}` segment in the pool (`mode:'expression'`, 50ms budget enforced preemptively), `EvaluateOptions{pool,budgetMs}`. Chain extended `shared←sandbox←core` — Decision Log #12, CLAUDE I3 + ARCH §3 updated. 16 sandbox tests (incl. 20-parallel, kill-survive, cap round-trip, frozen scope, eval/Function blocked) + 14 evaluator tests updated to async; verify green (~89 tests). Next: P1-T3. |
| 2026-06-10 | P1-T1 | Expression engine in `packages/core/src/expression/`: tokenizer (`{{ }}` segments, unclosed→literal, fa/RTL tested), scope builder (`$json,$items,$vars,$user,$chat,$execution,$flow,$env,$now` per ARCHITECTURE §6; shallow-frozen copies so expressions can't mutate scope; `$now.format('YYYY-MM-DD')` helper, clock injectable), evaluator = P1-T1 STUB via `new Function` + strict mode + shadowed globals (process/require/globalThis/fetch→undefined) — **to be swapped to worker sandbox in P1-T2** (PLAN note, Decision Log entry due then). Single-expression templates return RAW values (numbers/objects survive); mixed templates stringify. Missing path (`?.`)→'' + warning collected; throw→typed ExpressionError; 50ms budget post-hoc (preemptive kill arrives with P1-T2 worker). 22 core tests green; full typecheck green. Next: P1-T2. |
| 2026-06-10 | P0-T4 | Server boot: `app.ts` factory (testable via inject, no port), `/healthz`, stateless HMAC signed-cookie sessions (`lib/session.ts`, 7d TTL, timing-safe compare, tamper/expiry tests), login/logout/me + preHandler guard on `/api/*` (503 if CTB_ADMIN_PASS unset), `@fastify/static` SPA fallback for editor dist, `main.ts` = env→openDb→migrate→listen + graceful shutdown. `.env.example`, multi-stage Dockerfile (tsx runtime), docker-compose (named volume, env guards), CI workflow (install→verify→migrate smoke→editor build) — ⚠️ lives at `docs/ci/github-actions-ci.yml` because the sandbox GitHub App token lacks `workflows` permission; copy to `.github/workflows/ci.yml` manually to enable. 14 new tests (8 app inject + 6 session); verify green (53 tests). Boot demo verified with real curl: healthz/login/me/401. **🎬 PHASE 0 COMPLETE.** Next: P1-T1. |
| 2026-06-10 | P0-T3 | DB layer: Drizzle schema exactly per ARCHITECTURE §4 incl. Collections tables (§13) — 11 tables, FKs+cascade, kv unique index, executions waiting/timeout indexes (wait_timeout_at denormalized for scanner). openDb (WAL, FK on, :memory: supported), migrate.ts (CLI+programmatic), drizzle-kit 0000_init. lib/crypto.ts AES-256-GCM (scrypt key, random IV, tamper tests), lib/env.ts zod-validated (refuses CTB_SECRET <16). 16 server tests incl. execution-state JSON round-trip (I4). verify green; db:migrate CLI verified. Next: P0-T4. |
| 2026-06-10 | P0-T2 | THE CONTRACT in @ctb/shared: item.ts (FlowItem/BinaryRef discriminated union), flow.ts (FlowGraph with superRefine integrity — dup ids, dangling edges; port naming convention incl. "btn:<key>"), execution.ts (ExecutionState/WaitSpec reply|callback|delay/Execution), node-def.ts (NodeResult union + out/wait/goto/end/fail helpers, NodeCtx capability interface, NodeDef with dynamicOutputs for Menu/Switch), errors.ts (typed CtbError family). Fixture: P1 demo flow (ask name→age→IF→greet, fa text). 20 tests incl. serialization round-trip. verify green. Next: P0-T3. |
| 2026-06-10 | P0-T1 | Monorepo skeleton: npm workspaces (shared/core/nodes/sandbox/server/editor), tsconfig.base (strict, ES2022, Bundler resolution), per-ws tsconfig with explicit `paths` showing dependency direction, placeholder src+tests proving chain shared←core←nodes←server, editor = Vite+React19 placeholder (RTL html). `npm run verify` green. Version note: @vitejs/plugin-react pinned ^5 (v6 needs vite 8; we pin vite ^7 LTS) — PLAN table updated. Next: P0-T2. |
| 2026-06-10 | docs: Collections layer | Answered "how does a non-technical manager get an admin panel without code?" → NOT UI-nodes; adopted schema-driven Collections (Directus/PocketBase pattern). ARCHITECTURE §13, NODES.md (`data.collection`, `collection.recordChanged`), new Phase 3.5 in ROADMAP+PLAN (tasks P3.5-T1…T6), Decision Log #9–#11, P2-T3 re-scoped to a reusable form engine. Code phase position unchanged — next is still P0-T1. |
| 2026-06-10 | bootstrap | Repo created. Constitution (CLAUDE.md), PLAN.md (atomic tasks P0–P6), STATE.md, ARCHITECTURE/NODES/ROADMAP/PROTOCOL docs pushed. Stack versions pinned in PLAN.md against live npm registry. Next: P0-T1. |
