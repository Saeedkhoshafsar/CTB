# CTB Vision Skill — The Compass

> **Purpose:** این فایل تصویر نهایی CTB را برای هر AI agent مشخص می‌کند.
> قبل از هر تصمیم معماری، هر node جدید، هر feature، از این فایل بپرسید:
> **«آیا این با تصویر نهایی همخوانی دارد؟»**
>
> **جایگاه در سلسله‌مراتب مستندات (CLAUDE.md §2):** این فایل **چرایی** را می‌گوید (the *why*) —
> نه «چه کاری» (`docs/PLAN*.md`) و نه «چگونه» (`docs/ARCHITECTURE.md` / `docs/NODES.md`).
> هنگام تعارض، فایل‌های source-of-truth (STATE2 → PLAN → ARCHITECTURE → NODES → PROTOCOL) برنده‌اند؛
> این Compass فقط جهت کلی را نگه می‌دارد. اگر این فایل با آن‌ها در تضاد افتاد، آن‌ها را درست بدان و این را اصلاح کن.
>
> **کاتالوگ نودها (verified):** نام‌های node در این فایل با registry واقعی (۶۱ نود در `packages/nodes/src`)
> در تاریخ 2026-06-27 تطبیق داده شده‌اند. منبع نهایی نام نودها همیشه کد و `docs/NODES.md` است.

---

## CTB چیست؟ (یک جمله)

**CTB یک N8N کامل برای تلگرام است — همه نودهای هسته‌ای و پروتکل‌های N8N شبیه‌سازی شده، به علاوه قابلیت‌های بومی تلگرام که در N8N اصلاً ممکن نیست.**

---

## رابطه با N8N — نه جایگزین، بلکه فراتر

### چه چیزی از N8N داریم (parity کامل):
- Item pipeline — همان مدل ذهنی N8N
- Expression engine با همان `{{ }}` syntax
- Code node با JavaScript واقعی در sandbox
- Credentials store رمزنگاری‌شده
- Sub-flows، Loop، Merge، IF، Switch، Filter، Sort، Limit، Aggregate، Split Out
- Edit Fields (Set) — همان n8n "Edit Fields" با op:rename و value_mode:json
- Remove Duplicates، Date & Time (با تقویم جلالی — اولویت ایرانی)
- HTTP Request، Webhook Trigger (async + sync)، Schedule (cron + fan-out)
- Manual Trigger برای تست
- AI Agent با sub-node slots (Chat Model / Memory / Tool) — دقیقاً مثل N8N AI canvas
- Database connectors: Postgres و MySQL با connection hardening

### چه چیزی نداریم (فعلاً):
- نودهای API محور اختصاصی (Slack، Gmail، GitHub، ...)
- **ولی:** هر کدام با Code node + HTTP Request + Credentials کاملاً قابل پیاده‌سازی است
- در آینده: node plugin system برای community nodes

### چه چیزی داریم که N8N ندارد 🚀:

#### ۱. Conversation-aware Engine (بزرگ‌ترین تمایز)
```
N8N:  trigger → process → done          (stateless — هر بار از صفر)
CTB:  trigger → send question
             → [PAUSE روزها]
             → user answers → validate → retry اگر اشتباه
             → continue                 (state کامل در DB زنده می‌ماند)
```
- **Wait for Reply** با validation، retry، timeout، save_to
- **Menu node** — دکمه‌های inline؛ هر دکمه یک output port مجزا
- **Pause/Resume دائمی** — state در DB؛ زنده حتی بعد از server restart
- **Per-chat mutex** — یک execution فعال به ازای هر chat

#### ۲. Live Voice Calls — قابلیتی که N8N اصلاً ندارد 🎤
CTB می‌تواند به **live call های تلگرام** (group/channel voice chat یا 1:1 call) متصل شود:
```
تریگر: callEvent (utteranceFinal)
  → ai.speechToText        (صدا → متن)
  → ai.agent               (پردازش هوشمند)
  → ai.textToSpeech        (متن → صدا)
  → call.speak             (پخش صدا در call)
```
دو سناریوی اصلی با همان node‌ها فقط با تغییر setting:
- **AI Support (1:1):** هر کسی صحبت می‌کند — AI real-time جواب می‌دهد
- **Channel Q&A Lineup (group/channel):** صف انتظار مدیریت شده با `grantTurn`/`endTurn`/`mute`

