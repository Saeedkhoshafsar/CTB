/**
 * P2-T6 contract tests — tg.menu, flow.switch, flow.wait, http.request,
 * data.kv, flow.manualTrigger (≥3 each: happy / edge / error) + the shared
 * dynamic-port helper parity (node dynamicOutputs ⇄ shared dynamicOutputPorts).
 */
import { dynamicOutputPorts, WaitSpecSchema } from '@ctb/shared';
import { describe, expect, it } from 'vitest';
import {
  compareValues,
  dataKv,
  flowManualTrigger,
  flowSwitch,
  flowWait,
  httpRequest,
  tgMenu,
} from '@ctb/nodes';
import { item, makeCtx, params } from './node-harness';

const MENU_PARAMS = {
  text: 'انتخاب کنید:',
  buttons: [
    [{ text: 'خرید', key: 'buy', value: 'plan-a' }, { text: 'راهنما', key: 'help' }],
    [{ text: 'لغو', key: 'cancel' }],
  ],
};

describe('tg.menu', () => {
  it('sends inline keyboard and waits with keys + button meta (happy)', async () => {
    const ctx = makeCtx();
    const res = await tgMenu.execute(ctx, params(tgMenu, MENU_PARAMS), [item({})]);
    if (res.kind !== 'wait') throw new Error('expected wait');

    // message sent with one callback button per grid cell
    expect(ctx.sent).toHaveLength(1);
    const markup = ctx.sent[0]!.opts['reply_markup'] as { inline_keyboard: { text: string; callback_data: string }[][] };
    expect(markup.inline_keyboard[0]![0]).toEqual({ text: 'خرید', callback_data: 'btn:buy' });
    expect(markup.inline_keyboard[1]![0]).toEqual({ text: 'لغو', callback_data: 'btn:cancel' });

    // durable WaitSpec round-trips through the shared schema (pause/resume serialization)
    const spec = WaitSpecSchema.parse(JSON.parse(JSON.stringify(res.wait)));
    if (spec.kind !== 'callback') throw new Error('expected callback wait');
    expect(spec.keys).toEqual(['buy', 'help', 'cancel']);
    expect(spec.buttons).toEqual({
      buy: { label: 'خرید', value: 'plan-a' },
      help: { label: 'راهنما' },
      cancel: { label: 'لغو' },
    });
    expect(spec.messageId).toBe(100);
    expect(spec.timeoutAt).toBeNull();
  });

  it('timeout → timeoutAt; answer_callback_text → answerText; dynamic ports (edge)', async () => {
    const ctx = makeCtx();
    const p = params(tgMenu, { ...MENU_PARAMS, timeout: '15m', answer_callback_text: 'ثبت شد ✓' });
    const res = await tgMenu.execute(ctx, p, [item({})]);
    if (res.kind !== 'wait' || res.wait.kind !== 'callback') throw new Error('expected callback wait');
    expect(res.wait.timeoutAt).toBe('2026-06-11T10:15:00.000Z');
    expect(res.wait.answerText).toBe('ثبت شد ✓');

    // node dynamicOutputs ⇄ shared editor helper agree on the port list
    const ports = tgMenu.dynamicOutputs!(p);
    expect(ports).toEqual(['btn:buy', 'btn:help', 'btn:cancel', 'timeout']);
    expect(dynamicOutputPorts('tg.menu', p)).toEqual(ports);
  });

  it('edit_in_place edits the clicked menu message; falls back on failure (edge)', async () => {
    const ctx = makeCtx();
    const p = params(tgMenu, { ...MENU_PARAMS, edit_in_place: true });
    const clickedItem = item({ clicked: { key: 'buy', message_id: 42 } });
    const res = await tgMenu.execute(ctx, p, [clickedItem]);
    if (res.kind !== 'wait' || res.wait.kind !== 'callback') throw new Error('expected callback wait');
    expect(ctx.sent).toHaveLength(0); // edited, not re-sent
    expect(ctx.edited[0]).toMatchObject({ message_id: 42, text: 'انتخاب کنید:' });
    expect(res.wait.messageId).toBe(42);

    // edit failure → falls back to a fresh send, run continues
    const ctx2 = makeCtx();
    ctx2.tg!.editMessageText = async () => { throw new Error('message is not modified'); };
    const res2 = await tgMenu.execute(ctx2, p, [clickedItem]);
    if (res2.kind !== 'wait' || res2.wait.kind !== 'callback') throw new Error('expected callback wait');
    expect(ctx2.sent).toHaveLength(1);
    expect(res2.wait.messageId).toBe(100);
    expect(ctx2.logs.some((l) => l.level === 'warn')).toBe(true);

    // no prior menu message → plain send even with edit_in_place
    const ctx3 = makeCtx();
    const res3 = await tgMenu.execute(ctx3, p, [item({})]);
    if (res3.kind !== 'wait') throw new Error('expected wait');
    expect(ctx3.sent).toHaveLength(1);
  });

  it('no chat / no sender / bad params → loud failures (error)', async () => {
    const p = params(tgMenu, MENU_PARAMS);
    const noChat = await tgMenu.execute(makeCtx({ chatId: null }), p, []);
    expect(noChat).toMatchObject({ kind: 'error' });
    const noTg = await tgMenu.execute(makeCtx({ tg: null }), p, []);
    expect(noTg).toMatchObject({ kind: 'error' });

    expect(() => params(tgMenu, { text: 'x', buttons: [] })).toThrow(/invalid params/);
    expect(() => params(tgMenu, { text: 'x', buttons: [[{ text: 'a', key: 'bad key!' }]] })).toThrow(/invalid params/);
  });
});

