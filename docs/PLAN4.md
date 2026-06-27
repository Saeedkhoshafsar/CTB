# PLAN4 — Go-live readiness: admin RBAC, setup checklist & live-trigger test runs

> **Status:** DRAFT — proposed after PLAN3 (Phases F/G/H/I) completed. Authored from
> a user field-test report (see `New Text Document.txt`, summarised in §0) plus a
> code audit of the current auth model and the test-run path.
> Source-of-truth rules from CLAUDE.md apply: a task is real only once it has
> **files, acceptance criteria, and a verify command** listed here. No code is
> written by this PR — PLAN4 is the *plan* for the next sessions.

---

## 0. Why PLAN4 exists (the user report, verbatim intent)

After PLAN1+PLAN2 built the engine and PLAN3 polished the editor, the user ran a
real go-live attempt and hit **two blocking gaps** plus asked for **management
features** before the bot can be made public. Translated and de-duplicated:

### Report A — Admin panel must be gated to specific people + a go-live checklist
1. The **admin panel** (and admin-only menus) must show **only to specific
   Telegram IDs we configure** — not to everyone.
2. On first bring-up there should be **a list of setup tasks** to complete. Each
   task **disappears from the list as it's done**; when the **last task is gone,
   the bot is considered ready** to go public.
3. Choosing the panel admins is one of those prerequisite tasks.
4. Project admins must later be able to **add/remove** another admin — but **the
   manager (owner) can never be removed**.
5. **Only the manager can hand the manager role to someone else**; doing so the
   old manager **demotes to admin** and can then be removed from admin like anyone.
6. "Such management features should exist" — i.e. a real role model, not a single
   shared password.

### Report B — Test/"trial" runs must behave like n8n's listen-for-trigger
7. To test a flow the user must add a **start trigger**, which needs the Telegram
   ID of the person messaging the bot — and the user is forced to **hand the
   trigger node's data to the next node manually**, i.e. a real trial run can't
   start cleanly.
8. In n8n, hitting **"Test workflow"** makes the trigger node **wait for the next
   real message**; when a message arrives it's **immediately passed to the next
   node** with the user/message data filled in. **CTB's node does NOT wait** — it
   fires an empty item immediately, and even when a message exists it doesn't pick
   up the sender's data reliably.
9. The editor **alerted that you must use the *Manual* trigger instead of the
   *Start/Telegram* trigger** for a test run — the user (rightly) says **a trial
   run and a built run must NOT use different nodes**. There is one flow; the same
   trigger node must work for both a trial and a production run.
10. "Study how n8n's nodes actually work so the architecture is exactly right."

> **One-line diagnosis:** CTB *has* the capability (a durable pause/resume engine,
> a session/role primitive, a generic users table) but it is **under-wired for
> go-live**: auth is a single shared password unrelated to Telegram identity, and
> the editor's test run is hard-coded to `flow.manualTrigger` instead of letting a
> real Telegram Trigger **listen for one live update** — exactly n8n's
> "listen-for-trigger" test mode.

---

## 1. What CTB ALREADY has (so we don't rebuild it)

Verified present this review — PLAN4 EXTENDS these, it does not green-field them:

| Area | Present today | Gap PLAN4 closes |
|---|---|---|
| Panel auth | stateless signed-cookie session (`apps/server/src/lib/session.ts`), `SessionRole = 'admin' \| 'operator'`, single username/password from env (`app.ts` login) | no Telegram-ID identity, no multi-admin, no owner role, no add/remove admin |
| Roles | `admin` (everything) / `operator` (Data only) used by `records.ts`/`collections.ts` | a third tier (`owner`/manager) + a durable admin **list** keyed by Telegram ID |
| End-user store | `SqliteUserStore` — per-bot end users, profile bag + tags (`engine/user-store.ts`) | this is end-users of a *built* bot, NOT panel admins — keep it separate (I2) |
| Test run | `POST /api/flows/:id/run` starts at `flow.manualTrigger`, runs to first WAIT/end/error; editor "Test run" button; pin-data (I-T1) + single-node (I-T2) | only the *manual* trigger; can't "listen" on a real `tg.trigger`; sender data not injected |
| Trigger match | `apps/server/src/engine/match.ts` `triggerMatches` reads `tg.trigger` params from the graph; router builds the trigger item and injects it | not reused for a *test* "listen for one update" capture |
| Durable engine | pause/resume executions table; `StartInput.testRun` (I-T1) + `stopAfterNode` (I-T2) seams | a third "listen" seam: a flow armed to capture the NEXT matching live update once |