#### ۳. کنترل کامل تلگرام
- **Send Media با album** — 2 تا 10 آیتم در یک media group
- **Get a File** — دانلود فایل تلگرام و ذخیره در file-store
- **tg.editMessage، tg.deleteMessage** — ویرایش/حذف پیام
- **tg.answerCallback، tg.sendChatAction** — typing indicator و toast
- **deep-link payload** — `/start?payload=...` را extract می‌کند

#### ۴. CTB به عنوان MCP Server (PC-T3)
AI agent های خارجی (مثل Claude) می‌توانند node library CTB را کشف کنند و workflow طراحی کنند — CTB هم consumer MCP (tool.mcp) است و هم MCP server.

#### ۵. Test Run با Live Trigger واقعی (J-T1)
- همان `tg.trigger` هم در production هم در test کار می‌کند
- "listen for one live update" — یک update واقعی capture می‌شود
- دیگر نیازی به Manual Trigger جداگانه برای تست نیست

---

## تصویر تجربه کاربر نهایی

**کاربر ۱: Bot Builder (بدون کد)**
- روی canvas نودها را drag می‌کند
- فرم چندمرحله‌ای، منوی انتخابی، و پاسخ‌های شرطی می‌سازد — بدون کد

**کاربر ۲: Developer (با کد)**
- Code node، HTTP Request، Database connectors، AI Agent با tool slots
- Webhook برای integration دوطرفه با n8n یا هر سیستم دیگر

**کاربر ۳: Operator (مدیر داده)**
- فقط Data section می‌بیند — هرگز canvas نمی‌بیند
- Collections را مدیریت می‌کند؛ admin panel از schema auto-generate شده

**کاربر ۴: AI Agent (Claude / GPT / ...)**
- CTB را به عنوان MCP server می‌شناسد
- node library را کشف می‌کند و workflow طراحی می‌کند

---

## اصول غیرقابل نقض (Red Lines)

### ✅ CTB همیشه هست:
- **Generic** — هیچ node اختصاصی برای یک کسب‌وکار خاص در core (I2)
- **Conversation-first** — pause/resume قابلیت اول‌درجه موتور
- **No-code floor, full-code ceiling** — ساده با node، پیچیده با Code node
- **Open protocol** — webhook in/out، HTTP، MCP، n8n-compatible
- **Durable** — هر execution state در DB، نه در memory (I4)
- **TypeScript-only** — هیچ زبان دوم backend (I1)
- **Jalali-first** — تقویم فارسی اولویت اول برای کاربران ایرانی

### ❌ CTB هرگز نیست:
- **Domain-specific** — هیچ node ای مثل `ShopOrderNode` یا `VPNPanelNode` در core
- **محدود به چت** — CTB یک automation engine کامل است؛ آنچه N8N می‌سازد، CTB هم می‌سازد، به علاوه voice و conversation
- **In-memory session-based** — هیچ conversation state فقط در memory
- **UI-as-nodes** — admin panel از nodes ساخته نمی‌شود؛ Collections از schema تولید می‌شود
- **وابسته به N8N** — پروتکل‌ها شبیه‌سازی شده‌اند، نه fork؛ کدبیس مستقل TypeScript

---

## معماری در یک نگاه

```
                    ┌──────────────────────────────────────┐
                    │             CTB Instance              │
                    │                                       │
  Telegram msg ───►│  Gateway (grammY)                     │
  Telegram call ──►│  Call Session Service (MTProto)       │
  Webhook ────────►│  Update Router                        │
  Schedule ───────►│    ↓              ↓                   │
                    │  Resume        New Run                │
                    │    └──────► EXECUTOR ◄────────────────│
                    │               ↓                       │
                    │   Node Registry (61+ nodes)           │
                    │               ↓                       │
                    │   executions table (SQLite/Postgres)  │
                    │               ↓                       │
                    │   PAUSE → wait → RESUME               │
                    └──────────────────────────────────────┘

  Editor (React + React Flow) ←──── REST API
  Collections Admin Panel    ←──── REST API
  External AI Agents         ←──── MCP Server (PC-T3)
```

