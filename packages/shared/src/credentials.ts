/**
 * Credentials contract (PLAN P3-T4) — encrypted secret store + the public DTOs
 * shared by the Fastify server (validation) and the editor's typed client
 * (invariant I5). The SECRET HALF of every credential is encrypted at rest
 * (AES-256-GCM, invariant I7) and NEVER returned in plaintext by the API —
 * responses carry only a `*Public` projection with a masked hint.
 *
 * v1 ships the three auth shapes the HTTP Request node needs. New types are
 * added by extending CredentialDataSchema's discriminated union — the resolver
 * (server) and the editor form switch exhaustively on `type`.
 */
import { z } from 'zod';

// ---------------------------------------------------------------------------
// credential data — the SECRET payload (encrypted at rest, never returned)
// ---------------------------------------------------------------------------

/** API key sent as a custom header, e.g. `X-API-Key: <key>`. */
export const HttpHeaderAuthSchema = z.object({
  type: z.literal('httpHeaderAuth'),
  /** Header name (default "Authorization" is rarely what you want for keys). */
  headerName: z.string().min(1).max(120),
  /** The secret value placed verbatim into that header. */
  headerValue: z.string().min(1),
});
export type HttpHeaderAuth = z.infer<typeof HttpHeaderAuthSchema>;

/** Bearer token → `Authorization: Bearer <token>`. */
export const HttpBearerAuthSchema = z.object({
  type: z.literal('httpBearerAuth'),
  token: z.string().min(1),
});
export type HttpBearerAuth = z.infer<typeof HttpBearerAuthSchema>;

/** HTTP Basic auth → `Authorization: Basic base64(user:pass)`. */
export const HttpBasicAuthSchema = z.object({
  type: z.literal('httpBasicAuth'),
  username: z.string().min(1),
  password: z.string().min(1),
});
export type HttpBasicAuth = z.infer<typeof HttpBasicAuthSchema>;

/** The encrypted half of every credential — discriminated by `type`. */
export const CredentialDataSchema = z.discriminatedUnion('type', [
  HttpHeaderAuthSchema,
  HttpBearerAuthSchema,
  HttpBasicAuthSchema,
]);
export type CredentialData = z.infer<typeof CredentialDataSchema>;

export const CredentialTypeSchema = z.enum([
  'httpHeaderAuth',
  'httpBearerAuth',
  'httpBasicAuth',
]);
export type CredentialType = z.infer<typeof CredentialTypeSchema>;

// ---------------------------------------------------------------------------
// request bodies
// ---------------------------------------------------------------------------

export const CreateCredentialBodySchema = z.object({
  name: z.string().min(1).max(120),
  data: CredentialDataSchema,
});
export type CreateCredentialBody = z.infer<typeof CreateCredentialBodySchema>;

/**
 * Update: rename and/or replace the secret. `data.type` must match the existing
 * credential's type (the server rejects type changes — delete + recreate
 * instead, so a node's `credentialId` never silently points at a new shape).
 */
export const UpdateCredentialBodySchema = z
  .object({
    name: z.string().min(1).max(120).optional(),
    data: CredentialDataSchema.optional(),
  })
  .refine((b) => b.name !== undefined || b.data !== undefined, {
    message: 'nothing to update',
  });
export type UpdateCredentialBody = z.infer<typeof UpdateCredentialBodySchema>;

// ---------------------------------------------------------------------------
// public DTO — what the API returns (NO secret material, invariant I7)
// ---------------------------------------------------------------------------

/**
 * Public projection of a credential. The secret payload never appears; instead
 * a `hint` summarises it for display (e.g. "X-API-Key: ••••cdef").
 */
export interface CredentialPublic {
  id: string;
  name: string;
  type: CredentialType;
  /** Masked, display-only summary of the secret — never reversible. */
  hint: string;
  createdAt: string;
  updatedAt: string;
}

/** Human label per type — used by the editor's type picker + list badges. */
export const CREDENTIAL_TYPE_LABELS: Record<CredentialType, string> = {
  httpHeaderAuth: 'HTTP Header Auth',
  httpBearerAuth: 'HTTP Bearer Token',
  httpBasicAuth: 'HTTP Basic Auth',
};

/**
 * Build the display hint from a credential's secret data. Pure + reversible-safe
 * (only ever exposes the last few chars). Shared so server DTOs and any tooling
 * mask identically.
 */
export function credentialHint(data: CredentialData): string {
  const mask = (s: string): string => {
    const tail = s.slice(-4);
    return s.length <= 4 ? '••••' : `••••${tail}`;
  };
  switch (data.type) {
    case 'httpHeaderAuth':
      return `${data.headerName}: ${mask(data.headerValue)}`;
    case 'httpBearerAuth':
      return `Bearer ${mask(data.token)}`;
    case 'httpBasicAuth':
      return `${data.username}:${mask(data.password)}`;
  }
}

/**
 * UTF-8-safe base64 — isomorphic so this module stays free of Node `Buffer`
 * (shared is also compiled for the browser bundle). Encodes the string as
 * UTF-8 bytes first, then base64s the byte string via the global `btoa`,
 * which is present in both Node 18+ and browsers.
 */
function base64Utf8(input: string): string {
  const bytes = new TextEncoder().encode(input);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

/**
 * Turn a credential's secret into the HTTP headers it injects. Pure — the host
 * (server `wireEngine`) calls this AFTER decrypting; the node never sees the
 * secret, it only knows the `credentialId` (invariant I7). Returns lower-case
 * header keys so callers can merge case-insensitively.
 */
export function credentialAuthHeaders(data: CredentialData): Record<string, string> {
  switch (data.type) {
    case 'httpHeaderAuth':
      return { [data.headerName.toLowerCase()]: data.headerValue };
    case 'httpBearerAuth':
      return { authorization: `Bearer ${data.token}` };
    case 'httpBasicAuth': {
      return { authorization: `Basic ${base64Utf8(`${data.username}:${data.password}`)}` };
    }
  }
}
