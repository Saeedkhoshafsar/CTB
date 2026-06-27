import { describe, expect, it } from 'vitest';
import {
  SESSION_TTL_MS,
  createSessionToken,
  roleAtLeast,
  safeEqual,
  verifySessionToken,
} from '../src/lib/session';

const SECRET = 'devsecret0123456';

describe('signed-cookie sessions', () => {
  it('round-trips a valid token', () => {
    const token = createSessionToken('admin', SECRET);
    const payload = verifySessionToken(token, SECRET);
    expect(payload?.sub).toBe('admin');
    expect(payload?.role).toBe('admin'); // default role
  });

  it('carries an operator role', () => {
    const token = createSessionToken('mgr', SECRET, 'operator');
    expect(verifySessionToken(token, SECRET)?.role).toBe('operator');
  });

  it('rejects a tampered payload', () => {
    const token = createSessionToken('admin', SECRET);
    const [body, sig] = token.split('.') as [string, string];
    const evil = Buffer.from(JSON.stringify({ sub: 'root', exp: Date.now() + 9e9 })).toString(
      'base64url',
    );
    expect(verifySessionToken(`${evil}.${sig}`, SECRET)).toBeNull();
    expect(verifySessionToken(`${body}.AAAA`, SECRET)).toBeNull();
  });

  it('rejects wrong secret', () => {
    const token = createSessionToken('admin', SECRET);
    expect(verifySessionToken(token, 'anothersecret9999')).toBeNull();
  });

  it('rejects expired token', () => {
    const past = Date.now() - SESSION_TTL_MS - 1000;
    const token = createSessionToken('admin', SECRET, 'admin', past);
    expect(verifySessionToken(token, SECRET)).toBeNull();
  });

  it('rejects garbage tokens without throwing', () => {
    expect(verifySessionToken('', SECRET)).toBeNull();
    expect(verifySessionToken('a.b.c', SECRET)).toBeNull();
    expect(verifySessionToken('notatoken', SECRET)).toBeNull();
  });

  it('safeEqual compares constant-time-ish', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
  });

  // ---- K-T1: owner role + roleAtLeast precedence -------------------------

  it('round-trips an owner role token', () => {
    const token = createSessionToken('founder', SECRET, 'owner');
    expect(verifySessionToken(token, SECRET)?.role).toBe('owner');
  });

  it('roleAtLeast respects owner ⊇ admin ⊇ operator precedence', () => {
    // owner satisfies everything
    expect(roleAtLeast('owner', 'owner')).toBe(true);
    expect(roleAtLeast('owner', 'admin')).toBe(true);
    expect(roleAtLeast('owner', 'operator')).toBe(true);
    // admin satisfies admin/operator but not owner
    expect(roleAtLeast('admin', 'owner')).toBe(false);
    expect(roleAtLeast('admin', 'admin')).toBe(true);
    expect(roleAtLeast('admin', 'operator')).toBe(true);
    // operator satisfies only operator
    expect(roleAtLeast('operator', 'admin')).toBe(false);
    expect(roleAtLeast('operator', 'operator')).toBe(true);
  });

  it('a legacy token without a role normalises to admin (back-compat, no escalation)', () => {
    // Mint a properly-signed token whose payload predates roles (no `role`),
    // by reaching into the same HMAC the module uses, so the signature is valid
    // and only the *role* is absent — exercising the normalisation branch.
    const { createHmac } = require('node:crypto') as typeof import('node:crypto');
    const body = Buffer.from(
      JSON.stringify({ sub: 'legacy', exp: Date.now() + SESSION_TTL_MS }),
    ).toString('base64url');
    const sig = createHmac('sha256', `ctb-session-v1:${SECRET}`).update(body).digest('base64url');
    const payload = verifySessionToken(`${body}.${sig}`, SECRET);
    expect(payload?.sub).toBe('legacy');
    expect(payload?.role).toBe('admin'); // defaulted, never escalated to owner
  });
});
