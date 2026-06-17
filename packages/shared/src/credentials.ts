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

/**
 * OpenAI-compatible API credential (P5-T1). One shape serves OpenAI, OpenRouter,
 * Anthropic-via-proxy, Groq, Together, a local LM-Studio/Ollama gateway… — all
 * of them speak the same `POST {baseUrl}/chat/completions` protocol, so the only
 * thing that varies is the base URL and the key. The host (`ctx.ai`) appends the
 * standard path; the user supplies the ROOT (e.g. `https://api.openai.com/v1`).
 * Both halves are encrypted at rest (invariant I7) and never reach node code.
 */
export const OpenAiApiSchema = z.object({
  type: z.literal('openAiApi'),
  /** API root, WITHOUT a trailing `/chat/completions` (e.g. `https://api.openai.com/v1`). */
  baseUrl: z.string().url().max(2048),
  /** The bearer key sent as `Authorization: Bearer <apiKey>`. */
  apiKey: z.string().min(1),
});
export type OpenAiApi = z.infer<typeof OpenAiApiSchema>;

/**
 * MCP server credential (P5-T3). Points at a remote Model-Context-Protocol
 * server reached over **streamable-HTTP** (one JSON-RPC POST endpoint) — the
 * shape ships its standard transports (SSE/stdio-over-http per NODES.md) speak
 * the same JSON-RPC envelope, so the only thing that varies is the endpoint URL
 * and an optional bearer key. The host (`ctx.mcp`) performs the `tools/list` and
 * `tools/call` requests; the decrypted key never reaches node code (I6/I7).
 */
export const McpServerSchema = z.object({
  type: z.literal('mcpServer'),
  /** The MCP server's JSON-RPC endpoint (e.g. `https://mcp.example.com/mcp`). */
  url: z.string().url().max(2048),
  /** Optional bearer token sent as `Authorization: Bearer <apiKey>`. */
  apiKey: z.string().optional(),
});
export type McpServer = z.infer<typeof McpServerSchema>;

/**
 * Postgres database connection credential (PB-T2). Selected by the `db.postgres`
 * node; the host (`ctx.db`) owns the connection pool (invariant I3 — the `pg`
 * driver lives only in `apps/server`), so the node only ever passes a
 * `credentialId` and never sees the host/password (invariants I6/I7). All fields
 * are encrypted at rest. A `connectionString` (a `postgres://…` URI) may be
 * given INSTEAD of the discrete fields; when both are present the host prefers
 * the connection string.
 */
export const PostgresSchema = z.object({
  type: z.literal('postgres'),
  /** Full `postgres://user:pass@host:port/db` URI — wins over the discrete fields. */
  connectionString: z.string().max(2048).optional(),
  host: z.string().max(255).optional(),
  /** TCP port (default 5432 applied host-side). */
  port: z.coerce.number().int().min(1).max(65535).optional(),
  database: z.string().max(255).optional(),
  user: z.string().max(255).optional(),
  password: z.string().optional(),
  /** Require TLS to the server (default false). */
  ssl: z.boolean().default(false),
});
export type Postgres = z.infer<typeof PostgresSchema>;

/**
 * MySQL / MariaDB database connection credential (PB-T3). The mirror of
 * `PostgresSchema` for the `db.mysql` node; the host (`ctx.db`) owns the
 * connection pool (invariant I3 — the `mysql2` driver lives only in
 * `apps/server`), so the node only ever passes a `credentialId` and never sees
 * the host/password (invariants I6/I7). All fields encrypted at rest. A
 * `connectionString` (a `mysql://…` URI) may be given INSTEAD of the discrete
 * fields; when both are present the host prefers the connection string.
 */
export const MysqlSchema = z.object({
  type: z.literal('mysql'),
  /** Full `mysql://user:pass@host:port/db` URI — wins over the discrete fields. */
  connectionString: z.string().max(2048).optional(),
  host: z.string().max(255).optional(),
  /** TCP port (default 3306 applied host-side). */
  port: z.coerce.number().int().min(1).max(65535).optional(),
  database: z.string().max(255).optional(),
  user: z.string().max(255).optional(),
  password: z.string().optional(),
  /** Require TLS to the server (default false). */
  ssl: z.boolean().default(false),
});
export type Mysql = z.infer<typeof MysqlSchema>;

/** The encrypted half of every credential — discriminated by `type`. */
export const CredentialDataSchema = z.discriminatedUnion('type', [
  HttpHeaderAuthSchema,
  HttpBearerAuthSchema,
  HttpBasicAuthSchema,
  OpenAiApiSchema,
  McpServerSchema,
  PostgresSchema,
  MysqlSchema,
]);
export type CredentialData = z.infer<typeof CredentialDataSchema>;

export const CredentialTypeSchema = z.enum([
  'httpHeaderAuth',
  'httpBearerAuth',
  'httpBasicAuth',
  'openAiApi',
  'mcpServer',
  'postgres',
  'mysql',
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
  openAiApi: 'OpenAI-compatible API',
  mcpServer: 'MCP Server',
  postgres: 'Postgres Database',
  mysql: 'MySQL / MariaDB Database',
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
    case 'openAiApi':
      return `${data.baseUrl} · ${mask(data.apiKey)}`;
    case 'mcpServer':
      return data.apiKey ? `${data.url} · ${mask(data.apiKey)}` : data.url;
    case 'postgres': {
      if (data.connectionString) {
        // Show host/db when parseable; never the password.
        try {
          const u = new URL(data.connectionString);
          const db = u.pathname.replace(/^\//, '');
          return `${u.hostname}${u.port ? `:${u.port}` : ''}/${db || '?'}`;
        } catch {
          return 'postgres://••••';
        }
      }
      const host = data.host ?? '?';
      const port = data.port ?? 5432;
      const db = data.database ?? '?';
      return `${host}:${port}/${db}`;
    }
    case 'mysql': {
      if (data.connectionString) {
        try {
          const u = new URL(data.connectionString);
          const db = u.pathname.replace(/^\//, '');
          return `${u.hostname}${u.port ? `:${u.port}` : ''}/${db || '?'}`;
        } catch {
          return 'mysql://••••';
        }
      }
      const host = data.host ?? '?';
      const port = data.port ?? 3306;
      const db = data.database ?? '?';
      return `${host}:${port}/${db}`;
    }
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
    case 'openAiApi':
      return { authorization: `Bearer ${data.apiKey}` };
    case 'mcpServer':
      return data.apiKey ? { authorization: `Bearer ${data.apiKey}` } : {};
    case 'postgres':
    case 'mysql':
      // A database connection injects no HTTP headers — it's resolved into a
      // connection pool host-side (ctx.db), not into request headers.
      return {};
  }
}