**Dependency chain (هرگز نقض نشود):**
```
shared ← sandbox ← core ← nodes ← apps/server
```
`core` هرگز Telegram یا Fastify import نمی‌کند — فقط injected capabilities دریافت می‌کند.

---

## کاتالوگ کامل Node ها

```
TRIGGERS
  tg.trigger          Telegram message/command/button/photo/contact/join
                      + live-trigger test (J-T1): همان node در production و test
  schedule.trigger    cron + fan-out برای همه کاربران
  webhook.trigger     async و sync (با Respond to Webhook)
  collection.recordChanged  وقتی operator داده عوض می‌کند
  trigger.callEvent   [PE] live Telegram call — utterance/join/leave/turn
  flow.manualTrigger  تست در editor

TELEGRAM
  tg.sendMessage      text/photo/video/document/audio/sticker + keyboard
  tg.sendMedia        [+] bytes upload + album (2-10 items)
  tg.getFile          [+] دانلود فایل تلگرام → file-store
  tg.waitForReply     ★ the conversation primitive — pause/resume + validation
  tg.menu             ★ inline buttons؛ هر دکمه یک output port
  tg.editMessage      ویرایش پیام قبلی
  tg.deleteMessage    حذف پیام
  tg.answerCallback   toast/alert روی button click
  tg.chatAction       typing / upload_photo indicator

LIVE VOICE (PE) ★ منحصر به فرد در دنیا
  call.connect        اتصال به live call (voiceConnection credential)
  call.speak          پخش صدا — source: file (TTS output) یا pcm
  call.grantTurn      [lineup] باز کردن میکروفن برای نفر بعد/خاص
  call.endTurn        [lineup] بستن نوبت فعلی
  call.mute           mute/unmute یک شرکت‌کننده
  call.leave          خروج از call

FLOW CONTROL
  flow.if             condition با AND/OR
  flow.switch         N ports + default
  flow.loop           splitInBatches — n8n-style
  flow.merge          append / wait-both / choose-first
  flow.wait           delay دائمی (زنده بعد از restart)
  flow.executeSubFlow call به flow دیگر + return
  flow.stopError      پایان با خطا
  flow.respondToWebhook HTTP response برای sync webhook

DATA & TRANSFORM (N8N parity کامل)
  data.setFields      Set Fields — set/rename/remove روی $json و $vars
  data.editFields     [+] Edit Fields — op:rename، value_mode:json، enabled
  data.splitOut       [+] یک item با آرایه → N items
  data.aggregate      [+] N items → یک item با آرایه
  data.filter         [+] kept | discarded — reuses IF engine
  data.sort           [+] multi-key، numeric-aware، null-last
  data.limit          [+] first/last N items
  data.removeDuplicates [+] all_fields یا selected_fields
  data.dateTime       [+] format/add/diff + تقویم جلالی + ارقام فارسی ★
  data.code           JavaScript sandbox — run-once یا per-item
  http.request        method/headers/body/credential/retry
  data.kv             KV — scope: user/bot/flow
  data.collection     CRUD روی Collections (find/get/insert/update/delete/count)
  data.userProfile    tags، profile fields (generic)

DATABASE (PB)
  db.postgres         query/select/insert/update/delete + connection hardening
  db.mysql            mirror of postgres با MySQL dialect

AI
  ai.llmChat          OpenAI-compatible + conversation memory via KV
  ai.classify         LLM-powered switch — یک port به ازای هر category
  ai.extract          schema-constrained JSON extraction
  ai.agent            tool loop + budget caps + typed sub-node slots:
    ├─ ai.modelOpenai   [slot: ai:model] — provider sub-node
    ├─ ai.memoryKv      [slot: ai:memory] — rolling window در KV
    ├─ ai.memoryPostgres [slot: ai:memory] — rolling window در Postgres
    ├─ tool.httpRequest [slot: ai:tool] — API call توسط مدل
    ├─ tool.code        [slot: ai:tool] — JS sandbox توسط مدل
    ├─ tool.think       [slot: ai:tool] — scratchpad بدون side-effect
    ├─ tool.subflow     [slot: ai:tool] — flow دیگر به عنوان tool ★
    └─ tool.mcp         [slot: ai:tool] — همه tools یک MCP server
  ai.speechToText     [PB] صدا → متن — source: telegram file_id یا CTB file
  ai.textToSpeech     [PB] متن → صدا → file-store (برای call.speak)
  ai.mcpClient        list/call tools روی MCP server
```