> **Implication:** PLAN4 is mostly *wiring + a durable admin table + one new
> test-run mode*, reusing the session primitive, the trigger matcher, and the
> `testRun` engine seam. No engine rewrite, no new backend language (I1), no
> domain nodes (I2).

---

## 2. Guiding principles for PLAN4

1. **Reuse the seams.** The session primitive, the trigger matcher
   (`triggerMatches`), and the durable execution state already exist — PLAN4
   wires them together rather than inventing parallel machinery.
2. **One trigger node, two run modes.** Report B's core ask: a flow's
   `tg.trigger` is the SAME node in a trial and a production run. The difference
   is a *run mode* (listen-for-one vs live), never a different node type. This
   directly cures the "you must swap to Manual trigger" alert (item 9).
3. **Admins are panel identities, end-users are bot data — never conflate them**
   (I2). The new admin table is panel-scoped; `SqliteUserStore` stays the generic
   per-bot end-user store. An owner can be both, but the records are separate.
4. **Durability first (I4).** A "listen for the next update" arming must survive a
   process restart — it persists like every WAIT, never lives only in memory.
5. **Owner is a hard invariant.** The owner row can never be deleted and there is
   always exactly one; transfer is an atomic swap (old owner → admin, target →
   owner). Enforced in the store, not just the UI.
6. **Same protocol as PLAN1–3.** One task at a time; STATE2 updated in the same
   commit; tests required (an engine/auth change REQUIRES a round-trip /
   permission test); `npm run verify` green per commit; each schema-touching task
   gets its own ROADMAP Decision Log entry when it starts.

---

## 3. Phased plan (atomic tasks)

Order = highest go-live-blocker first. Each task is one session, ends green.
`⭐` = user explicitly asked for it.

### Phase J — Live-trigger test runs (Report B — the "I can't even test" blocker)

> Goal: the user hits **"Test run"** on a flow whose entry is a **real
> `tg.trigger`**, the trigger **arms and waits for the next live message**, and on
> arrival the **sender's data flows to the next node** — exactly like n8n. The
> same `tg.trigger` then powers the production run unchanged. Removes the
> "use the Manual trigger instead" alert.

- **J-T1 — "Listen for one live update" engine + server seam. ⭐ (items 7–9)**
  - Files: `packages/shared/src/api.ts` (NEW optional `StartInput.listenMode?`
    seam mirrored onto a persisted `ExecutionState.listening?` — its own Decision
    Log entry), `packages/core/src/engine/executor.ts` (a trigger node in
    `listening` test mode does NOT fire immediately — it parks the execution in a
    durable "armed" state, the same way a WAIT parks), `apps/server/src/api/flows.ts`
    (NEW `POST /api/flows/:id/test-listen` → arms the flow's enabled trigger for
    ONE capture; `GET /api/flows/:id/test-listen/status` → poll), `apps/server/src/engine/match.ts`
    (reuse `triggerMatches`: when an armed test-listen exists for a bot, the NEXT
    matching live update resumes THAT execution with the real trigger item and is
    NOT also delivered to a production run — exactly-once), shared/core tests.
  - Acceptance: arming a flow with a `tg.trigger` parks a durable execution
    (`status: 'listening'`); the next matching live update resumes it, the
    `tg.trigger` emits the **real** Telegram item (sender id/name/text) on `main`,
    and downstream nodes run; arming survives a simulated process restart (I4); a
    non-matching update does not consume the arming; a production run of the same
    `tg.trigger` is byte-identical to today (listenMode omitted).
  - Verify: `npm run test -w packages/core` (executor listen/resume + restart
    round-trip) + `npm run test -w apps/server` (test-listen arm/match/exactly-once)
    + `npm run verify`.

