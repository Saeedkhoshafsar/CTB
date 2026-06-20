/**
 * PE-T3 contract tests — trigger.callEvent.
 *
 * The node is a pure pass-through (like schedule.trigger / tg.trigger): the
 * host-side Call-event bus watches the Call Session Service and, on a matching
 * call event, builds the item and starts the run. The node just forwards what it
 * was handed and marks its host match-key params raw so the executor never
 * {{ }}-resolves them. The matching / audio-persist / firing behaviour is
 * covered in the server call-events bus test.
 */
import { describe, expect, it } from 'vitest';
import { callEventTrigger } from '@ctb/nodes';
import { item, makeCtx, params } from './node-harness';

describe('trigger.callEvent', () => {
  it('passes its input item through on main (happy)', async () => {
    const ctx = makeCtx({ chatId: null });
    const items = [
      item({
        event: 'utteranceFinal',
        target: { kind: 'user', id: '42' },
        mode: 'support',
        audioFileId: 'file-1',
      }),
    ];
    const res = await callEventTrigger.execute(
      ctx,
      params(callEventTrigger, { connection: 'cred1', targetId: '42' }),
      items,
    );
    if (res.kind !== 'items') throw new Error('expected items');
    expect(res.outputs.main).toEqual(items);
  });

  it('defaults to a 1:1 support call on utteranceFinal, sequential, no auto-advance (edge)', () => {
    const p = params(callEventTrigger, { connection: 'cred1', targetId: '42' });
    expect(p.targetKind).toBe('user');
    expect(p.events).toEqual(['utteranceFinal']);
    expect(p.mode).toBe('support');
    expect(p.order).toBe('sequential');
    expect(p.maxTurnSeconds).toBe(0);
    expect(p.autoAdvance).toBe(false);
  });

  it('accepts a lineup Q&A config (group broadcast scenario)', () => {
    const p = params(callEventTrigger, {
      connection: 'cred1',
      targetKind: 'channel',
      targetId: '-100123',
      events: ['callJoined', 'utteranceFinal', 'turnOpened', 'callLeft'],
      mode: 'lineup',
      order: 'random',
      maxTurnSeconds: 90,
      autoAdvance: true,
    });
    expect(p.targetKind).toBe('channel');
    expect(p.mode).toBe('lineup');
    expect(p.order).toBe('random');
    expect(p.maxTurnSeconds).toBe(90);
    expect(p.autoAdvance).toBe(true);
    expect(p.events).toContain('turnOpened');
  });

  it('marks connection / targetId as raw (un-resolved) param keys', () => {
    expect(callEventTrigger.rawParamKeys).toContain('connection');
    expect(callEventTrigger.rawParamKeys).toContain('targetId');
  });

  it('requires connection and targetId (edge)', () => {
    expect(() => params(callEventTrigger, { targetId: '42' } as never)).toThrow();
    expect(() => params(callEventTrigger, { connection: 'cred1' } as never)).toThrow();
    expect(() =>
      params(callEventTrigger, { connection: '', targetId: '42' } as never),
    ).toThrow();
  });

  it('rejects an empty events list and an unknown event (edge)', () => {
    expect(() =>
      params(callEventTrigger, { connection: 'cred1', targetId: '42', events: [] } as never),
    ).toThrow();
    expect(() =>
      params(callEventTrigger, {
        connection: 'cred1',
        targetId: '42',
        events: ['nope'],
      } as never),
    ).toThrow();
  });

  it('is a trigger node with no inputs and a single main output', () => {
    expect(callEventTrigger.category).toBe('trigger');
    expect(callEventTrigger.ports.inputs).toEqual([]);
    expect(callEventTrigger.ports.outputs).toEqual(['main']);
  });
});
