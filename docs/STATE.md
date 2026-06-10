# STATE — Current truth of the CTB repository

> **Read me first, every session.** I am the single source of "where are we".
> I am updated in the SAME COMMIT as the code I describe (CLAUDE.md §4).

## Current position

```
Phase     : 0 — Foundation
Task      : → current: P0-T1 (Monorepo skeleton)   [not started]
Branch    : genspark_ai_developer
Blockers  : none
```

## Repo health — verification commands

Run these to confirm the repo is in the expected state before working:

```bash
git status                 # must be clean
git log --oneline -3       # last task IDs should match the session log below
# After P0-T1 exists:
#   npm install && npm run verify        → must be green
# After P0-T3 exists:
#   CTB_SECRET=devsecret0123456 npm run db:migrate
```

Expected right now: **docs-only repository** (no package.json yet). `npm run verify` does
not exist until P0-T1 is done.

## What exists / what doesn't

| Area | Status |
|---|---|
| Vision/architecture/node specs/plan docs | ✅ complete (docs/) |
| Monorepo code | ❌ not started (P0-T1 is next) |
| Database | ❌ |
| Engine | ❌ |
| Telegram gateway | ❌ |
| Editor | ❌ |
| Open PR | none yet — open on first code commit |

## Environment notes

- Node.js >= 20 required. Sandbox has Node 20.x.
- `CTB_SECRET` env (≥16 chars) required for anything touching DB/crypto.
- Old PHP project (github.com/Saeedkhoshafsar/mirzabot) = **reference only**, never copy code.

## Session log (append-only, newest first)

| Date | Task(s) | Result / notes |
|---|---|---|
| 2026-06-10 | bootstrap | Repo created. Constitution (CLAUDE.md), PLAN.md (atomic tasks P0–P6), STATE.md, ARCHITECTURE/NODES/ROADMAP/PROTOCOL docs pushed. Stack versions pinned in PLAN.md against live npm registry. Next: P0-T1. |