**افسانه:** `★` = منحصر به فرد، `[+]` = N8N parity جدید، `[PE]` = Live Voice phase، `[PB]` = Phase B

---

## Collections — داده ساختاریافته بدون domain node

هر Collection یک "جدول" user-defined با:
- Field types: text، number، boolean، select، date، image، file، relation، group (variant-style)
- Auto-generated CRUD panel (operator — هرگز canvas نمی‌بیند)
- REST API (flows و external systems)
- `data.collection` node
- `collection.recordChanged` trigger

**قانون طلایی:**
> اگر manager باید در جدول ببیند → Collection
> اگر فقط conversation به آن نیاز دارد → KV Store

---

## voiceConnection Credential — پشتیبان Live Voice

هر voice node یک `voiceConnection` credential می‌گیرد. سه `kind`:
- **`userbot`** (فعال) — MTProto session یک user account
- **`companion`** (آینده) — helper account در کنار bot
- **`external`** (آینده) — bridge خارجی از طریق HTTP

یک flow یا node برای تغییر connector نیاز به تغییر ندارد — فقط credential عوض می‌شود.

---

## فازهای رسیده به تصویر نهایی

| فاز | هدف | وضعیت |
|-----|-----|--------|
| 0 | Foundation — monorepo، types، DB | ✅ Done |
| 1 | Engine core — pause/resume، gateway | ✅ Done |
| 2 | Visual editor MVP | ✅ Done |
| 3 | Flow power — sub-flows، credentials | ✅ Done |
| 3.5 | Collections — structured data + admin | ✅ Done |
| 4 | Open protocol — webhooks، schedule | ✅ Done |
| 5 | AI nodes — LLM، Agent، MCP | ✅ Done |
| PLAN3 | Editor polish — ergonomics، UX | 🔄 In Progress |
| PLAN4 | Go-live readiness — RBAC، live-trigger | 🔄 In Progress |
| PB | N8N parity کامل + DB + Speech + AI sub-nodes | 📋 Planned |
| PC | MCP Server + tool nodes | 📋 Planned |
| PD | DB hardening | 📋 Planned |
| PE | Live Voice Calls | 📋 Planned |
| 6 | Hardening & 1.0 | ⏳ Planned |

---

## چک‌لیست تصمیم‌گیری برای هر تغییر

- [ ] آیا این node/feature کاملاً generic است؟ (هیچ کسب‌وکار خاصی نیست)
- [ ] آیا هر conversation/call state به DB می‌رود؟ (نه memory-only)
- [ ] آیا dependency chain رعایت شده؟ (core بدون Telegram/Fastify/DB drivers)
- [ ] آیا Zod schema اول تعریف شده؟ (schema → form → validation → docs)
- [ ] اگر node جدید است، آیا اول در NODES.md spec شده؟
- [ ] آیا engine changes یک pause/resume round-trip test دارند؟
- [ ] آیا node جدید با I2 سازگار است؟ (generic primitive، نه domain-specific)
- [ ] برای voice nodes: آیا `ctx.call` nullable check دارد؟ (fail-loud)

---

*این فایل قطب‌نما است — نه نقشه راه (PLAN.md) و نه جزئیات فنی (ARCHITECTURE.md).*
*هر بار که "چرا داریم این کار را می‌کنیم؟" نامشخص شد، اینجا برگردید.*
