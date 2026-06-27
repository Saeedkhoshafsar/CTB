# 🎬 Phase-J demo — "Test run": listen for one live update (n8n's "listen for test event")

This is the documented end-to-end run that proves **Phase J live-trigger test
runs** (J-T1 → J-T3): an operator is authoring a flow whose entry is a real
`tg.trigger`, hits **Test run**, sends ONE real message to the bot from their
own Telegram, and watches the **real sender data flow into the canvas** — the
exact same node that will later power the live bot.

It is CTB's parity with n8n's **"listen for test event"**: you do not invent a
fake payload, and you do not swap your trigger for a Manual one. The node you
test is the node you ship.

> The whole script below is exercised automatically, against a fake Telegram
> transport and an in-memory SQLite DB, over the **same** panel HTTP routes the
> editor's "Test run" button uses, by
> `apps/server/test/e2e-phaseJ-test-listen-demo.test.ts`. Run it with:
>
> ```bash
> npm run test --workspace=@ctb/server -- e2e-phaseJ-test-listen-demo
> ```

---

## The contract this demo proves

**One `tg.trigger` node, two run modes — the node TYPE never changes.**

| | Production (build) run | Test (trial) run |
|---|---|---|
| How it starts | a live update matches the host router (`triggerMatches`) | the operator arms a listen (`POST /api/flows/:id/test-listen`); the **next matching** live update resumes it **exactly-once** |
| What runs | the SAME `tg.trigger` → downstream nodes | the SAME `tg.trigger` → downstream nodes |
| Item on `main` | the real Telegram item (sender id/name/text) | the **same** real Telegram item — not a synthetic stand-in |
| Durability | n/a | the armed run is a durable `WaitSpec{kind:'trigger'}` (`state.listening=true`) that survives a process restart (I4) |

The trial only changes **how** the run is started — never **what** runs. No
Manual trigger, no injected payload, no re-wired edges. That is the whole point:
what you trial is what you build.

---

## The demo flow

The smallest flow whose entry is a real `tg.trigger`:

```
tg.trigger(any_message)  →  data.setFields  →  tg.sendMessage
   (the entry)              (records who          (greets the
                             said what)            sender — live runs only)
```

- **`data.setFields`** is *chatless-safe*: it runs in BOTH modes and records the
  captured sender into the item, so the trial can prove "the sender data reached
  node 2" via the executions API (no Telegram side-effect needed).
- **`tg.sendMessage`** needs a chat, so it only actually sends on a production
  run (which is bound to the sender's chat). That is the real, honest difference
  between the modes — not a different trigger.

---

## The run, step by step

### 1. Operator brings the bot online

`POST /api/bots` (create) then `POST /api/bots/:id/start` registers the bot with
the gateway (its rate-limited sender). Until a bot is *started* it has no sender,
so any `tg.sendMessage` would fail with *"no sender injected"* — exactly as a
real un-started bot cannot reply.

### 2. Operator authors the flow and activates it

`POST /api/flows` with the graph above, then `POST /api/flows/:id/activate`.

### 3. Operator clicks **Test run**

The editor arms the flow's `tg.trigger` for ONE capture:

```http
POST /api/flows/:id/test-listen   →   201
{ "executionId": "…", "nodeId": "trig" }
```

A **durable** execution is parked: `status:waiting`, `WaitSpec{kind:'trigger'}`,
`state.listening=true`. Polling reports it:

```http
GET /api/flows/:id/test-listen/status?executionId=…   →   { "state": "listening" }
```

### 4. Operator sends ONE real message to the bot

The next matching live update is dispatched through the gateway. The router
**resumes the armed listen first** (before `tryTriggers`), exactly-once. The
`tg.trigger` emits the **real** item — `{ user: { id: 555, firstName: 'سارا' },
text: 'قهرمان', … }` — and `data.setFields` runs on it.

Polling now flips:

```http
GET …/test-listen/status?executionId=…   →   { "state": "captured" }
```

And the executions API shows node 2 ran with the real captured data:

```jsonc
// GET /api/executions/:id  → logs[ nodeId='seen' ].output.main[0].json
{ "sawUserId": 555, "sawName": "سارا", "sawText": "قهرمان" }
```

The captured sender data reached node 2 — end to end, through the same node the
live bot will use.

### 5. A non-matching update does NOT consume the arming

If the trigger listens for `command:/start` and a plain text message arrives,
the arming is **untouched** (`state` stays `listening`). Only the matching
`/start` captures it. An un-answered arming auto-expires (`timeoutAt` →
`expired`). Cancel anytime with `DELETE /api/flows/:id/test-listen`.

### 6. The SAME node powers the live bot (production)

With no arming, a plain inbound message routes through `triggerMatches`, fires
the SAME `tg.trigger`, runs `data.setFields`, and `tg.sendMessage` replies to the
sender's chat:

```
سلام رضا! گفتی: بدون_تست      (delivered to chat_id 7 — the sender)
```

Same node. Same flow. Only the start path differed.

---

## Why this mirrors n8n (and where it doesn't)

n8n's **"listen for test event"** lets you arm a trigger node and capture the
next real event so you can build the rest of the workflow against real data —
instead of guessing a payload. CTB adopts that **exact** authoring model for
`tg.trigger` (see `docs/VISION.md` → *n8n as the architecture reference*, and
Decision Log #25).

Where CTB goes further: the armed listen is a **durable** waiting execution, so
it survives a server restart (invariant I4) — the n8n model, made
conversation-aware and crash-safe. The capture is also a proper TEST run, so
pinned data (I-T1) is honoured downstream.
