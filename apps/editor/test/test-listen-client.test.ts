/**
 * PLAN4 J-T2 — ApiClient test-listen methods.
 *
 * These three methods wire the editor's "Test run" listen path to the J-T1
 * server seam (POST arm / GET status / DELETE disarm). They are pinned with a
 * minimal fetch stub (no full fake server needed) so the HTTP verb, path,
 * executionId query encoding and parsed body are exactly what the server
 * contract expects.
 */
import type { TestListenArmed, TestListenStatus } from '@ctb/shared';
import { describe, expect, it } from 'vitest';
import { ApiClient } from '../src/api/client';

/** A fetch stub that records the last call and replies with a fixed JSON body. */
function stub(reply: unknown, status = 200) {
  const calls: { url: string; method: string }[] = [];
  const fetchImpl = (input: string | URL, init?: RequestInit) => {
    calls.push({ url: String(input), method: init?.method ?? 'GET' });
    return Promise.resolve(
      new Response(JSON.stringify(reply), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
    );
  };
  return { calls, client: new ApiClient({ fetchImpl: fetchImpl as typeof fetch }) };
}

describe('ApiClient test-listen methods (J-T2)', () => {
  it('testListen POSTs to /api/flows/:id/test-listen and returns the armed envelope', async () => {
    const armed: TestListenArmed = { executionId: 'e1', flowId: 'f1', botId: 'b1', nodeId: 't1' };
    const { calls, client } = stub(armed, 201);
    const res = await client.testListen('f1');
    expect(res).toEqual(armed);
    expect(calls.at(-1)).toMatchObject({ method: 'POST' });
    expect(calls.at(-1)?.url).toContain('/api/flows/f1/test-listen');
  });

  it('testListenStatus GETs status with the executionId in the query string', async () => {
    const st: TestListenStatus = { executionId: 'e1', state: 'listening' };
    const { calls, client } = stub(st);
    const res = await client.testListenStatus('f1', 'e1');
    expect(res).toEqual(st);
    expect(calls.at(-1)).toMatchObject({ method: 'GET' });
    expect(calls.at(-1)?.url).toContain('/api/flows/f1/test-listen/status?executionId=e1');
  });

  it('testListenCancel DELETEs with the executionId query (disarm)', async () => {
    const { calls, client } = stub({ ok: true });
    await client.testListenCancel('f1', 'e1');
    expect(calls.at(-1)).toMatchObject({ method: 'DELETE' });
    expect(calls.at(-1)?.url).toContain('/api/flows/f1/test-listen?executionId=e1');
  });

  it('encodes a non-trivial executionId in the status query', async () => {
    const { calls, client } = stub({ executionId: 'a/b', state: 'captured' } satisfies TestListenStatus);
    await client.testListenStatus('f1', 'a/b');
    expect(calls.at(-1)?.url).toContain('executionId=a%2Fb');
  });
});
