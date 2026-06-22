# 🚀 Quick start — your first CTB bot reply in under 5 minutes

This is the **5-minute walkthrough** PLAN3 F-T2 promises: from an empty CTB
instance to *seeing your bot actually reply*, without writing a line of code and
without learning the whole node catalog first.

It pairs with the **guided empty state** (F-T1): when a bot has no flows, the
editor shows three buttons — **⚡ Start from template**, **📥 Import a flow**,
**➕ Blank canvas**. This guide takes the first one, which lands on the
**`hello` template** — the smallest useful flow there is.

> The happy path below is exercised automatically, against the **real** wired
> engine + in-memory SQLite + a fake Telegram transport, by
> `apps/server/test/e2e-phaseF-quickstart-demo.test.ts`. Run it with:
>
> ```bash
> npm run test --workspace=@ctb/server -- e2e-phaseF-quickstart-demo
> ```

---

## What you'll build

The `hello` template is two nodes:

```
flow.manualTrigger  ──main──▶  tg.sendMessage
   (Test-run entry)              ("👋 Hello! Your CTB bot is alive and replying.")
```

- **`flow.manualTrigger`** is the entry point the editor's **Test run** button
  starts from. It carries a tiny `sample` JSON — `{ "chat": 123456789 }` — which
  becomes the first item's `$json`, so the run has a chat to send to even though
  you haven't connected Telegram to a live conversation yet.
- **`tg.sendMessage`** sends the greeting to `{{ $json.chat }}` — i.e. the chat
  id the trigger seeded.

That's it. It's deliberately the *minimum* that proves the whole loop works.

---

## Step by step

### 0. One-time setup (operator)

1. Register a bot: **Bots → New bot**, paste your BotFather token, save.
2. Open the bot and **Start** it.

### 1. Start from the template (≈ 30 seconds)

1. Open your bot's **Flows**. With zero flows you'll see the guided empty state.
2. Click **⚡ Start from template** → pick **“Hello bot (quick start)”**.
3. A new **draft** flow appears, named *Hello bot*. Open it in the editor.

> Under the hood this is `POST /api/flows/import-template { templateId: 'hello' }`
> — the exact same import path as **📥 Import a flow**, so "use a template" and
> "import a file" share one code path.

### 2. Point it at your chat (≈ 1 minute)

The template ships with a placeholder chat id so a one-click run never dead-ends.
To send the greeting to **yourself**:

1. Find your numeric chat id (e.g. message [@userinfobot](https://t.me/userinfobot)).
2. In the editor, click the **Manual Trigger** node and edit its **sample** to:
   ```json
   { "chat": YOUR_CHAT_ID }
   ```
3. Save (the editor autosaves; the toolbar shows *Saved*).

> Prefer a real bot trigger? Swap `flow.manualTrigger` for a **Telegram Trigger**
> (`tg.trigger`) — then the chat comes from the incoming message and you can drop
> the `chat` field on Send Message entirely (it defaults to the current chat).

### 3. See it reply (≈ 30 seconds)

1. Click **Test run** in the editor toolbar.
2. The run starts at the Manual Trigger, the greeting flows to **Send Message**,
   and your bot delivers:

   > 👋 Hello! Your CTB bot is alive and replying.

3. (Optional) Click **Activate** to flip the draft to **active** so the flow is
   part of the bot's live set.

You now have a working CTB bot. 🎉

---

## What just happened (the loop you'll reuse forever)

```
import a flow design  →  edit nodes on the canvas  →  Test run  →  Activate
        (template)            (point it at a chat)     (see it reply)   (go live)
```

Every more-advanced flow is the same loop with more nodes between the trigger
and the reply: ask a question and **Wait for Reply**, branch with **IF**, call an
API with **HTTP Request**, run JavaScript in a **Code** node, talk to an LLM with
**AI Agent**. Browse them all in the **Node Library** (`/docs`).

## Where to go next

- **Templates gallery** — `feedback`, `quiz`, `faq`, `reminder` are all one
  import away and show real multi-node patterns to learn from.
- **Export** — the editor toolbar's **Export** button (PLAN3 F-T3) downloads any
  flow as a portable `.json` you can re-import or share.
- **Node Library** (`/docs`) — every node's params, ports and behaviour,
  generated from the live catalog.
