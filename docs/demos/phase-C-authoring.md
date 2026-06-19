# 🎬 Phase-C demo — an external agent builds and runs a CTB flow

This is the documented end-to-end run that proves **Phase C** of PLAN2: the open
**builder surface**. It shows an *external* system — an n8n flow, a deploy
script, or an AI agent over MCP — **discovering the node library and assembling,
validating, activating, and running a CTB flow without ever opening the editor**,
using nothing but the bearer-token v1 API.

It exercises every Phase-C pillar at once:

- **PC-T1** node catalog — `GET /api/v1/node-types` (discover the bricks)
- **PC-T2** flow authoring — `POST /api/v1/flows` + `/validate` + `/activate`
- **PC-T2** triggering + polling — `POST /…/trigger` + `GET /api/v1/executions`
- **PC-T3** the same lifecycle is mirrored over **MCP** (`list_nodes` /
  `validate_flow` / `create_flow` / `trigger_flow`)
- **PC-T5** the [PROTOCOL.md "Authoring & MCP" chapter](../PROTOCOL.md#authoring--mcp--building-flows-from-outside--pc-t5)
  this demo backs

> The whole script below is exercised automatically, against the **real** wired
> engine + in-memory SQLite + a fake Telegram transport, by
> `apps/server/test/e2e-phaseC-authoring-demo.test.ts`. Run it with:
>
> ```bash
> npm run test --workspace=@ctb/server -- e2e-phaseC-authoring-demo
> ```

---

## The setup

The **operator** does a one-time panel setup, then hands the agent a token:

1. create a bot, start it (so the `tg.sendMessage` leg has a live sender),
2. mint a **bot-scoped** API token (`POST /api/api-tokens`) — the agent can act
   only on this one bot.

Everything after that is the **agent**, over `Authorization: Bearer ctb_…`.

## The lifecycle

```
  DISCOVER  GET  /api/v1/node-types                 read the catalog
     BUILD  POST /api/v1/flows  { bot_id,name,graph }  assemble a 3-node draft
  VALIDATE  POST /api/v1/flows/:id/validate         dry-run → { ok:true }
  ACTIVATE  POST /api/v1/flows/:id/activate         draft → active
   TRIGGER  POST /api/v1/flows/:id/trigger          202 { executionId }
      POLL  GET  /api/v1/executions?flow_id=:id     status → "done"
```

## The flow the agent builds

A 3-node flow assembled from **only catalog node types**:

| # | Node | Type | What it does |
|---|------|------|--------------|
| 1 | trig | `flow.manualTrigger` | entry point — the trigger the API run enters at |
| 2 | compose | `data.setFields` | sets `$json.greeting = "Hello from an external agent 👋"` |
| 3 | send | `tg.sendMessage` | sends `{{ $json.greeting }}` to chat `555` through the bot's sender |

Edges (solid data flow): `trig → compose → send`.

---

## What the run proves

### 1. Discover
The agent calls `GET /api/v1/node-types` and **finds** `flow.manualTrigger`,
`data.setFields`, and `tg.sendMessage` in the catalog — it learns they exist
(and reads their `ports` + JSON-Schema `params`) rather than assuming. The
catalog is the *same* projection the engine registry serves the editor, so it
can never advertise a node the engine can't run.

### 2. Build
It assembles the 3-node graph and `POST`s it to `/api/v1/flows` (using the
snake_case `bot_id` alias a script would naturally send). The response is a fresh
**draft** (`status:"draft"`, `version:1`) — creating never auto-activates.

### 3. Validate (dry-run)
`POST /…/validate` returns `{ ok:true, problems:[], nodeProblems:[] }` and
**mutates nothing** — the flow is still a draft afterward. (The validator is the
*same* `validateFlowForActivation` the panel uses, so a v1-authored flow can
never drift from an editor-built one — **I5**.)

### 4. Activate
`POST /…/activate` flips the draft to `status:"active"` (and would re-arm any
cron schedules). A failed validation here would return `422 not_activatable` with
the problem list, leaving the flow a draft.

### 5. Trigger → poll → delivered
`POST /…/trigger { chat_id: 555 }` returns `202 { executionId }`. The agent polls
`GET /api/v1/executions?flow_id=…` until the run reaches **`done`**, then confirms
the bot actually **sent** `Hello from an external agent 👋` to chat `555` —
proving the `{{ $json.greeting }}` expression resolved against the `data.setFields`
output through the bot's centralized rate-limited sender, exactly as it would for
a flow drawn on the canvas.

### The safety rail (second test)
A graph that uses a node type **not in the catalog** (a domain node like
`shop.checkout` that, by **I2**, doesn't exist) fails `validate` (`ok:false`) and
`activate` (`422 not_activatable`), and stays a draft. **The catalog is the single
source of truth** — an external builder can never activate a flow the engine
can't execute.

---

## Why it matters

This is the headline Phase-C promise made real: the work of building a Telegram
bot is **already done** as composable nodes, and now an *external* system can
**connect them** — from a script, from n8n, or from an AI agent over MCP — with
the same guarantees the editor has. Every secret (the bot token) stays host-side
(**I7**); a bot-scoped token can only touch its own bot; and because authoring
reuses the panel's exact schemas + validator (**I5**), nothing the agent builds
can behave differently from what a human would draw. The MCP mirror (PC-T3) lets
an LLM walk this identical lifecycle — `list_nodes` → `validate_flow` →
`create_flow` → activate → `trigger_flow` — self-correcting on `validate` before
it ever commits a flow.
