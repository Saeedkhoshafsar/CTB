/**
 * PE-T4 contract tests — the six `call.*` action nodes.
 *
 * Each is a thin, setting-driven wrapper over the one typed `ctx.call`
 * capability (the host holds the media — invariants I3/I4/I6). These tests pin:
 *   - registration + ports/category;
 *   - the request each node hands to `ctx.call.*` (target kind+id, mode/order,
 *     the speak source decode, grantTurn save_as, mute flag);
 *   - pass-through of the input items (grantTurn merges the granted id);
 *   - fail-loud when `ctx.call === null` (no Call Session Service) or a required
 *     field is empty / the connector throws.
 */
import { describe, expect, it } from 'vitest';
import {
  builtinNodes,
  callConnect,
  callEndTurn,
  callGrantTurn,
  callLeave,
  callMute,
  callSpeak,
} from '@ctb/nodes';
import { item, makeCtx, params } from './node-harness';

describe('call.* action nodes — registration', () => {
  it('registers all six and they are flow-category actions with main in/out', () => {
    const types = builtinNodes.map((n) => n.type);
    for (const t of ['call.connect', 'call.speak', 'call.grantTurn', 'call.endTurn', 'call.mute', 'call.leave']) {
      expect(types).toContain(t);
    }
    for (const def of [callConnect, callSpeak, callGrantTurn, callEndTurn, callMute, callLeave]) {
      expect(def.category).toBe('flow');
      expect(def.ports.inputs).toEqual(['main']);
      expect(def.ports.outputs).toEqual(['main']);
    }
  });
});

describe('call.connect', () => {
  it('connects with the resolved target + mode + lineup tuning', async () => {
    const ctx = makeCtx({ chatId: null });
    const p = params(callConnect, {
      connection: 'cred1',
      targetKind: 'channel',
      targetId: '-100123',
      mode: 'lineup',
      order: 'random',
      maxTurnSeconds: 90,
    });
    const res = await callConnect.execute(ctx, p, [item({ a: 1 })]);
    if (res.kind !== 'items') throw new Error('expected items');
    expect(res.outputs.main).toEqual([item({ a: 1 })]);
    expect(ctx.callCalls).toEqual([
      {
        method: 'connect',
        req: {
          credentialId: 'cred1',
          target: { kind: 'channel', id: '-100123' },
          mode: 'lineup',
          order: 'random',
          maxTurnSeconds: 90,
        },
      },
    ]);
  });

  it('fails loud when ctx.call is null', async () => {
    const ctx = makeCtx({ chatId: null, call: null });
    const res = await callConnect.execute(
      ctx,
      params(callConnect, { connection: 'c', targetId: '42' }),
      [],
    );
    expect(res.kind).toBe('error');
  });

  it('defaults to a 1:1 support call', () => {
    const p = params(callConnect, { connection: 'c', targetId: '42' });
    expect(p.targetKind).toBe('user');
    expect(p.mode).toBe('support');
    expect(p.order).toBe('sequential');
    expect(p.maxTurnSeconds).toBe(0);
  });
});

describe('call.speak', () => {
  it('plays a file id (source:file)', async () => {
    const ctx = makeCtx({ chatId: null });
    const p = params(callSpeak, { targetId: '42', source: 'file', fileId: 'f-7' });
    const res = await callSpeak.execute(ctx, p, [item({})]);
    if (res.kind !== 'items') throw new Error('expected items');
    expect(ctx.callCalls).toEqual([
      { method: 'speak', req: { target: { kind: 'user', id: '42' }, fileId: 'f-7' } },
    ]);
  });

  it('decodes base64 PCM (source:pcm) with the sample rate', async () => {
    const ctx = makeCtx({ chatId: null });
    const b64 = Buffer.from([1, 2, 3, 4]).toString('base64');
    const p = params(callSpeak, {
      targetKind: 'channel',
      targetId: '-100',
      source: 'pcm',
      pcmBase64: b64,
      pcmSampleRate: 24000,
    });
    const res = await callSpeak.execute(ctx, p, [item({})]);
    if (res.kind !== 'items') throw new Error('expected items');
    const call = ctx.callCalls[0]!;
    expect(call.method).toBe('speak');
    if (call.method !== 'speak') throw new Error('narrow');
    expect(call.req.target).toEqual({ kind: 'channel', id: '-100' });
    expect(call.req.pcm?.sampleRate).toBe(24000);
    expect([...(call.req.pcm?.samples ?? [])]).toEqual([1, 2, 3, 4]);
  });

  it('fails loud when the chosen source is empty', async () => {
    const ctx = makeCtx({ chatId: null });
    const fileEmpty = await callSpeak.execute(ctx, params(callSpeak, { targetId: '42', source: 'file', fileId: '' }), []);
    expect(fileEmpty.kind).toBe('error');
    const pcmEmpty = await callSpeak.execute(ctx, params(callSpeak, { targetId: '42', source: 'pcm', pcmBase64: '' }), []);
    expect(pcmEmpty.kind).toBe('error');
  });

  it('fails loud when ctx.call is null', async () => {
    const ctx = makeCtx({ chatId: null, call: null });
    const res = await callSpeak.execute(ctx, params(callSpeak, { targetId: '42', source: 'file', fileId: 'f' }), []);
    expect(res.kind).toBe('error');
  });
});