- **J-T2 — Editor "Test run" listens on the real trigger; drop the Manual-only alert. ⭐ (item 9)**
  - Files: `apps/editor/src/pages/FlowEditorPage.tsx` (Test-run flow: if the entry
    is a `tg.trigger`, call `test-listen` and show a **"Waiting for a message to
    @yourbot…"** banner with a Cancel button; poll status; on capture, load the
    run data so the NDV shows the captured input — the F-T1 banner pattern), NEW
    `apps/editor/src/lib/test-run.ts` (PURE, DOM-free decision: given the flow's
    entry node type, choose `manual` vs `listen` mode — unit-tested directly,
    F-T3 pattern), `apps/editor/src/api/client.ts` (`api.testListen` /
    `api.testListenStatus`), i18n en/fa, editor tests.
  - Acceptance: a flow whose entry is `flow.manualTrigger` test-runs exactly as
    today; a flow whose entry is `tg.trigger` shows the waiting banner and, after a
    real message, fills the NDV input/output — **no "use Manual trigger" alert**;
    the pure mode-decision is unit-tested; banner cancels cleanly (disarms).
  - Verify: `npm run test -w apps/editor` + editor typecheck + build.

- **J-T3 — Trigger-node parity audit + docs (item 10).**
  - Files: `docs/NODES.md` (§Triggers — document the two run modes on `tg.trigger`
    explicitly: production = router match; test = listen-for-one; state that the
    node TYPE never changes between trial and build), `docs/demos/test-run-listen.md`
    (a walkthrough mirroring n8n's "listen for test event"), an e2e in
    `apps/server/test` that arms a `tg.trigger`, injects one fake update, and
    asserts the captured item reached node 2 (mirrors existing phase e2e demos).
  - Acceptance: NODES.md states the single-node-two-modes contract; the e2e proves
    a `tg.trigger` test run delivers sender data downstream end-to-end.
  - Verify: `npm run test -w apps/server` (new listen e2e green) + `npm run verify`.
  - **✅ DONE** — `docs/NODES.md` §Triggers gained the explicit "Single-node-two-modes
    CONTRACT (J-T3)" clause (the `tg.trigger` TYPE never changes between trial and
    build); `docs/demos/test-run-listen.md` is the n8n "listen for test event" parity
    walkthrough; `apps/server/test/e2e-phaseJ-test-listen-demo.test.ts` proves it
    end-to-end (3/3 GREEN — TEST-mode capture → node 2 via the executions API,
    PRODUCTION-mode the SAME node replies to the sender, non-matching update keeps
    listening). Docs+test-only (schema/server/engine/editor untouched). The demo's
    `createBot` calls `POST /api/bots/:id/start` (the endpoint that registers the
    gateway sender) so the production-mode `tg.sendMessage` has a sender. **Phase J
    COMPLETE — J-T1 ✅ + J-T2 ✅ + J-T3 ✅.**

### Phase K — Admin identity & RBAC (Report A items 1, 4, 5, 6)

> Goal: replace the single shared password model with a durable, Telegram-ID-keyed
> admin list and a three-tier role model (**owner > admin > operator**), with the
> owner as a hard invariant. The panel and admin-only surfaces show only to
> configured identities.

