/**
 * P4-T1 contract tests — webhook.trigger + flow.respondToWebhook.
 *
 * The node layer is intentionally thin (the route does the HTTP work):
 *  • webhook.trigger is a pass-through (like tg.trigger / collection.recordChanged),
 *    and marks `target_chat` raw so the executor never tries to resolve it.
 *  • flow.respondToWebhook parks the response under the reserved $vars key and
 *    passes its input through (it is NOT terminal).
 * The async/sync/HMAC/secret HTTP behaviour is covered in the server test.
 */
import { describe, expect, it } from 'vitest';
import {
  WEBHOOK_RESPONSE_VAR,
  flowRespondToWebhook,
  webhookTrigger,
  type ParkedWebhookResponse,
} from '@ctb/nodes';
import { item, makeCtx, params } from './node-harness';

describe('webhook.trigger', () => {
  it('passes its input item through on main (happy)', async () => {
    const ctx = makeCtx({ chatId: null });
    const items = [item({ body: { hello: 'world' }, method: 'POST' })];
    const res = await webhookTrigger.execute(ctx, params(webhookTrigger, {}), items);
    if (res.kind !== 'items') throw new Error('expected items');
    expect(res.outputs.main).toEqual(items);
  });

  it('defaults to async mode, no signature, 30s sync timeout (edge)', () => {
    const p = params(webhookTrigger, {});
    expect(p.mode).toBe('async');
    expect(p.verify_signature).toBe(false);
    expect(p.sync_timeout).toBe(30);
  });

  it('marks target_chat as a raw (un-resolved) param key', () => {
    expect(webhookTrigger.rawParamKeys).toContain('target_chat');
  });

  it('clamps an out-of-range sync_timeout via schema (edge)', () => {
    expect(() => params(webhookTrigger, { sync_timeout: 0 })).toThrow();
    expect(() => params(webhookTrigger, { sync_timeout: 999 })).toThrow();
    expect(params(webhookTrigger, { sync_timeout: 5 }).sync_timeout).toBe(5);
  });
});

describe('flow.respondToWebhook', () => {
  it('parks a json response under the reserved $vars key and passes input through (happy)', async () => {
    const ctx = makeCtx({ chatId: null });
    const input = [item({ answer: 42 })];
    const p = params(flowRespondToWebhook, {
      status: 201,
      body_type: 'json',
      body: '{"ok":true}',
      headers: [{ name: 'X-Custom', value: 'yes' }],
    });
    const res = await flowRespondToWebhook.execute(ctx, p, input);
    if (res.kind !== 'items') throw new Error('expected items');
    // pass-through
    expect(res.outputs.main).toEqual(input);
    // parked response
    const parked = ctx.varsBag[WEBHOOK_RESPONSE_VAR] as ParkedWebhookResponse;
    expect(parked).toEqual({
      status: 201,
      bodyType: 'json',
      body: '{"ok":true}',
      headers: { 'X-Custom': 'yes' },
    });
  });

  it('defaults to 200 / json / empty body / no headers (edge)', async () => {
    const ctx = makeCtx({ chatId: null });
    const res = await flowRespondToWebhook.execute(ctx, params(flowRespondToWebhook, {}), [
      item({}),
    ]);
    if (res.kind !== 'items') throw new Error('expected items');
    const parked = ctx.varsBag[WEBHOOK_RESPONSE_VAR] as ParkedWebhookResponse;
    expect(parked.status).toBe(200);
    expect(parked.bodyType).toBe('json');
    expect(parked.body).toBe('');
    expect(parked.headers).toEqual({});
  });

  it('with no input items still passes through a single empty item (edge)', async () => {
    const ctx = makeCtx({ chatId: null });
    const res = await flowRespondToWebhook.execute(ctx, params(flowRespondToWebhook, {}), []);
    if (res.kind !== 'items') throw new Error('expected items');
    expect(res.outputs.main).toEqual([{ json: {} }]);
  });

  it('supports a text body (edge)', async () => {
    const ctx = makeCtx({ chatId: null });
    const p = params(flowRespondToWebhook, { body_type: 'text', body: 'pong' });
    await flowRespondToWebhook.execute(ctx, p, [item({})]);
    const parked = ctx.varsBag[WEBHOOK_RESPONSE_VAR] as ParkedWebhookResponse;
    expect(parked.bodyType).toBe('text');
    expect(parked.body).toBe('pong');
  });
});
