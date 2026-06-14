/**
 * P4-T2 contract tests — schedule.trigger.
 *
 * The node is a pure pass-through (like tg.trigger / webhook.trigger): the
 * host-side Scheduler runs the cron, builds the item and starts the run. The
 * node just forwards what it was handed and marks its host-directive params raw
 * so the executor never {{ }}-resolves them. The cron/timezone/fan-out/rate
 * behaviour is covered in the server scheduler test.
 */
import { describe, expect, it } from 'vitest';
import { scheduleTrigger } from '@ctb/nodes';
import { item, makeCtx, params } from './node-harness';

describe('schedule.trigger', () => {
  it('passes its input item through on main (happy)', async () => {
    const ctx = makeCtx({ chatId: null });
    const items = [item({ now: '2026-06-14T09:00:00.000Z', scheduled: true })];
    const res = await scheduleTrigger.execute(ctx, params(scheduleTrigger, {}), items);
    if (res.kind !== 'items') throw new Error('expected items');
    expect(res.outputs.main).toEqual(items);
  });

  it('defaults to a daily 09:00 cron, server tz, no fan-out, 60/min (edge)', () => {
    const p = params(scheduleTrigger, {});
    expect(p.cron).toBe('0 9 * * *');
    expect(p.timezone).toBe('');
    expect(p.for_each_user).toBe(false);
    expect(p.rate_per_min).toBe(60);
  });

  it('marks cron / timezone / target_chat as raw (un-resolved) param keys', () => {
    expect(scheduleTrigger.rawParamKeys).toContain('cron');
    expect(scheduleTrigger.rawParamKeys).toContain('timezone');
    expect(scheduleTrigger.rawParamKeys).toContain('target_chat');
  });

  it('clamps rate_per_min to the schema range (edge)', () => {
    expect(() => params(scheduleTrigger, { rate_per_min: -1 })).toThrow();
    expect(() => params(scheduleTrigger, { rate_per_min: 999999 })).toThrow();
    expect(params(scheduleTrigger, { rate_per_min: 0 }).rate_per_min).toBe(0);
    expect(params(scheduleTrigger, { rate_per_min: 120 }).rate_per_min).toBe(120);
  });

  it('rejects an empty cron string (edge)', () => {
    expect(() => params(scheduleTrigger, { cron: '' })).toThrow();
  });

  it('is a trigger node with no inputs and a single main output', () => {
    expect(scheduleTrigger.category).toBe('trigger');
    expect(scheduleTrigger.ports.inputs).toEqual([]);
    expect(scheduleTrigger.ports.outputs).toEqual(['main']);
  });
});
