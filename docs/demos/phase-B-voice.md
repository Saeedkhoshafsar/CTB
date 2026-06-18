# 🎬 Phase-B demo — the AI voice loop (the screenshot, rebuilt in CTB)

This is the documented end-to-end run that proves **Phase B** of PLAN2: the
n8n-parity **AI tier**. It rebuilds the user's reference screenshot — a Telegram
**voice note** answered by an AI that **hears, reasons with tools + memory, and
replies in a synthesized voice note** — using **nothing but shipped Phase-B
nodes**, wired together by the typed sub-connection contract.

It exercises every Phase-B pillar at once:

- **PB-T7** speech nodes — `ai.speechToText` (hear) + `ai.textToSpeech` (speak)
- **PB-T5** `ai.agent` orchestrator consuming its **typed slots**
- **PB-T5** `ai.modelOpenai` — the `ai:model` provider
- **PB-T4** `ai.memoryPostgres` — the `ai:memory` provider (rolling chat memory)
- **PB-T6** `tool.think` + `tool.httpRequest` — the `ai:tool` providers
- **PB-T1** the typed sub-connection contract that attaches all four providers
- **PA-T1** `tg.sendMedia` (`source:'file'`) to send the synthesized audio back

> The whole script below is exercised automatically, against fake (scripted)
> LLM / transcribe / TTS / Telegram / Postgres transports and the **real**
> `Executor` + `MemoryExecutionStore` + slot resolver + agent tool loop, by
> `apps/server/test/e2e-phaseB-voice-demo.test.ts`. The flow graph lives in
> `packages/shared/test/fixtures/phase-b-voice-flow.json`. Run it with:
>
> ```bash
> npm run test --workspace=@ctb/server -- e2e-phaseB-voice-demo
> ```

---

## The flow

A 9-node flow, owned by a bot and **activated**, triggered when the user sends a
**voice note**:

| # | Node | Type | What it does |
|---|------|------|--------------|
| 1 | trigger | `tg.trigger` | fires on an incoming message (the voice note); the raw update carries `message.voice.file_id` |
| 2 | transcribe | `ai.speechToText` | **hear** — the host downloads the voice file via `ctx.tg.getFile`, then transcribes it via `ctx.ai.transcribe`; the text lands at `$json.transcript.text` |
| 3 | model | `ai.modelOpenai` | **provider** for the agent's `ai:model` slot — *which* model + credential to call |
| 4 | memory | `ai.memoryPostgres` | **provider** for the `ai:memory` slot — a rolling Postgres-backed conversation memory, keyed by chat id |
| 5 | think | `tool.think` | **provider** for an `ai:tool` slot — a reasoning scratchpad |
| 6 | lookup | `tool.httpRequest` | **provider** for an `ai:tool` slot — an `order_status` tool the model can call |
| 7 | agent | `ai.agent` | **consumes** all four providers via its typed slots; turns the transcribed question into a reply at `$json.ai.reply` |
| 8 | speak | `ai.textToSpeech` | **speak** — synthesizes the reply via `ctx.ai.speech`, stores the bytes via `ctx.files.write`, surfaces a CTB file id at `$json.speech.fileId` (`opus`, ideal for a Telegram voice note) |
| 9 | send | `tg.sendMedia` | sends the synthesized audio back (`source:'file'` → the host reads the stored bytes and uploads them), closing the voice loop |

### Edges

Data edges (solid):
`trigger → transcribe → agent → speak → send`

Sub-connection edges (dashed — provider → consumer slot):

| from | → | to slot |
|------|---|---------|
| `model` | → | `agent.ai:model` |
| `memory` | → | `agent.ai:memory` |
| `think` | → | `agent.ai:tool` |
| `lookup` | → | `agent.ai:tool` (repeatable) |

This is the exact n8n "AI" canvas shape: a consumer node with chat-model, memory,
and tool sub-nodes hanging off its typed input slots.

---

## What the run proves

### 1. Hear (STT)
The voice `file_id` (`voice_abc`) reaches `ctx.tg.getFile`; the downloaded bytes
+ the derived filename (`voice_abc.oga`, the basename of the Telegram
`file_path`) reach `ctx.ai.transcribe`. The transcript becomes the agent's user
prompt — no separate `tg.getFile` node is needed, the STT node owns the
download.

### 2. Reason (agent + slots + tools)
- The `ai:model` **provider** supplies the model id (`openai/gpt-4o-mini`) and
  temperature (`0.3`) — *not* the agent's inline params.
- Both tools (`think` + `order_status`) are advertised to the model.
- The scripted model calls `order_status` with `{"orderId":"A-17"}`; the host
  runs the real `ctx.http.request` (the arg merged into the query string:
  `…/orders?orderId=A-17`) and feeds the result back; the model then answers.

### 3. Remember (Postgres memory)
- After the answer, the user+assistant turn is **persisted** (an `INSERT` of two
  rows into `ctb_chat_memory`, the table `CREATE`d on demand).
- A **second** voice call in the same chat **replays** the first exchange into
  the model prompt *before* the new question — so the agent "remembers" the
  caller across calls. (The demo's second test asserts the replayed
  `user`/`assistant` pair precedes the new user turn in the messages.)

### 4. Speak (TTS) + send
- The agent's reply is synthesized to audio (`format: 'opus'`), stored, and the
  stored **bytes** are uploaded by `tg.sendMedia` (`source:'file'`, `kind:'audio'`)
  with the caption `🔊 پاسخ صوتی`.

---

## Why it matters

Every external boundary stays host-side: the OpenAI key, the Postgres
credential, and the bot token are all resolved by the host (invariants I6/I7);
the nodes only ever pass a `credentialId` or a `file_id`. The driver/transport
weight (HTTP, SQL, audio I/O) lives in `apps/server` (I3). The **product
surface** is just generic, composable nodes — proving the Phase-B AI tier
delivers the full n8n "AI agent" pattern for the conversational domain.

This same node set is what **Phase E** (live voice AI) will reuse for *real-time*
calls — there, the only additions are the call **transport** + a few trigger /
action nodes; the hear → reason → speak core is already done here.