describe('call.grantTurn', () => {
  it('grants the next in queue and saves the granted id under save_as', async () => {
    const ctx = makeCtx({ chatId: null, call: { grantTurn: 11 } });
    const p = params(callGrantTurn, { targetKind: 'channel', targetId: '-100' });
    const res = await callGrantTurn.execute(ctx, p, [item({ x: 1 })]);
    if (res.kind !== 'items') throw new Error('expected items');
    expect(res.outputs.main).toEqual([item({ x: 1, granted: 11 })]);
    expect(ctx.callCalls).toEqual([{ method: 'grantTurn', req: { target: { kind: 'channel', id: '-100' } } }]);
  });

  it('grants a specific user (jumps the line) when userId is set', async () => {
    const ctx = makeCtx({ chatId: null });
    const p = params(callGrantTurn, { targetKind: 'channel', targetId: '-100', userId: '33', save_as: 'who' });
    const res = await callGrantTurn.execute(ctx, p, [item({})]);
    if (res.kind !== 'items') throw new Error('expected items');
    expect(res.outputs.main).toEqual([item({ who: '33' })]);
    expect(ctx.callCalls).toEqual([
      { method: 'grantTurn', req: { target: { kind: 'channel', id: '-100' }, userId: '33' } },
    ]);
  });

  it('does not save when save_as is blank', async () => {
    const ctx = makeCtx({ chatId: null, call: { grantTurn: 11 } });
    const p = params(callGrantTurn, { targetKind: 'channel', targetId: '-100', save_as: '' });
    const res = await callGrantTurn.execute(ctx, p, [item({ x: 1 })]);
    if (res.kind !== 'items') throw new Error('expected items');
    expect(res.outputs.main).toEqual([item({ x: 1 })]);
  });

  it('fails loud when ctx.call is null', async () => {
    const ctx = makeCtx({ chatId: null, call: null });
    const res = await callGrantTurn.execute(ctx, params(callGrantTurn, { targetId: '-100' }), []);
    expect(res.kind).toBe('error');
  });
});

describe('call.endTurn', () => {
  it('ends the current turn for the target', async () => {
    const ctx = makeCtx({ chatId: null });
    const res = await callEndTurn.execute(ctx, params(callEndTurn, { targetKind: 'channel', targetId: '-100' }), [item({})]);
    if (res.kind !== 'items') throw new Error('expected items');
    expect(ctx.callCalls).toEqual([{ method: 'endTurn', req: { target: { kind: 'channel', id: '-100' } } }]);
  });

  it('fails loud when ctx.call is null', async () => {
    const ctx = makeCtx({ chatId: null, call: null });
    const res = await callEndTurn.execute(ctx, params(callEndTurn, { targetId: '-100' }), []);
    expect(res.kind).toBe('error');
  });
});

describe('call.mute', () => {
  it('mutes a participant (muted defaults true)', async () => {
    const ctx = makeCtx({ chatId: null });
    const p = params(callMute, { targetKind: 'channel', targetId: '-100', userId: '77' });
    const res = await callMute.execute(ctx, p, [item({})]);
    if (res.kind !== 'items') throw new Error('expected items');
    expect(ctx.callCalls).toEqual([
      { method: 'mute', req: { target: { kind: 'channel', id: '-100' }, userId: '77', muted: true } },
    ]);
  });

  it('unmutes when muted is false', async () => {
    const ctx = makeCtx({ chatId: null });
    const p = params(callMute, { targetKind: 'channel', targetId: '-100', userId: '77', muted: false });
    await callMute.execute(ctx, p, [item({})]);
    const call = ctx.callCalls[0]!;
    if (call.method !== 'mute') throw new Error('narrow');
    expect(call.req.muted).toBe(false);
  });

  it('fails loud when ctx.call is null', async () => {
    const ctx = makeCtx({ chatId: null, call: null });
    const res = await callMute.execute(ctx, params(callMute, { targetId: '-100', userId: '1' }), []);
    expect(res.kind).toBe('error');
  });
});

describe('call.leave', () => {
  it('leaves the call for the target', async () => {
    const ctx = makeCtx({ chatId: null });
    const res = await callLeave.execute(ctx, params(callLeave, { targetKind: 'user', targetId: '42' }), [item({})]);
    if (res.kind !== 'items') throw new Error('expected items');
    expect(ctx.callCalls).toEqual([{ method: 'leave', req: { target: { kind: 'user', id: '42' } } }]);
  });

  it('fails loud when ctx.call is null', async () => {
    const ctx = makeCtx({ chatId: null, call: null });
    const res = await callLeave.execute(ctx, params(callLeave, { targetId: '42' }), []);
    expect(res.kind).toBe('error');
  });
});
