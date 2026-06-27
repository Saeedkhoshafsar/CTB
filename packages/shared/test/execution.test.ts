import { describe, expect, it } from 'vitest';
import {
  ExecutionSchema,
  ExecutionStateSchema,
  WaitSpecSchema,
} from '@ctb/shared';

describe('ExecutionState', () => {
  it('round-trips serialize → parse → deep-equal (invariant I4 shape)', () => {
    const state = ExecutionStateSchema.parse({
      cursor: 'ask_age',
      items: { main: [{ json: { text: 'علی' } }] },
      vars: { name: 'علی', answers: ['علی'] },
      steps: 3,
    });
    const roundTripped = ExecutionStateSchema.parse(JSON.parse(JSON.stringify(state)));
    expect(roundTripped).toEqual(state);
  });

  it('applies defaults for vars and steps', () => {
    const state = ExecutionStateSchema.parse({ cursor: null, items: {} });
    expect(state.vars).toEqual({});
    expect(state.steps).toBe(0);
  });

  it('listening flag is optional and absent on a pre-J-T1 state (byte-identical)', () => {
    const legacy = ExecutionStateSchema.parse({ cursor: 'a', items: {}, vars: {}, steps: 0 });
    expect(legacy.listening).toBeUndefined();
    expect('listening' in legacy).toBe(false);
  });

  it('parses a J-T1 armed listen state (listening + testRun)', () => {
    const state = ExecutionStateSchema.parse({
      cursor: 'trig',
      items: { main: [] },
      vars: {},
      steps: 0,
      listening: true,
      testRun: true,
    });
    expect(state.listening).toBe(true);
    expect(state.testRun).toBe(true);
    const roundTripped = ExecutionStateSchema.parse(JSON.parse(JSON.stringify(state)));
    expect(roundTripped).toEqual(state);
  });
});

describe('WaitSpec', () => {
  it('parses a reply wait with timeout', () => {
    const w = WaitSpecSchema.parse({
      kind: 'reply',
      nodeId: 'ask_age',
      expect: 'number',
      retriesLeft: 2,
      timeoutAt: '2026-06-11T12:00:00.000Z',
    });
    expect(w.kind).toBe('reply');
  });

  it('parses a callback wait (menu buttons)', () => {
    const w = WaitSpecSchema.parse({
      kind: 'callback',
      nodeId: 'menu1',
      keys: ['buy', 'cancel'],
    });
    if (w.kind !== 'callback') throw new Error('wrong kind');
    expect(w.keys).toContain('buy');
  });

  it('rejects callback wait without keys / unknown kinds', () => {
    expect(WaitSpecSchema.safeParse({ kind: 'callback', nodeId: 'm', keys: [] }).success).toBe(false);
    expect(WaitSpecSchema.safeParse({ kind: 'sleep', nodeId: 'm' }).success).toBe(false);
  });

  it('parses a J-T1 trigger wait (listen for one live update) with a params snapshot', () => {
    const w = WaitSpecSchema.parse({
      kind: 'trigger',
      nodeId: 'trig',
      triggerParams: { event: 'command', command: 'start' },
      timeoutAt: '2026-06-27T12:00:00.000Z',
    });
    if (w.kind !== 'trigger') throw new Error('wrong kind');
    expect(w.triggerParams).toEqual({ event: 'command', command: 'start' });
    expect(w.timeoutAt).toBe('2026-06-27T12:00:00.000Z');
  });

  it('trigger wait defaults: empty params snapshot + null timeout', () => {
    const w = WaitSpecSchema.parse({ kind: 'trigger', nodeId: 'trig' });
    if (w.kind !== 'trigger') throw new Error('wrong kind');
    expect(w.triggerParams).toEqual({});
    expect(w.timeoutAt).toBeNull();
  });
});

describe('Execution', () => {
  it('parses a full waiting execution document', () => {
    const exec = ExecutionSchema.parse({
      id: 'ex_1',
      flowId: 'fl_1',
      botId: 'bot_1',
      chatId: 12345,
      userId: 'u_1',
      status: 'waiting',
      state: { cursor: 'ask_name', items: { main: [{ json: {} }] }, vars: {}, steps: 1 },
      wait: { kind: 'reply', nodeId: 'ask_name', expect: 'text', retriesLeft: 0, timeoutAt: null },
      error: null,
      startedAt: '2026-06-10T10:00:00.000Z',
      updatedAt: '2026-06-10T10:00:05.000Z',
    });
    expect(exec.status).toBe('waiting');
    expect(exec.wait?.kind).toBe('reply');
  });

  it('rejects bad status', () => {
    expect(
      ExecutionSchema.safeParse({
        id: 'x', flowId: 'f', botId: 'b', chatId: null, userId: null,
        status: 'paused',
        state: { cursor: null, items: {} },
        wait: null, startedAt: '2026-06-10T10:00:00.000Z', updatedAt: '2026-06-10T10:00:00.000Z',
      }).success,
    ).toBe(false);
  });
});
