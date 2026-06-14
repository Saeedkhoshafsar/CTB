/**
 * API token helpers (P4-T3, PROTOCOL.md §Inbound REST API).
 *
 * A bearer token authenticates the public `/api/v1/*` surface. We store ONLY a
 * SHA-256 hash of the token — never the plaintext (a DB leak can't replay a
 * token, in the spirit of invariant I7). The token is shown once on creation.
 *
 * Format: `ctb_<base64url(32 random bytes)>` — the `ctb_` prefix makes leaked
 * tokens greppable (GitHub secret-scanning friendly) and the random body is
 * 256 bits of entropy. The stored `prefix` is a short non-secret display
 * fragment (first ~10 chars) so the panel can label a token without revealing it.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** Human-recognizable, greppable token prefix. */
export const API_TOKEN_PREFIX = 'ctb_';

/** Chars of the token kept as a non-secret display fragment (incl. the prefix). */
const DISPLAY_PREFIX_LEN = 10;

/** A freshly minted token: the plaintext (shown once), its hash + display prefix. */
export interface GeneratedApiToken {
  token: string;
  tokenHash: string;
  prefix: string;
}

/** Hash a plaintext token for storage / lookup (SHA-256 hex, stable). */
export function hashApiToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** The non-secret display fragment for a token (first chars + ellipsis marker). */
export function apiTokenPrefix(token: string): string {
  return token.slice(0, DISPLAY_PREFIX_LEN);
}

/** Mint a new token + its at-rest hash + display prefix. */
export function generateApiToken(): GeneratedApiToken {
  const token = API_TOKEN_PREFIX + randomBytes(32).toString('base64url');
  return { token, tokenHash: hashApiToken(token), prefix: apiTokenPrefix(token) };
}

/**
 * Extract a bearer token from an Authorization header. Accepts `Bearer <tok>`
 * (case-insensitive scheme); returns null when absent/malformed.
 */
export function parseBearer(authHeader: string | string[] | undefined): string | null {
  const raw = Array.isArray(authHeader) ? authHeader[0] : authHeader;
  if (!raw) return null;
  const m = /^Bearer\s+(.+)$/i.exec(raw.trim());
  if (!m) return null;
  const token = m[1]!.trim();
  return token === '' ? null : token;
}

/** Constant-time compare of two equal-purpose hash hex strings. */
export function hashesEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ba.length !== bb.length) {
    timingSafeEqual(ba, ba); // keep timing flat-ish
    return false;
  }
  return timingSafeEqual(ba, bb);
}
