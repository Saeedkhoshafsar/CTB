# 🎬 Phase-A demo — a Jalali task report built from only data nodes

This is the documented end-to-end run that proves **Phase A** of PLAN2: the
"core nodes" tier. A flow assembled from **nothing but Phase-A nodes** — no AI,
no external service — takes a user command, runs a real data-transform pipeline
(split → dedupe → sort → limit → aggregate), stamps the result in the **Jalali
(Persian) calendar**, and replies in Telegram with a formatted summary **and a
media album**. It is the conversational-domain answer to an n8n "core nodes"
workflow.

It exercises every Phase-A node tier at once:
`data.editFields` (PA-T3), `data.filter` (PA-T4), `data.splitOut` /
`data.aggregate` (PA-T5), `data.sort` / `data.limit` / `data.removeDuplicates`
(PA-T6), `data.dateTime` with the Jalali calendar (PA-T7), and the Telegram
media sender `tg.sendMedia` (PA-T1).

> The whole script below is exercised automatically, against a fake Telegram
> transport and the real `UpdateRouter` + `Executor` + `MemoryExecutionStore`,
> by `apps/server/test/e2e-phaseA-demo.test.ts`. The flow graph lives in
> `packages/shared/test/fixtures/phase-a-demo-flow.json`. Run it with:
>
> ```bash
> npm run test --workspace=@ctb/server -- e2e-phaseA-demo
> ```

---

## The flow

A 13-node flow, owned by a bot and **activated**, triggered by `/report`:

