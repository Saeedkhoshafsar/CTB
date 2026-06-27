/**
 * Stateless signed-cookie sessions (v1 single-admin panel auth — ARCHITECTURE §11).
 * Token format: base64url(payload-json).base64url(hmac-sha256(payload)).
 * No server-side session table needed; expiry lives inside the signed payload.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

/** Panel roles. `operator` (P3.5-T2, the manager) sees ONLY the Data section —
 * records/files of Collections; `admin` sees everything; `owner` (K-T1) is a
 * strict superset of `admin` (the single account-owner, with store-enforced
 * invariants). Precedence: `owner` ⊇ `admin` ⊇ `operator`. */
export type SessionRole = 'owner' | 'admin' | 'operator';

/** Role precedence, low→high (K-T1). Mirrors `@ctb/shared` ROLE_ORDER. */
const ROLE_ORDER: readonly SessionRole[] = ['operator', 'admin', 'owner'];

/**
 * Pure role gate (K-T1): is `role` at least as privileged as `min`?
 * `owner` satisfies any minimum; `operator` satisfies only `operator`. An
 * unknown/legacy value is treated as `operator` (least privilege) so a
 * malformed token can never escalate.
 */
export function roleAtLeast(role: SessionRole, min: SessionRole): boolean {
  const r = ROLE_ORDER.indexOf(role);
  const m = ROLE_ORDER.indexOf(min);
  return (r < 0 ? 0 : r) >= (m < 0 ? 0 : m);
}

export interface SessionPayload {
  /** Username the session belongs to. */
  sub: string;
  /** Panel role. Older tokens (pre-P3.5-T2) lack it → treated as `admin`. */
  role: SessionRole;
  /**
   * Telegram user id the session is bound to (K-T2), as a numeric string —
   * present when the session was created against a `panel_admins` identity (or
   * the bootstrapped owner). OPTIONAL for back-compat: legacy env-only sessions
   * have no Telegram identity and omit it. `transfer-owner` needs it to match
   * the caller against the store's owner row.
   */
  tg?: string;
  /** Unix ms expiry. */
  exp: number;
}

export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function hmac(data: string, secret: string): Buffer {
  return createHmac('sha256', `ctb-session-v1:${secret}`).update(data).digest();
}

export function createSessionToken(
  username: string,
  secret: string,
  role: SessionRole = 'admin',
  now = Date.now(),
  /** Telegram user id to bind the session to (K-T2). Omitted ⇒ no `tg` claim. */
  tg?: string,
): string {
  const payload: SessionPayload = { sub: username, role, exp: now + SESSION_TTL_MS };
  if (tg) payload.tg = tg;
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
    // Drop a malformed `tg` claim rather than trusting it (K-T2).
    if (payload.tg !== undefined && typeof payload.tg !== 'string') {
      delete payload.tg;
    }
    // Back-compat: tokens minted before roles existed are admins. A token
    // carrying any unknown role string is normalised to `admin` too (K-T1
    // widened the set to include `owner`, which stays valid here).
    if (
      payload.role !== 'owner' &&
      payload.role !== 'admin' &&
      payload.role !== 'operator'
    ) {
      payload.role = 'admin';
    }
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
