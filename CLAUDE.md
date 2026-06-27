# CLAUDE.md — CTB Operating Constitution

> **THIS FILE IS LAW.** Any AI agent (Claude, GPT, Gemini, …) working on this repository MUST
> follow this protocol exactly. It exists so that development can resume correctly after any
> sandbox reset, model change, or memory loss — using nothing but this repository.

---

## 0. What this project is (30-second context)

**CTB (Composable Telegram Bots)** — a general-purpose, node-based visual automation platform
for building *any* Telegram bot. Think *n8n, but conversation-aware*: the engine can **pause**
an execution at a "Wait for Reply" node, persist full state to the DB, and **resume** days
later when the user answers. TypeScript monorepo. No PHP. No domain-specific (shop/VPN) nodes — ever.

---

## 1. MANDATORY SESSION-START PROTOCOL

Run these steps **in order, every session, before writing any code**:

```
STEP 1  Read docs/STATE2.md          → learn the CURRENT task ID and repo status (ACTIVE file: PLAN2 / Phase A+B). docs/STATE.md is the FROZEN PLAN1 (Phase 0–6) archive — read it only for pre-Phase-B history.
STEP 2  Read that task in docs/PLAN2.md → learn exactly what to build and its acceptance criteria (PLAN.md is done through P5-T4)
STEP 3  Read the relevant §§ of docs/ARCHITECTURE.md (and docs/NODES.md if touching nodes)
STEP 4  Run the verification commands listed in STATE.md → confirm the repo is healthy
STEP 5  Only now: write code.
```

If STEP 4 fails, **fix the repo to green before starting new work** (that becomes the task).

### Sandbox-reset recovery (cold start)

```bash
git clone https://github.com/Saeedkhoshafsar/CTB.git /home/user/webapp
cd /home/user/webapp && git checkout genspark_ai_developer && git pull
npm install                # workspace install (after Phase 0 exists)
npm run verify             # typecheck + test — must be green
# then follow the SESSION-START PROTOCOL above
```

---

## 2. Source-of-truth hierarchy

When documents disagree, higher wins:

```
1. docs/STATE2.md         (what is true RIGHT NOW — PLAN2 / Phase A+B; docs/STATE.md is the frozen PLAN1 Phase 0–6 archive)
2. docs/PLAN.md           (what to do, in what order, with what acceptance criteria)
3. docs/ARCHITECTURE.md   (how to build it — structure, contracts, stack)
4. docs/NODES.md          (node-by-node behavior specification)
5. docs/PROTOCOL.md       (external integration shapes)
6. Code comments / README
```

**`docs/VISION.md` (the compass) sits OUTSIDE this precedence ladder.** It states the *why* and
the final picture (n8n-parity + Telegram-native + live voice), never the *what* or *how*. If VISION.md
ever contradicts 1–5, the source-of-truth files win and VISION.md is corrected. Read it when a
decision's *purpose* is unclear; never let it override an active task spec.

Changing anything in 2–5 requires a **Decision Log entry** (docs/ROADMAP.md §Decision log)
in the same commit, with rationale. Never silently deviate.

---

## 3. Task execution rules

1. **One task at a time.** Work only on the task marked `→ current` in STATE.md. No drive-by
   refactors, no "while I'm here" changes outside the task's declared file scope.
2. **Tasks are atomic.** Each PLAN.md task fits in one session and ends with all acceptance
   criteria met. If a task turns out too big, split it in PLAN.md *first* (that edit is part
   of the task), then do the first piece.
3. **Definition of Done** for every task:
   - [ ] All acceptance criteria in PLAN.md pass (run the listed commands, paste-verify output)
   - [ ] `npm run verify` green (typecheck + all tests)
   - [ ] New logic has tests (engine changes REQUIRE a pause/resume serialization round-trip test)
   - [ ] docs updated if behavior/contracts changed
   - [ ] **STATE2.md updated in the same commit** (current task advanced, session log appended). STATE.md is the frozen PLAN1 archive — touch it only when revisiting Phase 0–6.
4. **Spec before code** for nodes: a node must exist in docs/NODES.md (params, ports, behavior)
   before its implementation is written.
5. **Never skip ahead.** Phases and tasks execute in PLAN2.md order unless STATE2.md documents
   a justified reorder.

---

## 4. Git workflow (non-negotiable)

```
branch   : genspark_ai_developer  (all AI work happens here)
commit   : after EVERY task completion — message: "<type>(scope): <desc> [P<phase>-T<task>]"
           e.g.  feat(core): executor loop with port routing [P1-T4]
state    : docs/STATE2.md (active; STATE.md = frozen PLAN1 archive) is updated IN THE SAME COMMIT as the code it describes
push     : every commit is pushed immediately
PR       : keep one open PR genspark_ai_developer → main; update its description per phase;
           share the PR URL with the user
sync     : before pushing, fetch origin/main and rebase; on conflict prefer remote unless
           local change is the task itself
```

A commit that changes code but not STATE2.md (the active truth file) is a protocol violation.

---

## 5. Architectural invariants (NEVER break)

| # | Invariant |
|---|---|
| I1 | **TypeScript only.** No PHP, no second backend language. Code node runs sandboxed JS. |
| I2 | **No domain nodes in core.** Nothing shop/VPN/CRM-specific. Generic primitives only. |
| I3 | **Dependency direction:** `shared ← sandbox ← core ← nodes ← apps/server` (Decision Log #12). `core` NEVER imports Telegram/Fastify/DB drivers — it receives injected services (sender, store, http, kv); `sandbox` uses only `node:worker_threads`. Editor depends only on `shared` + the server's HTTP API. |
| I4 | **Durability first.** Any state needed to resume a conversation lives in the `executions` table, never only in memory. Every WAIT must survive a process restart. |
| I5 | **Zod schema first.** Every node's params, every API body, every stored JSON document has a Zod schema in `packages/shared`. The editor form is generated from it. |
| I6 | **Sandbox = no ambient authority.** Code node / expressions get capabilities only via injected proxies (`$http`, `$kv`, …) with host-side limits. Never expose `require`, `process`, `fs`. |
| I7 | **Secrets encrypted at rest** (AES-256-GCM via `CTB_SECRET`). Tokens/credentials never logged, never committed. |
| I8 | **Every phase ends demoable** — a runnable end-to-end demonstration listed in PLAN.md. |

---

## 6. Quality gates

- `npm run verify` = `typecheck` + `vitest run` across all workspaces. Must be green at every commit.
- Engine code (`packages/core`): no `any` in public signatures; executor changes need step-through tests.
- No new runtime dependency without a one-line justification in the commit body.
- Keep functions small; prefer pure functions in `core`; side effects live at the edges (`apps/server`).

## 7. Style & conventions

- Node type ids: `namespace.camelCase` → `tg.sendMessage`, `flow.if`, `data.code`, `ai.llmChat`.
- DB: snake_case columns; Drizzle migrations are append-only (never edit an applied migration).
- Errors: typed error classes in `shared`; executions record failures in `exec_logs`, they don't crash the gateway.
- UI: RTL-friendly from day one; all user-facing strings through the i18n scaffold (fa/en).

---

## 8. When memory/context is insufficient

If at any point you are unsure *why* something is built a certain way:
1. `git log --oneline -- <file>` and read the task IDs in commit messages,
2. open that task in docs/PLAN.md and the Decision Log in docs/ROADMAP.md,
3. if still ambiguous — ask the user; do **not** guess on contract-level questions.
