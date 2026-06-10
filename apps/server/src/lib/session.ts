/**
 * Stateless signed-cookie sessions (v1 single-admin panel auth — ARCHITECTURE §11).
 * Token format: base64url(payload-json).base64url(hmac-sha256(payload)).
 * No server-side session table needed; expiry lives inside the signed payload.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export interface SessionPayload {
  /** Admin username the session belongs to. */
  sub: string;
  /** Unix ms expiry. */
  exp: number;
}

export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function hmac(data: string, secret: string): Buffer {
  return createHmac('sha256', `ctb-session-v1:${secret}`).update(data).digest();
}

export function createSessionToken(username: string, secret: string, now = Date.now()): string {
  const payload: SessionPayload = { sub: username, exp: now + SESSION_TTL_MS };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = hmac(body, secret).toString('base64url');
  return `${body}.${sig}`;
}

export function verifySessionToken(
  token: string,
  secret: string,
  now = Date.now(),
): SessionPayload | null {
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [body, sig] = parts as [string, string];
  const expected = hmac(body, secret);
  let given: Buffer;
  try {
    given = Buffer.from(sig, 'base64url');
  } catch {
    return null;
  }
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as SessionPayload;
    if (typeof payload.sub !== 'string' || typeof payload.exp !== 'number') return null;
    if (payload.exp <= now) return null;
    return payload;
  } catch {
    return null;
  }
}

/** Constant-time string comparison for credential checks. */
export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ba.length !== bb.length) {
    timingSafeEqual(ba, ba); // keep timing flat-ish
    return false;
  }
  return timingSafeEqual(ba, bb);
}