describe('flow.switch', () => {
  const RULES = {
    value: 'vip',
    rules: [
      { port: 'vip', match: 'vip' },
      { port: 'numbers', match: 10, operator: 'gt' },
    ],
  };

  it('routes to the first matching rule port (happy)', async () => {
    const res = await flowSwitch.execute(makeCtx(), params(flowSwitch, RULES), [item({ a: 1 })]);
    if (res.kind !== 'items') throw new Error('expected items');
    expect(res.outputs.vip).toHaveLength(1);
    expect(res.outputs.default).toHaveLength(0);
  });

  it('no match → default; numeric operator parity with flow.if; dynamic ports (edge)', async () => {
    const p = params(flowSwitch, { ...RULES, value: '42' });
    const res = await flowSwitch.execute(makeCtx(), p, [item({})]);
    if (res.kind !== 'items') throw new Error('expected items');
    expect(res.outputs.numbers).toHaveLength(1); // "42" gt 10 — same loose numeric compare as IF
    expect(compareValues('42', 'gt', 10)).toBe(true);

    const miss = await flowSwitch.execute(makeCtx(), params(flowSwitch, { ...RULES, value: 'nope' }), [item({})]);
    if (miss.kind !== 'items') throw new Error('expected items');
    expect(miss.outputs.default).toHaveLength(1);

    const ports = flowSwitch.dynamicOutputs!(p);
    expect(ports).toEqual(['vip', 'numbers', 'default']);
    expect(dynamicOutputPorts('flow.switch', p)).toEqual(ports);
  });

  it('rejects empty rules / bad port chars (error)', () => {
    expect(() => params(flowSwitch, { value: 1, rules: [] })).toThrow(/invalid params/);
    expect(() => params(flowSwitch, { value: 1, rules: [{ port: 'has space', match: 1 }] })).toThrow(/invalid params/);
  });
});