- **K-T1 — Durable admin store + roles (owner/admin/operator). ⭐ (items 1, 6)**
  - Files: NEW Drizzle migration + table `panel_admins`
    (`apps/server/src/db/schema.ts`, append-only migration) keyed by Telegram user
    id (`tg_user_id`), with `role` (`owner`/`admin`/`operator`), `label`,
    `created_at`; NEW `apps/server/src/engine/admin-store.ts`
    (`SqlitePanelAdminStore`: `list`/`get`/`add`/`remove`/`setRole`/`transferOwner`
    with the **owner invariants enforced in the store**: exactly one owner, owner
    never removable, only an owner can transfer ownership and it atomically demotes
    the old owner to admin); extend `apps/server/src/lib/session.ts`
    (`SessionRole` gains `'owner'`; `owner` ⊇ `admin` ⊇ `operator` precedence in a
    pure `roleAtLeast(role, min)` helper), Zod schemas in `packages/shared`.
  - Acceptance: store enforces single-owner; `remove(owner)` rejects; `transferOwner`
    swaps roles atomically; `roleAtLeast('owner','admin')` true, `roleAtLeast('operator','admin')`
    false; existing `admin`/`operator` tokens still parse (back-compat). Round-trip
    + invariant tests.
  - Verify: `npm run test -w apps/server` + `npm run test -w packages/shared` + `npm run verify`.

- **K-T2 — Telegram-ID login + bootstrap-first-owner. ⭐ (items 1, 3)**
  - Files: `apps/server/src/app.ts` (login flow gains a path that binds a session
    to a Telegram identity present in `panel_admins`; the legacy env
    username/password becomes the **bootstrap owner** ONLY when the table is empty —
    first bring-up — and is recorded as the owner row), NEW
    `apps/server/src/api/admins.ts` (REST: `GET /api/admins`, `POST /api/admins`,
    `DELETE /api/admins/:id`, `PATCH /api/admins/:id/role`,
    `POST /api/admins/transfer-owner` — each guarded so only `roleAtLeast(admin)`
    can add/remove admins and only `owner` can transfer), route guards reuse the
    session role, server tests.
  - Acceptance: empty table + env creds → first login creates the owner row;
    thereafter a request from a non-listed identity is rejected; an admin can
    add/remove another admin but not the owner; transfer-owner requires owner and
    demotes the caller to admin. Permission-matrix tests.
  - Verify: `npm run test -w apps/server` + `npm run verify`.

- **K-T3 — Editor Admins page + role-gated UI. ⭐ (items 1, 4, 5)**
  - Files: NEW `apps/editor/src/pages/AdminsPage.tsx` (list admins; add by Telegram
    ID + label; remove; change role; "Transfer ownership" — owner-only, with a
    confirm), `apps/editor/src/api/client.ts` (the admins API methods),
    `apps/editor/src/App.tsx` / nav (show the Admins entry + admin-only sections
    only when `roleAtLeast('admin')`; hide them for `operator`), a PURE
    `apps/editor/src/lib/admin-acl.ts` (DOM-free: can-remove / can-transfer
    decisions given (myRole, targetRole) — unit-tested, F-T3 pattern), i18n en/fa,
    editor tests.
  - Acceptance: an `operator` never sees the Admins page or admin-only nav; an
    `admin` sees add/remove but the owner row has no Remove button and no role
    selector; only the `owner` sees "Transfer ownership"; the pure ACL decisions
    are unit-tested; the owner can never be removed from the UI (defence-in-depth,
    store already enforces).
  - Verify: `npm run test -w apps/editor` + editor typecheck + build.

### Phase L — Go-live setup checklist (Report A items 2, 3)

> Goal: on first bring-up the operator sees a **checklist of prerequisite setup
> tasks**; each task **disappears as it's satisfied**; when the **last one clears,
> the bot is marked ready** to go public. Choosing admins (Phase K) is one item.

- **L-T1 — Setup-checklist model (pure, derived from real state). ⭐ (item 2)**
  - Files: NEW `apps/server/src/engine/setup-checklist.ts` (a PURE function
    `computeChecklist(state)` → the OPEN items only, derived from REAL facts: is an
    owner set? at least one admin? at least one bot token registered? at least one
    active flow? `CTB_SECRET` set? webhook/polling configured? — each item is a
    pure predicate over already-stored state, so a task "disappears" simply by its
    predicate becoming true), NEW `GET /api/setup/checklist` in
    `apps/server/src/api/setup.ts` (returns open items + a `ready: boolean` =
    no open items), shared Zod types, server tests.
  - Acceptance: with nothing configured the checklist lists all prerequisites and
    `ready:false`; satisfying a prerequisite removes exactly that item; when all
    are satisfied `ready:true` and the list is empty; the compute is a pure
    function unit-tested against crafted states (no side effects).
  - Verify: `npm run test -w apps/server` + `npm run verify`.

