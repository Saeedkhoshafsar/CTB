# CTB External Integration Protocol (stub)

> Completed in Phase 4. This stub freezes the shapes early so nothing else builds against guesses.

## Inbound: Webhook Trigger

```
POST /hooks/flow/:flowId/:secret
Content-Type: application/json

{ ...arbitrary payload... }   → becomes $json in the flow
```

- **Async mode (default):** responds `202 {"ok":true,"executionId":"..."}` immediately.
- **Sync mode:** holds the request until a `Respond to Webhook` node runs (or timeout → `504`).
- Optional `X-CTB-Signature: hmac-sha256(body, secret2)` verification.

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