| # | Node | Type | What it does |
|---|------|------|--------------|
| 1 | trigger | `tg.trigger` | fires on the `/report` command |
| 2 | seed | `data.editFields` | seeds a `tasks[]` array via **JSON value-mode** (in a live bot this is a Collection / HTTP / the user's message) |
| 3 | split | `data.splitOut` | one item per task → 5 items (one is a duplicate) |
| 4 | dedupe | `data.removeDuplicates` | compare on `title`+`due`, drop the repeat → 4 items |
| 5 | sort | `data.sort` | by `due` ascending |
| 6 | limit | `data.limit` | keep the first 3 |
| 7 | aggregate | `data.aggregate` | collapse the items back into ONE: `titles[]` + `dues[]` |
| 8 | stamp | `data.dateTime` | `source: now`, `calendar: jalali`, Persian digits → `report_date.formatted` |
| 9 | compose | `data.editFields` | build `count` + the reply `text` from the aggregated arrays + the Jalali stamp |
| 10 | gate | `data.filter` | `count > 0` → `kept` \| `discarded` |
| 11 | reply | `tg.sendMessage` | the summary text (kept branch) |
| 12 | reply_empty | `tg.sendMessage` | "nothing to report" (discarded branch) |
| 13 | album | `tg.sendMedia` | a 2-photo album, after the summary |

Edges (happy path):
`trigger → seed → split → dedupe → sort → limit → aggregate → stamp → compose →
gate —(kept)→ reply → album`, with `gate —(discarded)→ reply_empty`.

Everything stays **generic (I2)**: the engine knows nothing about "tasks" or
"reports" — those words live only in node param strings.

---

## The run, step by step

### 1. The user sends `/report`

`tg.trigger` matches the command and the engine starts a run for chat `555`. The
clock is pinned to `2026-06-11T08:00:00.000Z` (the injected `ctx.now()`), which
is `11:30` in `Asia/Tehran`.

### 2. Seed → a dataset appears

`data.editFields` runs in JSON value-mode, parsing its string into a real array
of five tasks (with `طراحی / 2026-06-11` appearing twice):

```jsonc
[
  { "title": "طراحی",   "due": "2026-06-11" },
  { "title": "کدنویسی", "due": "2026-06-09" },
  { "title": "طراحی",   "due": "2026-06-11" },   // duplicate
  { "title": "تست",     "due": "2026-06-14" },
  { "title": "استقرار", "due": "2026-06-12" }
]
```

### 3. Split → dedupe → sort → limit

The classic n8n "core nodes" pipeline, on the conversational engine:

```
splitOut         → 5 items (one per task)
removeDuplicates → 4 items   (drop the repeated طراحی,2026-06-11)
sort by due asc  → کدنویسی(09) طراحی(11) استقرار(12) تست(14)
limit first 3    → کدنویسی(09) طراحی(11) استقرار(12)
```

### 4. Aggregate → one item again

`data.aggregate` (`aggregate_individual_fields`) collapses the three items into a
single item carrying two parallel arrays:

```jsonc
{
  "titles": ["کدنویسی", "طراحی", "استقرار"],
  "dues":   ["2026-06-09", "2026-06-11", "2026-06-12"]
}
```

### 5. Stamp the Jalali date

`data.dateTime` formats `now` in the **Jalali** calendar with **Persian digits**.
For the fixed clock (11:30 Asia/Tehran) this is `۱۴۰۵/۰۳/۲۱`, saved to
`report_date.formatted`. No external library — the Gregorian↔Jalali conversion is
the dependency-free Borkowski algorithm in `packages/nodes/src/lib/jalali.ts`.

### 6. Compose the reply

`data.editFields` builds `count` (= `titles.length` = 3) and the `text` from the
aggregated single item:

```
📋 گزارش کارها — ۱۴۰۵/۰۳/۲۱
(3 مورد، به‌ترتیب سررسید)
• کدنویسی — 2026-06-09
• طراحی — 2026-06-11
• استقرار — 2026-06-12
```

### 7. Gate → reply + album

`data.filter` checks `count > 0`. With three tasks the item leaves the **kept**
port: `tg.sendMessage` sends the summary, then `tg.sendMedia` sends a 2-photo
album with the caption `نمودارهای گزارش 📷`. The **discarded** branch
(`reply_empty`) never fires.

---

## What this demo proves

- **Phase A is a complete data tier.** A flow built from *only* core data nodes
  can split, filter, dedupe, sort, limit, aggregate and date-format a dataset —
  the conversational-domain equivalent of an n8n core-nodes workflow.
- **Jalali is first-class (PA-T7).** Date formatting in the Persian calendar
  with Persian digits is built in, dependency-free, and driven by the injected
  clock — so it's deterministic under test.
- **`tg.sendMedia` closes the loop (PA-T1).** A run can reply with a media album,
  not just text.
- **Generic to the core (I2).** The engine learns nothing about "tasks"; the
  domain lives entirely in param strings and the seed dataset.
- **Durable by construction (I4).** The flow has no `tg.waitForReply`, so it runs
  end-to-end in a single dispatch and never parks a waiting row — the second test
  asserts `findWaiting()` is empty.

## Gotchas worth remembering

- **`$json` is item[0], and non-raw params are pre-resolved.** In
  `buildNodeScope` the executor binds `$json` to `items[0]?.json` only, and it
  pre-resolves `{{ … }}` in non-raw params **against item[0]** before the node
  runs. So a per-item field expression in a node param (e.g. feeding
  `data.dateTime`'s `value` a `{{ $json.field }}` over a multi-item batch)
  collapses to item[0]'s value for the whole batch. That's exactly why this demo
  **aggregates first, then formats**: by the time `compose` and `stamp` run there
  is a single item, so `$json.titles[i]` / `$json.report_date.formatted` resolve
  correctly. For the headline Jalali feature we use `source: now` (which reads
  `ctx.now()` directly and is unaffected) rather than a per-item `value`.
- **`data.filter` is batch-level, not per-item.** Its conditions are resolved
  once (against item[0]) and the same verdict routes the whole batch to `kept` or
  `discarded` — it does **not** partition items individually. Here that's the
  intended behaviour: one aggregated item, one gate decision.
- **`tg.sendMedia` carries `ref`, not `value`.** A `url` / `file_id` source is
  resolved into a `TgInputMedia` of shape `{ kind, ref }` (and `{ kind, bytes }`
  for base64/file). The node param key is `value`; the resolved transport item is
  `ref`. The e2e records and asserts on `ref`.
