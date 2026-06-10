# CTB — Composable Telegram Bots

**A visual, node-based automation platform for building any Telegram bot — no code required, full code when you want it.**

Think *n8n, but conversation-aware and built for Telegram*. You design bot logic on a visual canvas by connecting nodes. Simple things need zero code; complex things drop into a real JavaScript Code node. Nothing is hardcoded for a specific business — CTB is a general-purpose tool: anyone can build any kind of bot.

---

## Why CTB exists

Classic Telegram bot codebases bury business logic inside giant PHP/Python monoliths. Adding one button means editing five files. Tools like n8n are great at workflows but are **stateless** — a Telegram bot must hold a *conversation*: ask a question, wait minutes or hours for the user's reply, then continue.

CTB's engine is built around that exact gap:

> **Pausable, resumable flow executions.** A flow can stop at a "Wait for Reply" node, persist its full state, and resume from that exact node when the user answers — even days later.

## Core concepts

| Concept | Description |
|---|---|
| **Bot** | A Telegram bot token registered in CTB. One CTB instance hosts many bots. |
| **Flow** | A graph of nodes designed on the visual canvas. Flows attach to a bot. |
| **Node** | A unit of work: send a message, wait for input, branch, run code, call an API… |
| **Trigger** | What starts a flow: a Telegram message/command/button, a schedule, an incoming webhook, an event. |
| **Item** | The data envelope flowing between nodes (`json` payload + execution context) — same mental model as n8n. |
| **Expression** | `{{ ... }}` templates usable in any node field: `Hi {{ $json.user.first_name }}!` |
| **Execution** | One run of a flow for one chat. Can be running, **waiting** (paused for user input), done, or failed. |
| **Credential** | Encrypted, reusable connection (API keys, headers) referenced by nodes — never pasted twice. |

## Built-in node catalog (target)

```
TRIGGERS          Telegram Trigger (message / command / button / join)
                  Schedule (cron) · Webhook (HTTP in) · Manual

TELEGRAM          Send Message (text/photo/file/keyboards) · Edit / Delete Message
                  Wait for Reply (text/photo/contact/…, with validation)
                  Menu (inline buttons → branches) · Answer Callback

FLOW CONTROL      IF · Switch · Loop · Merge · Wait/Delay · Execute Sub-Flow · Stop & Error

DATA & CODE       Set Fields · Code (JavaScript, sandboxed) · HTTP Request
                  Storage (per-user / per-bot key-value)

AI                LLM Chat (OpenAI / Anthropic / OpenRouter / custom base URL)
                  AI Agent (tools) · MCP Client
```

## Architecture at a glance

```
apps/
  server/        Fastify API + Telegram gateway (grammY) + scheduler + webhook endpoints
  editor/        React + React Flow visual editor (canvas, node config panels)
packages/
  core/          Flow engine: node registry, item pipeline, expression engine,
                 pause/resume executor, execution store
  nodes/         All built-in node implementations
  sandbox/       Isolated runtime for the Code node (worker_threads, timeouts)
  shared/        Types & schemas shared between server and editor
```

- **Language:** TypeScript end-to-end
- **DB:** SQLite by default (zero-config), Postgres optional — via Drizzle ORM
- **Telegram:** grammY (webhook or long-polling)
- **Editor canvas:** React Flow (@xyflow/react)

Full details: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) · Node specs: [`docs/NODES.md`](docs/NODES.md)

## For developers & AI agents

This repo is built to be **resumable by any agent with zero memory**:

| File | Purpose |
|---|---|
| [`CLAUDE.md`](CLAUDE.md) | **The constitution** — mandatory protocol, invariants, git workflow. Read first. |
| [`docs/STATE.md`](docs/STATE.md) | Current truth: which task is `→ current`, repo health checks, session log. |
| [`docs/PLAN.md`](docs/PLAN.md) | The executable plan: atomic tasks P0-T1 → P6, each with files, acceptance criteria, verify commands. |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | How to build: structure, contracts, engine design, data model. |
| [`docs/ROADMAP.md`](docs/ROADMAP.md) | Phase overview + decision log. |

Session protocol: **STATE.md → PLAN.md (current task) → ARCHITECTURE.md (relevant §) → verify → code.**

## Project principles

1. **Generic by design.** No business-specific nodes (no "shop", no "VPN panel"). Domain logic belongs in flows, Code nodes, and HTTP nodes — or future community plugins.
2. **Conversation-first engine.** Pause/resume is a first-class engine capability, not a bolt-on.
3. **No-code floor, full-code ceiling.** Everything common is a configurable node; everything else is one Code node away.
4. **Open protocol.** Flows can be triggered from outside (webhook/API) and can call anything outside (HTTP/MCP) — CTB plays well with n8n, AI agents, and cron systems.
5. **Boring, reliable persistence.** Every execution, every wait state, every credential — durable in the DB.

## Reference

The previous-generation project ([mirzabot](https://github.com/Saeedkhoshafsar/mirzabot)) is kept as a *reference only* for Telegram UX patterns and lessons learned. No code is migrated from it.

## Status

🚧 Pre-alpha — architecture & roadmap phase. See [`docs/ROADMAP.md`](docs/ROADMAP.md).

---

<div dir="rtl">

## خلاصه فارسی

**CTB** یک پلتفرم اتوماسیون بصری و node-based برای ساخت هر نوع بات تلگرامی است — مثل n8n اما «گفتگو-محور» و مخصوص تلگرام.

- منطق بات را روی بوم بصری با اتصال نودها طراحی می‌کنید؛ کارهای ساده بدون کد، کارهای پیچیده با نود Code (جاوااسکریپت واقعی و sandbox شده)
- تفاوت کلیدی با n8n: موتور اجرا **قابل توقف و ادامه** است — فلو می‌تواند منتظر جواب کاربر بماند (حتی روزها) و از همان نقطه ادامه دهد
- هیچ نود اختصاصی برای کسب‌وکار خاص (فروشگاه/VPN) وجود ندارد؛ ابزار کاملاً عمومی است
- اتصال به دنیای بیرون: HTTP Request، Webhook Trigger، نودهای AI و MCP — تعامل کامل با n8n و ایجنت‌های هوش مصنوعی

</div>
