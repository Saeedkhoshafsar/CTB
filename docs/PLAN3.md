# PLAN3 — n8n-parity & editor polish (the "make it usable" roadmap)

> **Status:** DRAFT — proposed after PLAN2 (Phases A–E) completed. Authored from a
> systematic review of n8n's editor against what CTB already ships.
> Source-of-truth rules from CLAUDE.md apply: a task is real only once it has
> files, acceptance criteria, and a verify command listed here.

---

## 0. Why PLAN3 exists (the honest diagnosis)

PLAN1 + PLAN2 built a **deep, working engine**: 61 nodes, pause/resume, AI tier,
live voice, an open builder API/MCP surface — verified booting end-to-end
(server + DB + 61-node catalog + 106 test files green).

But the user's lived experience was: *"I couldn't build a single workflow; every
node is overwhelming; I couldn't even find how to import/export a flow."*

The review showed the gap is **NOT missing capability** — it's **discoverability +
editor ergonomics**. CTB modelled its UI on n8n but never finished the *feel* of
n8n. Most missing pieces are small, high-leverage editor features, not engine work.

PLAN3 closes that gap **without** a pivot and **without** rewriting the engine.

---

## 1. What CTB ALREADY has (so we don't rebuild it)

Verified present in `apps/editor` this review:

| Area | Present |
|---|---|
| Canvas | React Flow, undo/redo, copy/paste, duplicate, minimap, snap, controls, background |
| Nodes | palette with search/filter, add/move/connect, enable-disable, per-node note, node detail panel |
| Forms | schema-driven form engine, expression-aware text (`{{ }}`), drag-from-data-panel, code (CodeMirror), credential/flow/collection ref pickers, **progressive disclosure "+ Add option" (UX-T1)** |
| Data | per-node run data panel, execution list/detail, exec logs |
| Flows | create/edit/delete, **import / export**, **template gallery**, versions + rollback, manual test run |
| Bots / Creds / Collections / Users | full CRUD pages; AI budget + usage |
| i18n | fa/en, RTL-first |

> **Implication:** PLAN3 is mostly *polish + a few well-known n8n features*, not
> green-field building. Each task below states whether it's NEW or an EXTEND.

---

## 2. Gap analysis — CTB vs n8n editor

Legend: ✅ have · 🟡 partial · ❌ missing · ⭐ user explicitly asked for it

| # | n8n feature | CTB today | Gap | Priority |
|---|---|---|---|---|
| G1 | **Fixed \| Expression toggle** per field (switch a field between a literal value and an expression, with an expression editor) | 🟡 expressions work inline but there is no explicit per-field mode toggle / dedicated expression editor | ❌ toggle ⭐ | **P1** |
| G2 | **Progressive field disclosure** ("+ Add option") | ✅ shipped UX-T1 | — | done |
| G3 | **Sticky notes** on the canvas (free-text annotation boxes) | ❌ | ❌ | P1 |
| G4 | **Pin data** — freeze sample data on a node so downstream nodes can be built/tested without re-running upstream | 🟡 run data exists; no pinning | ❌ | P2 |
| G5 | **Node "simple vs advanced" view** — beginner sees a minimal node; advanced fields collapsed | 🟡 UX-T1 hides optionals, but no explicit simple/advanced section grouping | 🟡 | P2 ⭐ |
| G6 | **Expression editor with autocomplete + preview** (resolve `{{ }}` against current data, show result inline) | 🟡 CodeMirror + drag exists; no live preview of resolved value | ❌ preview | P2 |
| G7 | **Node rename** (human label distinct from type) | 🟡 has `note`; no first-class rename/title | ❌ | P2 |
| G8 | **Add-node from a connection** (drag a wire to empty canvas → palette opens, auto-connects) | 🟡 palette + manual connect | ❌ wire-drop | P3 |
| G9 | **Inline "+" between connected nodes** to insert a node onto an existing edge | ❌ | ❌ | P3 |
| G10 | **Canvas groups** (visually box + label a set of nodes) | ❌ | ❌ | P3 |
| G11 | **Keyboard shortcut palette / help** (and full shortcut coverage) | 🟡 ~14 handlers | 🟡 | P3 |
| G12 | **Workflow-level "quick start"** — a one-click sample flow that runs in minutes | 🟡 template gallery exists but isn't surfaced as a guided first-run | 🟡 | **P1** ⭐ |
| G13 | **Onboarding / empty-state guidance** (what do I do first?) | ❌ | ❌ | **P1** ⭐ |
| G14 | **Node grouping in palette by use-frequency** ("common" vs "advanced") | 🟡 palette groups by category | 🟡 | P2 ⭐ |
| G15 | **Error surfacing on canvas** (a failed node glows; click → the error) | 🟡 exec logs exist; canvas error state unclear | 🟡 | P2 |
| G16 | **Re-run a single node / "execute node"** from the editor | 🟡 manual full-flow run exists | ❌ single-node | P3 |