describe('flow.wait', () => {
  it('duration mode → delay WaitSpec at now+duration (happy)', async () => {
    const ctx = makeCtx();
    const res = await flowWait.execute(ctx, params(flowWait, { mode: 'duration', duration: '2h' }), [item({})]);
    if (res.kind !== 'wait') throw new Error('expected wait');
    const spec = WaitSpecSchema.parse(JSON.parse(JSON.stringify(res.wait))); // durable round-trip
    expect(spec).toMatchObject({ kind: 'delay', resumeAt: '2026-06-11T12:00:00.000Z' });
  });

  it('until mode parses datetimes (edge)', async () => {
    const res = await flowWait.execute(
      makeCtx(),
      params(flowWait, { mode: 'until', until: '2026-07-01T08:30:00Z' }),
      [item({})],
    );
    if (res.kind !== 'wait' || res.wait.kind !== 'delay') throw new Error('expected delay wait');
    expect(res.wait.resumeAt).toBe('2026-07-01T08:30:00.000Z');
  });

  it('invalid until fails loudly; schema cross-requires fields (error)', async () => {
    const res = await flowWait.execute(makeCtx(), params(flowWait, { mode: 'until', until: 'فردا' }), []);
    expect(res).toMatchObject({ kind: 'error' });
    expect(() => params(flowWait, { mode: 'duration' })).toThrow(/invalid params/);
    expect(() => params(flowWait, { mode: 'until' })).toThrow(/invalid params/);
  });
});

