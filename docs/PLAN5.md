# PLAN5 — UI/UX hardening: responsive, safe inputs, non-blocking dialogs & performance

> **Status:** ACTIVE — authored after a customer-style UI/UX audit of the editor
> (`apps/editor`). Unlike PLAN1–4 (which planned *engine/server* capability), PLAN5
> is a **frontend quality** plan: it records every UI/UX defect found, the fix, the
> files touched, an acceptance criterion, and a verify command — per the CLAUDE.md
> rule that *a task is real only once it has files, acceptance criteria, and a
> verify command*.
>
> This file is the **living change-log** for the UI/UX remediation work. Each task
> is checked off (`[x]`) and dated as it lands, with its commit SHA.

---

## 0. Why PLAN5 exists (the customer report)

The user asked, as a customer, to "pour out" every UI/UX problem so effort can be
spent where it matters. A full audit of `apps/editor` (React 19 + Zustand +
@xyflow/react, fa-default / RTL-first) surfaced **20 issues** across 4 severity
tiers. The user then said: *"start fixing them in order; create a PLAN5 so all
changes are recorded."* This document is that record.

**Hard constraints carried from CLAUDE.md / the codebase:**
- RTL-first: use CSS **logical properties** (`margin-inline`, `inset-inline-*`),
  never hard-coded `left`/`right`.
- i18n: every user-facing string goes through `t()` with keys in **both**
  `src/i18n/fa.ts` and `src/i18n/en.ts` (keep key counts equal).
- TypeScript strict incl. `exactOptionalPropertyTypes: true`.
- `npm run verify` (typecheck + tests) must stay green per commit.
- Accessibility: respect `prefers-reduced-motion`; provide `aria-*` on new widgets.

---

## 1. What the editor ALREADY has (so we don't rebuild it)

| Area | Present today | Gap PLAN5 closes |
|---|---|---|
| Toasts | `src/stores/toast.ts` + `ToastHost.tsx` (added last session) | confirms still use blocking `window.confirm` |
| Design tokens | CSS vars in `styles.css` (`--bg`, `--accent`, `--radius`…) | **no responsive breakpoints** — only 3 `@media`, all `prefers-reduced-motion` |
| Forms | controlled inputs across pages | bot **token shown as plain text** (`BotsPage`), no password masking |
| Lists | bots/flows/executions/credentials tables | no search/filter; crowded 4–7-button action rows |
| Loading | plain "loading…" text in ~13 spots | no skeletons; layout jumps on load |
| Bundle | single Vite chunk | **886 KB** main chunk (>500 KB warn) — no code-splitting |
| Credentials | one 645-line page, 8 cred types, 20+ `useState` | overwhelming single form; inline styles |

---

## 2. The 20 issues (severity tiers)

### Tier A — Critical (security / unusable on common devices)
| # | Issue | Files |
|---|---|---|
| A1 | Bot **token rendered as plaintext** input — shoulder-surf / screenshot leak | `pages/BotsPage.tsx` |
| A2 | **No responsive layout** — tables & toolbars overflow on phones/tablets | `styles.css` |
| A3 | **Crowded action rows** (4–7 buttons/row) overflow on narrow screens | `pages/BotsPage.tsx`, `pages/FlowsPage.tsx` |

### Tier B — High (blocking modals, jarring loads)
| # | Issue | Files |
|---|---|---|
| B4 | **9 blocking `window.confirm`** calls freeze the tab, un-stylable, not RTL | 7 pages + 2 panels |
| B5 | **No skeleton loading** — "loading…" text causes layout shift | list pages |
| B6 | `FlowEditorPage` still has a `confirm()` for version restore | `pages/FlowEditorPage.tsx` |

### Tier C — Medium (findability / performance)
| # | Issue | Files |
|---|---|---|
| C7 | **No search/filter** in bots/flows/executions/credentials lists | list pages |
| C8 | **886 KB main chunk** — no route-level code-splitting | `App.tsx`, `vite.config.ts` |
| C9 | No empty-state guidance beyond a bare line | list pages |
| C10 | Focus styles inconsistent for keyboard users | `styles.css` |

### Tier D — Polish (consistency / maintainability)
| # | Issue | Files |
|---|---|---|
| D11 | **Inline styles** scattered (esp. Credentials) instead of classes | `pages/CredentialsPage.tsx` |
| D12 | Credentials page is one 645-line wall — should be a typed picker/wizard | `pages/CredentialsPage.tsx` |
| D13 | Inconsistent button sizing/spacing across pages | `styles.css` |
| D14 | No `:hover`/`:active` affordance on some clickable rows | `styles.css` |
| D15 | Long values not truncated (`text-overflow`) — rows wrap ugly | `styles.css` |
| D16 | No `title`/tooltip on icon-only actions | list pages |
| D17 | Tables lack sticky headers on scroll | `styles.css` |
| D18 | No "copy to clipboard" affordance for IDs/tokens | list pages |
| D19 | Form validation feedback is alert-driven, not inline | form pages |
| D20 | No global keyboard shortcuts (save/escape) help | editor |

