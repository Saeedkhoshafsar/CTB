# CTB External Integration Protocol (stub)

> Completed in Phase 4. This stub freezes the shapes early so nothing else builds against guesses.

## Inbound: Webhook Trigger ✅ P4-T1

```
POST /hooks/flow/:flowId/:secret
Content-Type: application/json

{ ...arbitrary payload... }   → becomes $json.body in the flow
```

The trigger item's `$json` is `{ body, headers, query, method }` (the parsed JSON
body, request headers with `authorization`/`cookie`/`x-ctb-signature` redacted,
the query object, and the HTTP method).

- **`:secret`** — an unguessable per-flow path secret derived from `CTB_SECRET`
  (`flowWebhookSecret(flowId)`, base64url HMAC; no DB column, stable across
  restarts). A mismatch — or an unknown flow id — returns `404` (no existence
  leak). `GET /api/flows/:id/webhook` returns the full URL + HMAC key for wiring.
- **Async mode (default):** responds `202 {"ok":true,"executionId":"..."}`
  immediately; the flow runs out-of-band.
- **Sync mode:** holds the request until a `Respond to Webhook` node runs (it
  parks `{status, headers, body}`, sent back as the HTTP response), or the
  trigger's `sync_timeout` (1–120s) elapses → `504`. No respond node ran →
  `200 {"ok":true,"executionId","status"}`.
- **Optional HMAC:** when the trigger's `verify_signature` is on, the request
  must carry `X-CTB-Signature: sha256=<hex>` = `HMAC-SHA256(rawBody, hmacKey)`
  where `hmacKey = flowWebhookHmacKey(flowId)` (a SEPARATE derivation from the
  path secret). Missing/invalid → `401`.

## Inbound: REST API (token auth) ✅ P4-T3

The "open protocol" surface for n8n / scripts / AI agents. Every request carries
a **bearer token** (NOT the panel cookie) — these routes live under `/api/v1/`,
which the app's cookie guard skips; the v1 router installs its own bearer-auth
preHandler.

```
Authorization: Bearer ctb_<…>

POST /api/v1/flows/:id/trigger        { chat_id?, payload? }
POST /api/v1/bots/:id/send            { chat_id, text, parse_mode?, keyboard? }
GET  /api/v1/executions?flow_id=&bot_id=&status=&limit=
GET  /api/v1/users?bot_id=&limit=&offset=
```

### Tokens

Created/listed/revoked from the panel (admin only) via `/api/api-tokens`:

```
GET    /api/api-tokens                 → { tokens: ApiTokenPublic[] }
POST   /api/api-tokens                 { name, botId? } → 201 { apiToken: ApiTokenCreated }
DELETE /api/api-tokens/:id             → 204 (404 if unknown)
```

- A token is a `ctb_`-prefixed string. Only its **SHA-256 hash** + a 10-char
  display prefix are stored (invariant I7) — the plaintext is returned **once**,
  in the `POST` response (`apiToken.token`), and never again.
- `botId` is optional. `null` ⇒ **instance-wide** token. A non-null `botId`
  (must reference an existing bot, else `400 unknown_bot`) ⇒ **bot-scoped**: the
  token may only act on that bot. Any v1 request targeting a different bot —
  flow's bot, `:id`, `bot_id` filter, or users' `bot_id` — returns
  `403 token_not_authorized_for_bot`, and `GET /executions` is silently filtered
  to the token's own bot.
- A successful auth stamps `last_used_at` (best-effort). Missing/garbage header →
  `401 missing_bearer_token`; unknown hash → `401 invalid_token`.

### Endpoints

- **`POST /api/v1/flows/:id/trigger`** — starts a flow run (async, like the
  webhook async mode). `404 flow_not_found`; `422 invalid_graph` / `422
  no_trigger_node` if the flow has no enabled trigger node. The trigger item is
  `$json = { source:"api", payload?, chat_id? }`; entry is the flow's first
  enabled `category:"trigger"` node. `chat_id` is optional (numeric string is
  coerced to a number; omitted ⇒ chatless run). Responds
  `202 { ok:true, executionId }`; poll `GET /api/v1/executions` for the outcome.
- **`POST /api/v1/bots/:id/send`** — sends a Telegram message through the bot's
  centralized rate-limited sender. `404 bot_not_found`; `409 bot_not_running`
  (the bot exists but isn't started, so there's no sender). `keyboard` uses the
  shared `KeyboardSchema` and is converted to a Telegram `reply_markup`.
  `200 { ok:true, messageId }`, or `502 send_failed` on a Telegram error.
- **`GET /api/v1/executions`** — newest-first list. Optional `flow_id`, `bot_id`,
  `status` (`running|waiting|done|error|canceled`, else `400 invalid_status`),
  `limit` (1–200, default 50). Returns
  `{ executions: [{ id, flowId, botId, chatId, status, error, startedAt, updatedAt }] }`.
- **`GET /api/v1/users`** — `bot_id` required (`400 bot_id_required`). Optional
  `limit`/`offset`. Returns
  `{ users: [{ id, botId, tgUserId, profile, tags, firstSeen, lastSeen, displayName }] }`.

## Outbound: instance webhooks

Configurable per instance/bot; CTB POSTs:

```json
{
  "event": "execution.finished | execution.failed | user.first_seen",
  "bot_id": "...", "flow_id": "...", "execution_id": "...",
  "chat_id": 123, "data": { }
}
```

## n8n recipes (to be documented with screenshots in Phase 4)

1. **n8n → CTB:** n8n HTTP Request node → CTB Webhook Trigger (sync) → CTB converses with user → `Respond to Webhook` returns the user's answer to n8n.
2. **CTB → n8n:** CTB HTTP Request node → n8n Webhook → n8n replies JSON → flow continues with `$json`.
