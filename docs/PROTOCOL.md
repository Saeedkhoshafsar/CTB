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

## Inbound: REST API (token auth)

```
Authorization: Bearer <api_token>

POST /api/v1/flows/:id/trigger        { chat_id?, payload? }
POST /api/v1/bots/:id/send            { chat_id, text|media, keyboard? }
GET  /api/v1/executions?flow_id=&status=
GET  /api/v1/users?bot_id=
```

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