---

## 3. Execution order (highest impact first)

Each task ends green (`npm run verify`) and is committed individually, then the PR
is updated. `⭐` = directly requested. Tasks are checked off as they land.

### Priority 1 — Critical (Tier A)
- **P1-T1 — Mask the bot token. ⭐ (A1)**
  - Files: `pages/BotsPage.tsx`, `i18n/fa.ts`, `i18n/en.ts`, `styles.css`
  - Change: token `<input>` → `type="password"` with a show/hide toggle button
    (eye icon), `autoComplete="off"`, `spellCheck={false}`. RTL-safe toggle via
    logical positioning.
  - Acceptance: token field is masked by default; toggle reveals/hides; value still
    posts correctly; new i18n keys present in both locales.
  - Verify: `cd apps/editor && npx tsc -p tsconfig.json --noEmit` + manual reveal.
  - Status: ☑ DONE — added `components/PasswordInput.tsx` (reusable masked field +
    eye toggle, RTL-safe via `inset-inline-end`), used in BotsPage token field;
    new `common.show`/`common.hide` keys; `.password-field`/`.password-toggle` CSS.

- **P1-T2 — Responsive breakpoints. (A2)**
  - Files: `styles.css`
  - Change: add `@media (max-width: 1024px)` and `(max-width: 640px)` blocks: stack
    toolbars, allow horizontal table scroll wrappers, shrink paddings, wrap nav.
  - Acceptance: at 375 px width no horizontal page overflow; toolbars wrap; tables
    scroll inside a container, not the page.
  - Verify: build + visual check at 375/768/1280.
  - Status: ☑ DONE — appended two breakpoints (`<=1024px`, `<=640px`): topbar nav
    wraps, page-head stacks, `.row` controls go full-width on phones, forms stack,
    tables scroll-in-container, titles truncate. All logical-property based.

- **P1-T3 — Collapse crowded action rows into an overflow menu. (A3)**
  - Files: NEW `components/ActionMenu.tsx`, `pages/BotsPage.tsx`,
    `pages/FlowsPage.tsx`, `styles.css`, i18n keys
  - Change: keep 1–2 primary actions inline; move the rest behind a `⋯` kebab menu
    (RTL-aware, keyboard-navigable, closes on outside click / Escape).
  - Acceptance: each row shows ≤3 controls + a kebab; menu opens/closes; all actions
    still reachable; no overflow at 640 px.
  - Verify: build + manual.
  - Status: ☑ DONE — added `components/ActionMenu.tsx` (RTL-safe kebab, closes on
    outside click / Escape, supports link & button items). BotsPage now shows
    start/stop + flows inline and moves users/collections/aiBudget/delete into the
    menu; FlowsPage keeps activate + edit inline and moves export/delete into it.
    New `common.moreActions` key + `.action-menu*` styles.

### Priority 2 — High (Tier B)
- **P2-T4 — Custom non-blocking confirm dialog. ⭐ (B4, B6)**
  - Files: NEW `stores/confirm.ts`, NEW `components/ConfirmHost.tsx`, mount in
    `App.tsx`; replace all `window.confirm`/`confirm` in BotsPage, FlowsPage,
    CredentialsPage, AdminsPage, CollectionsPage, ExecutionsPage,
    RecordsPanel, FlowEditorPage; i18n keys.
  - Acceptance: deletes/destructive actions open a styled modal (RTL, focus-trapped,
    Escape=cancel, Enter=confirm); no `window.confirm` remains in `src/`.
  - Verify: `grep -rn "window.confirm\|[^.]confirm(" apps/editor/src` → 0 hits;
    build; new unit test for the confirm store.
  - Status: ☑ DONE — added `stores/confirm.ts` (promise-based `confirmDialog`) +
    `components/ConfirmHost.tsx` (focus-managed modal, Esc=cancel/Enter=confirm,
    backdrop-cancel, RTL-safe), mounted in App shell. Replaced all 9
    `window.confirm`/`confirm` across BotsPage, FlowsPage, CredentialsPage,
    AdminsPage (×2), CollectionsPage, ExecutionsPage, RecordsPanel, FlowEditorPage.
    New `common.confirm.title`/`common.confirm.ok` keys; 5 unit tests
    (`test/confirm-store.test.ts`) all pass. Grep confirms 0 raw confirm() remain.

