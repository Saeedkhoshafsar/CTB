/**
 * P2-T5 — executions inspector store against the fake server: list +
 * status filter, detail selection, live-ish refresh semantics, and cancel
 * (incl. the 409 refresh-instead-of-error path and the typed client's
 * cancelExecution method).
 */
import type { ExecutionDetail } from '@ctb/shared';
import { describe, expect, it } from 'vitest';
import { ApiClient, ApiError } from '../src/api/client';
import { createAuthStore } from '../src/stores/auth';
import { createExecutionsStore } from '../src/stores/executions';
import { createFakeServer } from './fake-fetch';

function fakeExecution(over: Partial<ExecutionDetail>): ExecutionDetail {
  return {
    id: 'exec-1',
    flowId: 'flow-x',
    botId: 'bot-x',
    chatId: 42,
    status: 'done',
    error: null,
    startedAt: '2026-06-11T10:00:00.000Z',
    updatedAt: '2026-06-11T10:00:01.000Z',
    wait: null,
    logs: [],
    ...over,
  };
}

async function setup() {
  const srv = createFakeServer();
  const client = new ApiClient({ fetchImpl: srv.fetch });
  await createAuthStore(client).getState().login('admin', 'pw');
  return { srv, client, useExecs: createExecutionsStore(client) };
}

describe('executions store (P2-T5)', () => {
  it('loads the list newest-first and filters by status', async () => {
    const { srv, useExecs } = await setup();
    srv.executions.set('e1', fakeExecution({ id: 'e1', status: 'done', startedAt: '2026-06-11T09:00:00.000Z' }));
    srv.executions.set('e2', fakeExecution({ id: 'e2', status: 'waiting', startedAt: '2026-06-11T11:00:00.000Z' }));

    await useExecs.getState().load();
    expect(useExecs.getState().rows.map((r) => r.id)).toEqual(['e2', 'e1']);

    await useExecs.getState().setStatus('waiting');
    expect(useExecs.getState().rows.map((r) => r.id)).toEqual(['e2']);
    expect(useExecs.getState().status).toBe('waiting');

    // back to all — filter is store state, not a one-shot arg
    await useExecs.getState().setStatus('all');
    expect(useExecs.getState().rows).toHaveLength(2);
  });

  it('scopes to a flowId (deep link from the flow editor)', async () => {
    const { srv, useExecs } = await setup();
    srv.executions.set('a', fakeExecution({ id: 'a', flowId: 'flow-a' }));
    srv.executions.set('b', fakeExecution({ id: 'b', flowId: 'flow-b' }));

    await useExecs.getState().load({ flowId: 'flow-a' });
    expect(useExecs.getState().rows.map((r) => r.id)).toEqual(['a']);
    expect(useExecs.getState().flowId).toBe('flow-a');
  });

  it('select loads the detail (logs + wait); deselect clears it', async () => {
    const { srv, useExecs } = await setup();
    srv.executions.set(
      'w1',
      fakeExecution({
        id: 'w1',
        status: 'waiting',
        wait: { kind: 'reply', nodeId: 'ask_name', expect: 'text', retriesLeft: 2, timeoutAt: null },
        logs: [
          { id: 1, nodeId: 'start', level: 'debug', message: 'executed start', input: [{ json: { ok: 1 } }], output: { main: [{ json: { ok: 1 } }] }, error: null, durationMs: 2, ts: '2026-06-11T10:00:00.000Z' },
        ],
      }),
    );
    await useExecs.getState().load();
    await useExecs.getState().select('w1');

    const { detail } = useExecs.getState();
    expect(detail?.id).toBe('w1');
    expect(detail?.wait?.kind).toBe('reply');
    expect(detail?.logs).toHaveLength(1);

    await useExecs.getState().select(null);
    expect(useExecs.getState().detail).toBeNull();
    expect(useExecs.getState().selectedId).toBeNull();
  });

  it('cancel flips the row + refreshes the open detail from the server', async () => {
    const { srv, useExecs } = await setup();
    srv.executions.set('live', fakeExecution({ id: 'live', status: 'waiting', wait: { kind: 'reply', nodeId: 'n', expect: 'text', retriesLeft: 0, timeoutAt: null } }));
    await useExecs.getState().load();
    await useExecs.getState().select('live');

    const ok = await useExecs.getState().cancel('live');
    expect(ok).toBe(true);
    expect(useExecs.getState().rows[0]?.status).toBe('canceled');
    // detail re-fetched: server truth, wait cleared
    expect(useExecs.getState().detail?.status).toBe('canceled');
    expect(useExecs.getState().detail?.wait).toBeNull();
  });

  it('cancel on a finished execution → no error, just refresh (409 path)', async () => {
    const { srv, useExecs } = await setup();
    srv.executions.set('fin', fakeExecution({ id: 'fin', status: 'done' }));
    await useExecs.getState().load();

    const ok = await useExecs.getState().cancel('fin');
    expect(ok).toBe(false);
    expect(useExecs.getState().error).toBeNull(); // a refresh, not an error
    expect(useExecs.getState().rows[0]?.status).toBe('done');
  });

  it('client.cancelExecution raises typed ApiError(409) for direct callers', async () => {
    const { srv, client } = await setup();
    srv.executions.set('fin', fakeExecution({ id: 'fin', status: 'error' }));
    await expect(client.cancelExecution('fin')).rejects.toSatisfy(
      (e: unknown) => e instanceof ApiError && e.status === 409 && e.body.error === 'not_cancelable',
    );
  });

  it('refresh re-fetches list AND the open detail; overlapping calls are guarded', async () => {
    const { srv, useExecs } = await setup();
    srv.executions.set('r1', fakeExecution({ id: 'r1', status: 'waiting' }));
    await useExecs.getState().load();
    await useExecs.getState().select('r1');

    // server-side change happens between ticks (user replied → done)
    const row = srv.executions.get('r1')!;
    row.status = 'done';

    await useExecs.getState().refresh();
    expect(useExecs.getState().rows[0]?.status).toBe('done');
    expect(useExecs.getState().detail?.status).toBe('done');

    // overlap guard: second refresh while one is in flight is a no-op
    const p1 = useExecs.getState().refresh();
    const p2 = useExecs.getState().refresh();
    await Promise.all([p1, p2]);
    expect(useExecs.getState().refreshing).toBe(false);
  });
});
