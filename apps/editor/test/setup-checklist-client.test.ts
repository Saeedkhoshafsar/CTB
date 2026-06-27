/**
 * PLAN4 L-T2 — ApiClient.setupChecklist() contract test.
 *
 * Pins the HTTP verb + path of the go-live checklist call and confirms the
 * parsed body (the server-derived OPEN items + `ready` flag) is returned
 * verbatim. Uses the same minimal fetch stub as the J-T2 listen tests — no fake
 * server needed.
 */
import type { SetupChecklist } from '@ctb/shared';
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

describe('ApiClient.setupChecklist (L-T2)', () => {
  it('GETs /api/setup/checklist and returns the open items + ready flag', async () => {
    const reply: SetupChecklist = {
      items: [
        { id: 'bot', optional: false },
        { id: 'admins', optional: true },
      ],
      ready: false,
    };
    const { calls, client } = stub(reply);
    const res = await client.setupChecklist();
    expect(res).toEqual(reply);
    expect(calls.at(-1)).toMatchObject({ method: 'GET' });
    expect(calls.at(-1)?.url).toContain('/api/setup/checklist');
  });

  it('returns the ready state (no open items) verbatim', async () => {
    const reply: SetupChecklist = { items: [], ready: true };
    const { client } = stub(reply);
    const res = await client.setupChecklist();
    expect(res.ready).toBe(true);
    expect(res.items).toEqual([]);
  });
});