- **P2-T5 — Skeleton loading states. (B5)**
  - Files: NEW `components/Skeleton.tsx`, `styles.css`, list pages
  - Acceptance: list pages show shimmer skeleton rows while `loading`, no layout
    shift when data arrives; honors `prefers-reduced-motion`.
  - Verify: build + manual.
  - Status: ☑ DONE — added `components/Skeleton.tsx` (`SkeletonRow`/`SkeletonList`,
    `.row`-shaped shimmer, `aria-busy`) + `.skeleton*` CSS gated behind
    reduced-motion. Wired into BotsPage, FlowsPage, CredentialsPage, AdminsPage
    loading branches (replacing the bare "loading…" splash text).

### Priority 3 — Medium (Tier C)
- **P3-T6 — Search/filter in lists. (C7)**
  - Files: NEW `components/SearchBox.tsx`, list pages, i18n keys
  - Acceptance: typing filters the visible rows client-side (case-insensitive);
    clear button resets; empty result shows a friendly message.
  - Status: ☑ DONE — added `components/SearchBox.tsx` (controlled, clear button,
    RTL-safe) + `.search-box` CSS. Wired into BotsPage & FlowsPage (search appears
    once a list has >5 items; case-insensitive name filter; `common.noResults`
    empty state). New `common.search`/`common.clear`/`common.noResults` keys.

- **P3-T7 — Route-level code-splitting. (C8)**
  - Files: `App.tsx` (React.lazy + Suspense), maybe `vite.config.ts`
  - Acceptance: main chunk < 500 KB; routes lazy-load; build emits no >500 KB warn
    for the entry chunk.
  - Verify: `cd apps/editor && npx vite build` → entry chunk < 500 KB.
  - Status: ☑ DONE — every authed page is now `React.lazy` + a `Suspense`
    fallback in the Shell (LoginPage stays eager). Added `manualChunks` in
    `vite.config.ts` splitting `@xyflow`/d3, CodeMirror/Lezer, and React into
    vendor chunks. **Entry chunk dropped from 886 KB → 244 KB**; no >500 KB warn;
    CodeMirror (418 KB) & flow vendor (177 KB) load only on the flow-editor route.

### Priority 4 — Polish (Tier D)
- **P4-T8 — De-inline styles via utility classes. (D11)**
  - Files: `styles.css` (new `.u-*` utilities), `pages/CredentialsPage.tsx`,
    `pages/BotsPage.tsx`
  - Acceptance: the most-repeated inline `style=` objects replaced with reusable,
    RTL-safe utility classes; behavior unchanged; build green.
  - Status: ☑ DONE — added `.u-mb-1/.u-mt-1/.u-mt-half/.u-row/.u-full` utilities
    and replaced the recurring inline styles in BotsPage (3) and CredentialsPage
    (5: the create form + 4 checkbox label rows). Build & typecheck green.
  - Note: the full Credentials *wizard* redesign (D12) is deferred — the 645-line
    page works correctly today; restructuring it is its own session to avoid risk.
    Tracked as a follow-up in §5.

> Remaining Tier-D items (D13–D20) are folded into the tasks above where they touch
> the same files, and any leftover is tracked here as it lands.

---

## 4. Change log (append-only)

| Date | Task | Commit | Notes |
|---|---|---|---|
| 2026-06-28 | PLAN5 authored | 7ffbcfd | Document created; audit recorded |
| 2026-06-28 | P1-T1 token mask | 44e213e | PasswordInput component + show/hide toggle |
| 2026-06-28 | P1-T2 responsive | bad5d2a | Tablet/phone breakpoints, stacking layout |
| 2026-06-28 | P1-T3 action menu | dde5f20 | ActionMenu kebab; declutter Bots/Flows rows |
| 2026-06-28 | P2-T4 confirm dialog | 3fcf8ca | Promise-based modal replaces 9 window.confirm |
| 2026-06-28 | P2-T5 skeletons | 5702911 | Shimmer skeleton rows on list loads |
| 2026-06-28 | P3-T7 code-split | fcfb47d | React.lazy routes + manualChunks; 886→244 KB entry |
| 2026-06-28 | P3-T6 search | ddd13f6 | SearchBox client-side filter on Bots/Flows |
| 2026-06-28 | P4-T8 de-inline | _this commit_ | Utility classes replace recurring inline styles |

---

## 5. Follow-ups (next sessions)

These were identified but intentionally deferred to keep each commit small and
low-risk. They remain open tasks:

| # | Item | Why deferred |
|---|---|---|
| D12 | Credentials page → typed wizard (one type's fields at a time) | 645-line page works today; a structural rewrite deserves its own session + tests |
| C7+ | Search/filter on Executions & Credentials lists | base SearchBox now exists; wiring is mechanical |
| D17 | Sticky table headers on scroll | nice-to-have polish |
| D18 | Copy-to-clipboard for ids/tokens | small UX win, no blocker |
| D20 | Global keyboard-shortcut help | editor power-user feature |