- **L-T2 — First-run checklist UI + "bot ready" gate. ⭐ (item 2)**
  - Files: NEW `apps/editor/src/components/SetupChecklist.tsx` (a dismissible
    first-run panel listing OPEN items, each linking to the page that satisfies it
    — e.g. "Choose admins" → Admins page, "Add a bot token" → Bots page; reuses
    the F-T1 EmptyState CTA pattern), `apps/editor/src/api/client.ts`
    (`api.setupChecklist`), surface it on the dashboard/empty state; when
    `ready:true` show a "✅ Bot is ready to go public" state and the panel
    self-hides, i18n en/fa, editor tests.
  - Acceptance: the checklist renders only OPEN items and hides each as it clears;
    each item deep-links to its fixing page; at `ready:true` the checklist is
    replaced by the ready state; refreshing re-derives from server (no client-only
    "done" flags — the source of truth is real state, principle 1).
  - Verify: `npm run test -w apps/editor` + editor typecheck + build.

---

## 4. Sequencing & rationale

```
Phase J  (live-trigger test runs)  ← do FIRST: the user literally cannot test a flow today
Phase K  (admin identity & RBAC)   ← the go-live gate: who may see/operate the panel
Phase L  (setup checklist)         ← ties K (and bot/flow setup) into a guided first-run
```

J is the hardest *blocker* (you can't iterate without a working trial run) and is
pure engine+editor wiring of existing seams. K is the security/management
foundation the user asked for and L depends on K (the "choose admins" item).
Within K, **K-T1 (store + invariants) is the foundation** — UI/permissions build
on it.

## 5. Out of scope for PLAN4 (explicit non-goals)

- No engine rewrite; pause/resume stays as-is — the listen-for-one mode is a new
  *arming*, not a new executor.
- No second backend language (I1), no domain nodes (I2) — the admin store is
  panel infrastructure, not a bot-domain node.
- No OAuth / external identity provider — Telegram ID + the existing session
  cookie is the identity in v1 (a provider is a later, separate task).
- No conflation of panel admins with the per-bot end-user store (`SqliteUserStore`
  stays the generic bot-data store; principle 3).
- No multi-tenant billing (separate concern, as in PLAN3 §6).

## 6. Decision-log seeds (to copy into ROADMAP.md when a task starts)

- **PLAN4 reframes the next track from "editor polish" (PLAN3) to "go-live
  readiness"** after a real bring-up surfaced two blockers (no working trial run;
  single shared-password auth) and a management ask (multi-admin RBAC + setup
  checklist). It REUSES existing seams — the session primitive, the
  `triggerMatches` matcher, the durable execution state, and the `testRun`
  engine seam — rather than building parallel machinery.
- **J-T1 listen-for-one** is the schema/engine-touching item: a NEW optional
  `StartInput.listenMode` mirrored to a persisted `ExecutionState.listening`,
  durable across restart (I4) — needs its own Decision Log entry, sibling to
  `testRun` (#21) and `stopAfterNode` (#22). The KEY contract (Report B item 9):
  the `tg.trigger` node TYPE is identical in a trial and a production run — only
  the run mode differs — so the "use the Manual trigger instead" alert is removed.
- **K-T1 admin store** introduces a NEW `panel_admins` table and a third
  `SessionRole = 'owner'`; the owner invariants (exactly one, never removable,
  owner-only atomic transfer that demotes the old owner) are enforced in the
  STORE, not just the UI — needs its own Decision Log entry (a new stored
  contract + an auth-model change). Panel admins are panel identities keyed by
  Telegram ID and are kept strictly separate from `SqliteUserStore` end-users (I2).
- **L-T1 setup checklist** is a PURE derivation over already-stored facts (no new
  "task" table): a task "disappears" when its predicate over real state becomes
  true, and `ready` = no open predicates. This keeps the source of truth in the
  real configuration, not a separate mutable checklist record.