describe('http.request', () => {
  it('GET with query/header rows; JSON object spreads into $json (happy)', async () => {
    const ctx = makeCtx({ httpResponses: [{ status: 200, body: { name: 'علی', id: 7 } }] });
    const p = params(httpRequest, {
      url: 'https://api.example.com/u?x=1',
      query: [{ name: 'id', value: '7' }],
      headers: [{ name: 'Authorization', value: 'Bearer t' }],
    });
    const res = await httpRequest.execute(ctx, p, [item({})]);
    if (res.kind !== 'items') throw new Error('expected items');
    expect(ctx.httpCalls[0]).toMatchObject({
      method: 'GET',
      url: 'https://api.example.com/u?x=1&id=7',
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.outputs.main![0]!.json).toMatchObject({ name: 'علی', id: 7, statusCode: 200 });
  });

  it('POST json body + array/text responses + per-item calls (edge)', async () => {
    const ctx = makeCtx({ httpResponses: [{ status: 201, body: [1, 2] }, { status: 201, body: 'ok' }] });
    const p = params(httpRequest, {
      method: 'POST',
      url: 'https://api.example.com/items',
      body_type: 'json',
      body: '{"a":1}',
    });
    const res = await httpRequest.execute(ctx, p, [item({ i: 1 }), item({ i: 2 })]);
    if (res.kind !== 'items') throw new Error('expected items');
    expect(ctx.httpCalls).toHaveLength(2); // once per item
    expect(ctx.httpCalls[0]!.headers).toMatchObject({ 'content-type': 'application/json' });
    expect(ctx.httpCalls[0]!.body).toBe('{"a":1}');
    expect(res.outputs.main![0]!.json).toMatchObject({ data: [1, 2], statusCode: 201 });
    expect(res.outputs.main![1]!.json).toMatchObject({ body: 'ok', statusCode: 201 });

    // form body urlencodes rows
    const ctx2 = makeCtx();
    await httpRequest.execute(
      ctx2,
      params(httpRequest, {
        method: 'POST', url: 'https://e.com/f', body_type: 'form',
        form: [{ name: 'a', value: '1' }, { name: 'b', value: 'دو' }],
      }),
      [item({})],
    );
    expect(ctx2.httpCalls[0]!.body).toBe('a=1&b=%D8%AF%D9%88');
    expect(ctx2.httpCalls[0]!.headers).toMatchObject({ 'content-type': 'application/x-www-form-urlencoded' });
  });

  it('non-2xx fails unless never_error; invalid url/transport fail; schema requires body (error)', async () => {
    const failing = makeCtx({ httpResponses: [{ status: 404, body: { error: 'nope' } }] });
    const p = params(httpRequest, { url: 'https://e.com/missing' });
    const res = await httpRequest.execute(failing, p, [item({})]);
    expect(res).toMatchObject({ kind: 'error', message: expect.stringContaining('404') });

    const tolerant = makeCtx({ httpResponses: [{ status: 404, body: { error: 'nope' } }] });
    const p2 = params(httpRequest, { url: 'https://e.com/missing', never_error: true });
    const ok = await httpRequest.execute(tolerant, p2, [item({})]);
    if (ok.kind !== 'items') throw new Error('expected items');
    expect(ok.outputs.main![0]!.json).toMatchObject({ statusCode: 404, error: 'nope' });

    const badUrl = await httpRequest.execute(makeCtx(), params(httpRequest, { url: 'سلام' }), []);
    expect(badUrl).toMatchObject({ kind: 'error', message: expect.stringContaining('invalid url') });

    const transport = makeCtx();
    transport.http.request = async () => { throw new Error('ECONNREFUSED'); };
    const dead = await httpRequest.execute(transport, params(httpRequest, { url: 'https://e.com' }), []);
    expect(dead).toMatchObject({ kind: 'error', message: expect.stringContaining('ECONNREFUSED') });

    expect(() => params(httpRequest, { url: 'https://e.com', body_type: 'json' })).toThrow(/invalid params/);
  });

  it('credentialId → host-resolved auth headers form the base; rows still override (P3-T4)', async () => {
    const ctx = makeCtx({
      httpResponses: [{ status: 200, body: { ok: true } }],
      credentialHeaders: { cred1: { authorization: 'Bearer secret-from-store' } },
    });
    const p = params(httpRequest, {
      url: 'https://api.example.com/me',
      credentialId: 'cred1',
      // explicit row overrides a different header but leaves auth alone
      headers: [{ name: 'X-Trace', value: 'abc' }],
    });
    const res = await httpRequest.execute(ctx, p, [item({})]);
    if (res.kind !== 'items') throw new Error('expected items');
    expect(ctx.httpCalls[0]!.headers).toMatchObject({
      authorization: 'Bearer secret-from-store',
      'X-Trace': 'abc',
    });
  });

  it('credentialId not found → clear error (P3-T4)', async () => {
    const ctx = makeCtx({ credentialHeaders: {} }); // resolver present, returns null
    const res = await httpRequest.execute(
      ctx,
      params(httpRequest, { url: 'https://e.com', credentialId: 'missing' }),
      [item({})],
    );
    expect(res).toMatchObject({ kind: 'error', message: expect.stringContaining('not found') });
  });

  it('credentialId with no credential store in context → clear error (P3-T4)', async () => {
    const ctx = makeCtx({ credentialHeaders: null }); // ctx.credentials === null
    const res = await httpRequest.execute(
      ctx,
      params(httpRequest, { url: 'https://e.com', credentialId: 'cred1' }),
      [item({})],
    );
    expect(res).toMatchObject({ kind: 'error', message: expect.stringContaining('not available') });
  });
});

describe('data.kv', () => {
  it('set → get round-trip lands in $json.<save_as> (happy)', async () => {
    const ctx = makeCtx();
    await dataKv.execute(ctx, params(dataKv, { op: 'set', scope: 'user', key: 'points', value: 5 }), [item({})]);
    expect(ctx.kvBag.get('user:points')).toBe(5);

    const res = await dataKv.execute(ctx, params(dataKv, { op: 'get', scope: 'user', key: 'points', save_as: 'pts' }), [item({ keep: 1 })]);
    if (res.kind !== 'items') throw new Error('expected items');
    expect(res.outputs.main![0]!.json).toEqual({ keep: 1, pts: 5 });
  });

  it('increment creates-then-steps; delete removes; missing get → null (edge)', async () => {
    const ctx = makeCtx();
    const r1 = await dataKv.execute(ctx, params(dataKv, { op: 'increment', scope: 'bot', key: 'c' }), [item({})]);
    if (r1.kind !== 'items') throw new Error('expected items');
    expect(r1.outputs.main![0]!.json['value']).toBe(1); // default step, default save_as

    const r2 = await dataKv.execute(ctx, params(dataKv, { op: 'increment', scope: 'bot', key: 'c', value: '+5' }), [item({})]);
    if (r2.kind !== 'items') throw new Error('expected items');
    expect(r2.outputs.main![0]!.json['value']).toBe(6); // "+5" string step accepted

    await dataKv.execute(ctx, params(dataKv, { op: 'delete', scope: 'bot', key: 'c' }), [item({})]);
    const r3 = await dataKv.execute(ctx, params(dataKv, { op: 'get', scope: 'bot', key: 'c' }), [item({})]);
    if (r3.kind !== 'items') throw new Error('expected items');
    expect(r3.outputs.main![0]!.json['value']).toBeNull();

    // op runs once per node run, output mirrors input item count
    const many = await dataKv.execute(ctx, params(dataKv, { op: 'increment', scope: 'bot', key: 'n' }), [item({ i: 1 }), item({ i: 2 })]);
    if (many.kind !== 'items') throw new Error('expected items');
    expect(ctx.kvBag.get('bot:n')).toBe(1); // ONE increment despite two items
    expect(many.outputs.main).toHaveLength(2);
  });

  it('non-numeric increment fails; schema requires value for set (error)', async () => {
    const ctx = makeCtx();
    ctx.kvBag.set('user:s', 'متن');
    const res = await dataKv.execute(ctx, params(dataKv, { op: 'increment', scope: 'user', key: 's' }), []);
    expect(res).toMatchObject({ kind: 'error', message: expect.stringContaining('non-numeric') });

    const bad = await dataKv.execute(makeCtx(), params(dataKv, { op: 'increment', scope: 'user', key: 'x', value: 'abc' }), []);
    expect(bad).toMatchObject({ kind: 'error' });

    expect(() => params(dataKv, { op: 'set', key: 'x' })).toThrow(/invalid params/);
    expect(() => params(dataKv, { op: 'get', key: '' })).toThrow(/invalid params/);
  });
});

describe('flow.manualTrigger', () => {
  it('emits the sample JSON as the first item (happy)', async () => {
    const res = await flowManualTrigger.execute(
      makeCtx(),
      params(flowManualTrigger, { sample: '{"text":"سلام","n":1}' }),
      [],
    );
    if (res.kind !== 'items') throw new Error('expected items');
    expect(res.outputs.main).toEqual([{ json: { text: 'سلام', n: 1 } }]);
  });

  it('explicit entry items win over sample; empty sample → one empty item (edge)', async () => {
    const injected = [item({ from: 'harness' })];
    const res = await flowManualTrigger.execute(
      makeCtx(),
      params(flowManualTrigger, { sample: '{"ignored":true}' }),
      injected,
    );
    if (res.kind !== 'items') throw new Error('expected items');
    expect(res.outputs.main).toBe(injected);

    const empty = await flowManualTrigger.execute(makeCtx(), params(flowManualTrigger, {}), []);
    if (empty.kind !== 'items') throw new Error('expected items');
    expect(empty.outputs.main).toEqual([{ json: {} }]);
  });

  it('invalid / non-object sample fails loudly (error)', async () => {
    const bad = await flowManualTrigger.execute(makeCtx(), params(flowManualTrigger, { sample: '{nope' }), []);
    expect(bad).toMatchObject({ kind: 'error', message: expect.stringContaining('valid JSON') });
    const arr = await flowManualTrigger.execute(makeCtx(), params(flowManualTrigger, { sample: '[1,2]' }), []);
    expect(arr).toMatchObject({ kind: 'error', message: expect.stringContaining('JSON object') });
  });
});