---

## 3. Guiding principles for PLAN3

1. **Discoverability over capability.** Prefer surfacing an existing power to
   building a new one. (Import/export already exist — G12/G13 just expose them.)
2. **Generic at the engine level.** Like UX-T1, every editor improvement should
   be structural so all 61 nodes benefit at once — no per-node UI code.
3. **Beginner floor, expert ceiling.** A first-timer sees the minimum; the depth
   is one click away. (The user's exact ask.)
4. **No engine rewrite, no pivot, no n8n fork.** CTB keeps its differentiator
   (pause/resume conversational engine). PLAN3 is editor + UX only, except where
   an engine hook is genuinely required (e.g. single-node execute).
5. **Same protocol as PLAN1/PLAN2.** One task at a time; STATE2 updated in the
   same commit; tests required; `npm run verify` green per commit.

---

## 4. Phased plan (atomic tasks)

Order = highest user-pain-relief first. Each task is one session, ends green.

### Phase F — First-run & discoverability (the "I couldn't build anything" cure)

> Goal: a brand-new user reaches a **working bot reply in under 5 minutes**, and
> can always find import/export/templates. Mostly surfacing existing power.

- **F-T1 — Guided empty state + "Quick start". ✅ DONE**
  - Files: `apps/editor/src/pages/FlowsPage.tsx`, `FlowEditorPage.tsx`, NEW
    `apps/editor/src/components/EmptyState.tsx`, NEW
    `apps/editor/src/lib/empty-state.ts` (the PURE decision layer), `styles.css`,
    i18n en/fa, NEW `apps/editor/test/empty-state.test.ts`.
  - Built: when a bot has no flows → a friendly empty state (`<FlowsEmptyState>`)
    with three CTA cards — **"⚡ Start from template"** (opens the existing
    template gallery; the single *primary* CTA = fastest path to a working bot),
    **"📥 Import a flow"** (opens the existing import panel), **"➕ Blank canvas"**
    (opens the existing New-flow form). Each CTA only OPENS an affordance
    FlowsPage already owns — no second flow-creation path (principle 1). When a
    flow's canvas is empty → `<CanvasEmptyHint>` overlays a centred card ("add a
    Telegram Trigger to begin") whose button scrolls the always-visible palette
    into view + flashes it; the hint vanishes the moment any node is placed
    (`isCanvasEmpty`).
  - Done the F-T3 way: the risky decisions live in a PURE, DOM-free module
    (`emptyStateActions` ordering+primary, `isCanvasEmpty`, `CANVAS_HINT_KEYS`)
    so they're unit-tested directly; the React components are thin glue.
  - Verify: `npm run test -w apps/editor` → **185 GREEN** (+8 empty-state tests);
    editor typecheck + build GREEN. Additive — no schema/server/registry change.

- **F-T2 — "Hello bot" first-run template + 5-minute walkthrough doc. ✅ DONE**
  - Files: `packages/shared/src/flow-templates.ts` (add a minimal
    Trigger→SendMessage greeting template if not present), `docs/demos/quickstart.md`.
  - Acceptance: the template imports + activates + a manual run sends the greeting
    (e2e mirrored from existing `e2e-phaseC-authoring-demo.test.ts`).
  - Verify: `npm run test -w apps/server` (new quickstart e2e green).

- **F-T3 — Surface export in the flow EDITOR toolbar. ✅ DONE**
  - Files: `FlowEditorPage.tsx`, NEW `apps/editor/src/lib/flow-export.ts`,
    `FlowsPage.tsx` (de-duplicated onto the shared helper), i18n en/fa,
    NEW `apps/editor/test/flow-export.test.ts`.
  - Built: an **Export** button in the editor toolbar (next to Save / Test run)
    — the cure for the #1 complaint ("how do I extract a workflow?"). It flushes
    pending edits first (`saveNow`), fetches `GET /api/flows/:id/export`, and
    downloads the portable envelope (graph + settings, no identity) as
    `<name>.json`. Import + the template gallery already live on the per-bot flow
    LIST page (`FlowsPage`) — the correct home, since both CREATE a new flow — so
    F-T3 adds the one missing affordance (export-while-editing) and unifies the
    download logic.
  - Done: filename/blob logic extracted to a pure, tested helper
    (`flowExportFilename`/`flowExportBlob`) shared by both call sites;
    `downloadFlowExport` is the thin DOM glue.
  - Verify: `npm run test -w apps/editor` → **177 GREEN** (+6 flow-export tests);
    editor typecheck + build GREEN. Additive — no schema/server/registry change.

### Phase G — Field ergonomics (the "every node is confusing" cure)

- **G-T1 — Fixed | Expression toggle per field. (⭐ user ask, gap G1) ✅ DONE**
  - Files: `apps/editor/src/form/widgets.tsx`, new `ExpressionToggle.tsx`,
    `apps/editor/src/form/expression.ts`, `styles.css`, i18n.
  - Build: each editable text/number field gets a small `Fixed | Expression`
    switch. Fixed = literal input; Expression = the expression editor (reuse the
    existing `{{ }}` machinery) with the value stored as an expression string.
    Purely structural in the form engine → all nodes benefit (principle 2).
  - Acceptance: toggling Fixed→Expression converts the value and back without data
    loss; an expression value validates against the node's real Zod schema; tests
    in `form-engine.test.ts` against real schemas.
  - Verify: `npm run test -w apps/editor`.

- **G-T2 — Live expression preview. (gap G6) ✅ DONE**
  - Files: expression editor widget, `DataPanel` wiring.
  - Build: while editing an expression, show the resolved value against the
    current/pinned input item (read-only). Reuse the engine's expression evaluator
    via a safe editor-side resolve (or a `/api/flows/:id/preview-expression`
    endpoint if host eval is required — decide in the task, log the decision).
  - Acceptance: `{{ $json.x }}` previews the live value; an invalid expression
    shows an inline error, never throws.
  - Verify: editor + (if endpoint added) server tests.

- **G-T3 — Explicit "simple vs advanced" field grouping. (⭐ gap G5) ✅ DONE**
  - Files: `form/schema.ts` (extend partition with a `z.meta({ advanced:true })`
    annotation read structurally), `SchemaForm.tsx`, i18n, `styles.css`,
    `packages/shared/src/node-params.ts` (`tg.sendMessage.parse_mode` demoted).
  - Build: a node author can mark a param "advanced"; the form shows simple fields
    + the "+ Add option" menu, and an "Advanced" collapsible for the rest. Builds
    directly on UX-T1's partition.
  - Done: structural `advanced` annotation (proven to survive `z.toJSONSchema`
    like `ctbWidget`, Decision Log #18) → `partitionFields` third bucket rendered
    under a native `<details>` collapsible (auto-opens via `anyAdvancedSet` when
    any advanced field already has a value); purely presentational so the engine /
    stored params / exports are byte-identical.
  - Acceptance: a field annotated advanced is hidden under the collapsible; default
    (unannotated) behaviour is unchanged; tests against real schemas. ✅
  - Verify: editor typecheck + build GREEN; editor tests **206 GREEN** (+5);
    shared 74 + server 450 GREEN (schema-meta touch inert).

### Phase H — Canvas power (the "organize a big flow" cure)

- **H-T1 — Sticky notes. (gap G3) ✅ DONE** New canvas element type stored in the
  graph as `FlowGraphSchema.notes` (a NEW optional `StickyNote[]` — Decision Log
  #19), rendered as a React Flow custom node kind (`sticky`) derived per-render
  from `graph.notes`; create (toolbar button) / in-place edit / `NodeResizer`
  resize / 5-colour picker, persisted with the flow (rides undo/redo, autosave and
  export/import for free). The engine is provably inert — the executor reads only
  `graph.nodes`/`graph.edges`, so `notes` defaults to `[]` and every existing
  stored flow, fixture and export parses byte-identically. Verified: shared
  `flow.test.ts` (8 note tests: defaults/round-trip/clamps/dup-id/colour) +
  `flow-export.test.ts` (notes survive export→import), editor `canvas-graph.test.ts`
  (notesToRfNodes / nextNoteId / rfId↔noteId) + `canvas-store.test.ts`
  (add/update/remove + move/resize gesture coalescing), all 4 workspaces typecheck.
- **H-T2 — Node rename / human title. (gap G7) ✅ DONE** A NEW optional
  `FlowNode.title?` (`string` ≤120 — Decision Log #20), a PRESENTATIONAL human
  name shown on the canvas head (with the type label dropping to a sub-line so
  the user still sees WHAT the node is), the param-panel header, and the NDV
  header; editable via a "Name" text field in the param panel (placeholder = the
  type label). The precedence rule is a pure, DOM-free `nodeDisplayName(node,
  typeLabel)` (a non-blank trimmed title wins, else the type label) so it is
  unit-tested directly; the React surfaces are thin glue (F-T3 pattern). The
  executor NEVER reads `title` (it routes by `id`/`type`/edges, like it already
  ignores `position`/`note`), so the field is `.optional()` (no default) and
  every existing stored flow/fixture/export parses byte-identically. **Scope
  note:** "expressions can reference a node by title" is deliberately NOT
  shipped — CTB's linear cursor executor doesn't retain every node's output
  keyed by name, so an `$('Node Name')` handle is a deep durability change
  outside an atomic H-T2 (a node id already uniquely addresses a node); if ever
  wanted it is a separate engine task with its own Decision Log entry.
  - Verify: shared `flow.test.ts` (+6 title: optional/absent, sample byte-id,
    custom title preserved, RTL title, >120 rejected, =120 accepted) + editor
    `canvas-graph.test.ts` (+5 `nodeDisplayName`: fallback, title-wins, blank/ws
    unset, trim, RTL); shared **89** + editor **221** GREEN; all 6 workspaces
    typecheck. Additive — no server/registry/node change.
- **H-T3 — Canvas error surfacing. (gap G15) ✅ DONE** A node that failed on the
  LATEST execution now glows red on the canvas (pulsing `.ctb-node.errored`
  outline, motion-reduced for `prefers-reduced-motion`) and shows a clickable
  "Failed on last run" flag; the click opens the NDV, which renders the failing
  node's error as a banner under the head alongside its INPUT/params. The error
  text comes from a NEW pure, DOM-free `mapRunErrors(logs)` (sibling to
  `mapRunData`) that keeps exactly the `level:'error'` rows `mapRunData` SKIPS
  (a failed step has no I/O snapshot) — it prefers the structured `error` column,
  falls back to `message`, defaults to `'error'`, and keeps the LAST error per
  node (loop-revisit = most recent, matching mapRunData's "latest visit"). The
  run-data store gained `errorsByNode: Map<string,string>` populated next to
  `byNode` (cleared on empty/reset); the canvas surfaces are thin glue (F-T3
  pattern). Read-only overlay — no schema/server/executor change.
  - Verify: editor `run-data.test.ts` (+8: mapRunErrors skip-vs-keep,
    error-over-message fallback, empty→`'error'`, last-wins/ignore non-error &
    nodeless; store exposes `errorsByNode` on a fixture run where one node throws
    while another succeeds, and clears it on empty/reset) + i18n parity; editor
    **226** + shared **89** GREEN; all 6 workspaces typecheck; editor build OK.
- **H-T4 — Add-node-on-edge + wire-drop-to-palette. (gaps G8/G9)** Insert a node
  onto an existing edge via an inline "+"; drop a dangling wire on empty canvas to
  open the palette pre-targeted. Verify: canvas-graph tests.

### Phase I — Run & iterate (the "test fast" cure)

- **I-T1 — Pin data on a node. (gap G4)** Store a pinned sample item on a node
  (shared schema + engine: use pinned data instead of upstream when present in a
  TEST run only, never in production). Decision Log entry (engine behaviour).
  Verify: core executor test (pin used in test run, ignored in prod) + editor.
- **I-T2 — Execute a single node. (gap G16)** From the editor, run one node with
  its (pinned or upstream) input and show the output, without running the whole
  flow. Verify: server + editor tests.
- **I-T3 — Keyboard shortcut help overlay + coverage sweep. (gap G11)** A `?`
  overlay listing shortcuts; fill obvious gaps (delete, duplicate, select-all,
  fit-view). Verify: editor tests.

---

## 5. Sequencing & rationale

```
Phase F  (discoverability)   ← do FIRST: directly fixes "I couldn't build anything"
Phase G  (field ergonomics)  ← fixes "every node is confusing" (incl. the ⭐ toggle)
Phase H  (canvas power)      ← scaling to bigger flows
Phase I  (run & iterate)     ← speed of building/testing
```

F and G are the user's actual pain; do them before H/I. Within F, **F-T1 + F-T3
are pure surfacing of existing features** — the cheapest, highest-impact wins.

## 6. Out of scope for PLAN3 (explicit non-goals)

- No engine rewrite; pause/resume stays as-is.
- No n8n community-node fork / republishing CTB as an n8n plugin (decided against
  earlier this thread — CTB's pause/resume engine is the differentiator).
- No new domain nodes (invariant I2 stands).
- No multi-tenant/billing work (separate concern).

## 7. Decision log seeds (to copy into ROADMAP.md when a task starts)

- PLAN3 reframes remaining work from "more capability" to "discoverability +
  ergonomics" after the end-to-end audit showed the engine is feature-complete
  for v1 but the editor under-surfaces it.
- Sticky notes (H-T1), node title (H-T2) and pin data (I-T1) are the only PLAN3
  items that touch the shared flow schema; each needs its own Decision Log entry
  because they change a stored contract.
