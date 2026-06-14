# 🎬 Phase 4 demo — n8n asks a Telegram user, gets the answer back (sync webhook)

This is the documented end-to-end run that proves Phase 4 (the **open
protocol**): an external workflow — **n8n** — needs a human decision, so it
calls a CTB flow over a **synchronous webhook**, CTB **asks the user in
Telegram**, waits for their reply, and **returns that reply as the HTTP
response** to the still-open n8n request. One round trip, no polling.

It is recipe 1 from [`docs/PROTOCOL.md` § n8n recipes](../PROTOCOL.md#n8n-recipes)
made concrete, and it exercises every Phase-4 inbound piece: the per-flow
Webhook Trigger, its path secret, sync mode that survives a `tg.waitForReply`
pause, and `flow.respondToWebhook`.

> The whole script below is exercised automatically, against a fake Telegram
> transport and a real in-memory SQLite database, by
> `apps/server/test/e2e-phase4-n8n-demo.test.ts`. Run it with:
>
> ```bash
> npm run test --workspace=@ctb/server -- e2e-phase4-n8n-demo
> ```

---

## The flow

A four-node flow, owned by the office bot and **activated**:

| # | Node | What it does |
|---|---|---|
| 1 | **Webhook Trigger** | `mode: sync`, `sync_timeout: 30`, `target_chat: "$json.body.chat_id"` — binds the run to the chat n8n names in the body |
| 2 | `tg.sendMessage` | `Quick question: {{ $json.body.question }}` → DMs the user |
| 3 | `tg.waitForReply` | parks the run; the reply is saved to `$vars.answer` (`save_to: "answer"`) |
| 4 | `flow.respondToWebhook` | status `200`, JSON body `{ "answer": "{{ $vars.answer }}" }` |

Edges: `trigger → ask → wait —(reply)→ respond`.

Everything stays generic: the flow doesn't know it's serving n8n; n8n doesn't
know there's a human on the other end. The only contract is the webhook URL and
the JSON shapes.

---

## The run, step by step

### 1. n8n fires the webhook and waits

The operator copied the flow's trigger URL from the panel
(`GET /api/flows/<flowId>/webhook` → `$CTB/hooks/flow/<flowId>/<secret>`) into an
n8n **HTTP Request** node, with the request timeout set higher than the flow's
`sync_timeout`. n8n POSTs:

```http
POST $CTB/hooks/flow/ask-the-user/<secret>
Content-Type: application/json

{ "chat_id": 555, "question": "Approve invoice #42?" }
```

The HTTP Request node now **blocks** — n8n is paused, waiting for the answer.

### 2. CTB binds the run to the chat and asks the user

CTB authenticates the path secret, starts the run, and resolves
`target_chat = "$json.body.chat_id"` against the body → `chatId = 555`. The
run is no longer chatless, so `tg.sendMessage` DMs the user:

```
bot → (to chat 555) "Quick question: Approve invoice #42?"
```

Then `tg.waitForReply` parks the run. The only state is one row in the
`executions` table marked `waiting` — **no in-memory session, no held thread**
(invariant I4). The sync webhook request is still open, polling the durable
state for either a parked response or a terminal run.

### 3. The user answers → the run resumes → the response is parked

```
user → "Yes, approved."
```

The router matches the reply to the parked wait, saves it to `$vars.answer`,
and resumes the run from the `reply` port. `flow.respondToWebhook` runs and
parks:

```json
{ "status": 200, "bodyType": "json", "body": "{\"answer\":\"Yes, approved.\"}" }
```

### 4. n8n unblocks with the user's words

The still-open HTTP Request from step 1 returns:

```jsonc
// HTTP 200
{ "answer": "Yes, approved." }
```

In the next n8n node, the human's decision is `{{ $json.answer }}`. The whole
exchange was a single synchronous call — n8n never polled, and CTB never held a
thread waiting.

---

## What this demo proves

- **The open protocol round-trips.** An outside system drives a CTB flow and
  gets a *computed-by-conversation* result back synchronously — the headline
  Phase-4 capability.
- **Sync survives a human pause (I4).** The webhook request outlives a
  `tg.waitForReply` that parks the run to durable SQLite; nothing about the
  conversation lives in process memory, yet the HTTP response still resolves.
- **`target_chat` bridges the chatless boundary.** A webhook-started run is
  chatless by default; pointing `target_chat` at the request body is what lets
  the same flow talk to a specific user.
- **Generic to the core (I2).** The engine learns nothing about "invoices" or
  "approvals"; those words live only in the request body and node param strings.

## Timeouts & failure modes (worth remembering)

- If the user never replies within `sync_timeout`, the request returns **`504
  sync_timeout`**. The run stays parked and *will* still resume if the user
  answers later — but n8n has already given up, so handle the 504 on the n8n
  side.
- Always set n8n's HTTP Request **timeout higher than `sync_timeout`**, or n8n
  abandons the call before CTB can answer.
- A bad/missing path secret or unknown flow → **`404`** (no existence leak). A
  failed HMAC check (when `verify_signature` is on) → **`401`**.
- The companion direction — a CTB flow calling *out* to n8n mid-run — is recipe
  2 in [`docs/PROTOCOL.md`](../PROTOCOL.md#recipe-2--ctb--n8n-call-an-n8n-workflow-mid-flow-and-use-its-json).
