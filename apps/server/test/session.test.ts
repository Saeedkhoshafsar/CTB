import { describe, expect, it } from 'vitest';
import {
  SESSION_TTL_MS,
  createSessionToken,
  safeEqual,
  verifySessionToken,
} from '../src/lib/session';

const SECRET = 'devsecret0123456';

describe('signed-cookie sessions', () => {
  it('round-trips a valid token', () => {
    const token = createSessionToken('admin', SECRET);
    const payload = verifySessionToken(token, SECRET);
    expect(payload?.sub).toBe('admin');
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
    const token = createSessionToken('admin', SECRET, past);
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
});
