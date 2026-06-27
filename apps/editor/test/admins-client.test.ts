/**
 * PLAN4 K-T3 — ApiClient panel-admins methods.
 *
 * Pin the HTTP verb, path (with id encoding) and parsed body for the five
 * Admins-page calls against a minimal fetch stub — no full fake server needed.
 * The methods unwrap the server's envelopes ({ admins } / { admin } /
 * { owner, previous }) so the store/page get plain shapes.
 */
import type { PanelAdmin } from '@ctb/shared';
import { describe, expect, it } from 'vitest';
import { ApiClient, ClientValidationError } from '../src/api/client';

interface RecordedCall {
  url: string;
  method: string;
  body: unknown;
}

/** A fetch stub that records each call (incl. parsed JSON body) and replies fixed JSON. */
function stub(reply: unknown, status = 200) {
  const calls: RecordedCall[] = [];
  const fetchImpl = (input: string | URL, init?: RequestInit) => {
    let body: unknown;
    if (typeof init?.body === 'string' && init.body.length > 0) {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    calls.push({ url: String(input), method: init?.method ?? 'GET', body });
    return Promise.resolve(
      new Response(status === 204 ? null : JSON.stringify(reply), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
    );
  };
  return { calls, client: new ApiClient({ fetchImpl: fetchImpl as typeof fetch }) };
}

const owner: PanelAdmin = { tgUserId: '100', role: 'owner', label: 'Owner', createdAt: '2026-01-01T00:00:00.000Z' };
const admin: PanelAdmin = { tgUserId: '200', role: 'admin', label: 'Admin', createdAt: '2026-01-02T00:00:00.000Z' };

describe('ApiClient panel-admins methods (K-T3)', () => {
  it('listAdmins GETs /api/admins and unwraps the list', async () => {
    const { calls, client } = stub({ admins: [owner, admin] });
    const res = await client.listAdmins();
    expect(res).toEqual([owner, admin]);
    expect(calls.at(-1)).toMatchObject({ method: 'GET' });
    expect(calls.at(-1)?.url).toContain('/api/admins');
  });

  it('addAdmin POSTs the validated body and unwraps the admin', async () => {
    const { calls, client } = stub({ admin });
    const res = await client.addAdmin({ tgUserId: '200', role: 'admin', label: 'Admin' });
    expect(res).toEqual(admin);
    expect(calls.at(-1)).toMatchObject({ method: 'POST' });
    expect(calls.at(-1)?.url).toContain('/api/admins');
    expect(calls.at(-1)?.body).toMatchObject({ tgUserId: '200', role: 'admin', label: 'Admin' });
  });

  it('addAdmin rejects an invalid tgUserId before any fetch', async () => {
    const { calls, client } = stub({ admin });
    await expect(
      client.addAdmin({ tgUserId: 'not-a-number', role: 'admin', label: 'x' }),
    ).rejects.toBeInstanceOf(ClientValidationError);
    expect(calls).toHaveLength(0);
  });

  it('removeAdmin DELETEs with the id encoded in the path', async () => {
    const { calls, client } = stub({ ok: true });
    await client.removeAdmin('200');
    expect(calls.at(-1)).toMatchObject({ method: 'DELETE' });
    expect(calls.at(-1)?.url).toContain('/api/admins/200');
  });

  it('setAdminRole PATCHes /api/admins/:id/role with the role body', async () => {
    const promoted: PanelAdmin = { ...admin, role: 'operator' };
    const { calls, client } = stub({ admin: promoted });
    const res = await client.setAdminRole('200', { role: 'operator' });
    expect(res).toEqual(promoted);
    expect(calls.at(-1)).toMatchObject({ method: 'PATCH' });
    expect(calls.at(-1)?.url).toContain('/api/admins/200/role');
    expect(calls.at(-1)?.body).toMatchObject({ role: 'operator' });
  });

  it('transferOwner POSTs to /api/admins/transfer-owner and returns owner + previous', async () => {
    const newOwner: PanelAdmin = { ...admin, role: 'owner' };
    const demoted: PanelAdmin = { ...owner, role: 'admin' };
    const { calls, client } = stub({ owner: newOwner, previous: demoted });
    const res = await client.transferOwner({ tgUserId: '200' });
    expect(res).toEqual({ owner: newOwner, previous: demoted });
    expect(calls.at(-1)).toMatchObject({ method: 'POST' });
    expect(calls.at(-1)?.url).toContain('/api/admins/transfer-owner');
    expect(calls.at(-1)?.body).toMatchObject({ tgUserId: '200' });
  });
});
