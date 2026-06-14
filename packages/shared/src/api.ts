/**
 * REST API contract (P2-T1) — request bodies + public DTOs shared by the
 * Fastify server (validation) and the editor's typed client (invariant I5:
 * ONE Zod schema per shape; server and editor can never drift apart).
 *
 * DTO rule: `*Public` types describe exactly what the server returns —
 * e.g. bots carry a masked `tokenHint`, NEVER the token (invariant I7).
 */
import { z } from 'zod';
import type { ExecutionStatus, WaitSpec } from './execution';
import { FlowGraphSchema } from './flow';
import type { FlowItem } from './item';
import { KeyboardSchema } from './node-params';

// ---------------------------------------------------------------------------
// auth
// ---------------------------------------------------------------------------

export const LoginBodySchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});
export type LoginBody = z.infer<typeof LoginBodySchema>;

/** Panel role (P3.5-T2): admin sees everything; operator sees only the Data section. */
export type SessionRole = 'admin' | 'operator';

export interface SessionUser {
  username: string;
  /** Optional for back-compat with pre-P3.5-T2 clients; defaults to 'admin'. */
  role?: SessionRole;
}

// ---------------------------------------------------------------------------
// bots
// ---------------------------------------------------------------------------

/** Loose Telegram token shape: "<digits>:<35-ish chars>". Keeps fakes testable. */
export const TgTokenSchema = z
  .string()
  .regex(/^\d+:[\w-]{20,}$/, 'must look like a Telegram bot token ("123456:ABC-…")');

export const BotModeSchema = z.enum(['webhook', 'polling']);
export type BotMode = z.infer<typeof BotModeSchema>;

export const BotStatusSchema = z.enum(['active', 'inactive', 'error']);
export type BotStatus = z.infer<typeof BotStatusSchema>;

export const CreateBotBodySchema = z.object({
  name: z.string().min(1).max(120),
  token: TgTokenSchema,
  mode: BotModeSchema.default('polling'),
  settings: z.record(z.string(), z.unknown()).default({}),
});
export type CreateBotBody = z.infer<typeof CreateBotBodySchema>;

export const UpdateBotBodySchema = z.object({
  name: z.string().min(1).max(120).optional(),
  token: TgTokenSchema.optional(),
  mode: BotModeSchema.optional(),
  settings: z.record(z.string(), z.unknown()).optional(),
});
export type UpdateBotBody = z.infer<typeof UpdateBotBodySchema>;

/** What GET /api/bots returns per row. The raw token NEVER appears (I7). */
export interface BotPublic {
  id: string;
  name: string;
  /** Masked hint like "1234567890:AAE…xyz" — display only. */
  tokenHint: string;
  mode: BotMode;
  status: BotStatus;
  settings: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// flows
// ---------------------------------------------------------------------------

export const FlowStatusSchema = z.enum(['draft', 'active', 'inactive']);
export type FlowStatus = z.infer<typeof FlowStatusSchema>;

/**
 * Execution policy (P3-T6, ARCHITECTURE §4) — what happens when a NEW trigger
 * fires for a (flow, chat) that already has a WAITING execution:
 *  - replace (default): cancel the waiting run, start the new one
 *  - ignore: drop the new trigger, keep the waiting run untouched
 *  - queue: park the new trigger; run it once the waiting run finishes
 */
export const ExecutionPolicySchema = z.enum(['replace', 'ignore', 'queue']);
export type ExecutionPolicy = z.infer<typeof ExecutionPolicySchema>;

/**
 * Per-flow settings (P3-T6) — stored in flows.settings, edited from the flow
 * editor's settings panel. Kept SEPARATE from the graph (graph = nodes/edges
 * only). `errorHandlerFlowId` names another flow OF THE SAME BOT to run when
 * this flow's execution ends in error (the host enforces the same-bot guard).
 */
export const FlowSettingsSchema = z.object({
  executionPolicy: ExecutionPolicySchema.default('replace'),
  errorHandlerFlowId: z.string().min(1).nullable().default(null),
});
export type FlowSettings = z.infer<typeof FlowSettingsSchema>;

/** Defaults used when a flow has no stored settings yet. */
export function defaultFlowSettings(): FlowSettings {
  return { executionPolicy: 'replace', errorHandlerFlowId: null };
}

export function emptyFlowGraph(): z.infer<typeof FlowGraphSchema> {
  return { nodes: [], edges: [] };
}

export const CreateFlowBodySchema = z.object({
  botId: z.string().min(1),
  name: z.string().min(1).max(200),
  graph: FlowGraphSchema.default(emptyFlowGraph),
});
export type CreateFlowBody = z.infer<typeof CreateFlowBodySchema>;

export const UpdateFlowBodySchema = z.object({
  name: z.string().min(1).max(200).optional(),
  graph: FlowGraphSchema.optional(),
  /** Per-flow execution policy + error-handler (P3-T6). */
  settings: FlowSettingsSchema.optional(),
});
export type UpdateFlowBody = z.infer<typeof UpdateFlowBodySchema>;

/**
 * POST /api/flows/import (P3-T7) — create a NEW flow from an export envelope.
 * `export` is validated against FlowExportSchema server-side; `name` lets the
 * importer override the envelope's name (e.g. "Quiz" → "Quiz (copy)").
 */
export const ImportFlowBodySchema = z.object({
  botId: z.string().min(1),
  /** The portable envelope (validated by FlowExportSchema in the import route). */
  export: z.unknown(),
  /** Optional name override; falls back to the envelope's own name. */
  name: z.string().min(1).max(200).optional(),
});
export type ImportFlowBody = z.infer<typeof ImportFlowBodySchema>;

/**
 * POST /api/flows/import-template (P3-T7) — create a NEW flow from a gallery
 * template by its stable id (feedback/quiz/faq/reminder).
 */
export const ImportTemplateBodySchema = z.object({
  botId: z.string().min(1),
  templateId: z.string().min(1),
  name: z.string().min(1).max(200).optional(),
});
export type ImportTemplateBody = z.infer<typeof ImportTemplateBodySchema>;

/**
 * POST /api/collection-packs/import (P3.5-T6) — install a starter pack by its
 * stable id: create every collection in the pack (skipping ones whose slug is
 * already taken) then import every flow. One bot-scoped call sets up the whole
 * "browse → order → notify" demo.
 */
export const ImportPackBodySchema = z.object({
  botId: z.string().min(1),
  packId: z.string().min(1),
});
export type ImportPackBody = z.infer<typeof ImportPackBodySchema>;

/** What GET /api/flows returns per row. */
export interface FlowPublic {
  id: string;
  botId: string;
  name: string;
  status: FlowStatus;
  graph: z.infer<typeof FlowGraphSchema>;
  /** Per-flow execution policy + error-handler (P3-T6). */
  settings: FlowSettings;
  version: number;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// flow lifecycle (P2-T4 — versions, rollback, activation problems)
// ---------------------------------------------------------------------------

export const RollbackFlowBodySchema = z.object({
  /** Snapshot version to restore (must exist in flow_versions). */
  version: z.number().int().min(1),
});
export type RollbackFlowBody = z.infer<typeof RollbackFlowBodySchema>;

/**
 * One activation problem. `nodeId` points the canvas at the offending node
 * (badge); null = flow-level (e.g. "no enabled trigger").
 */
export interface FlowProblem {
  nodeId: string | null;
  message: string;
}

/**
 * GET /api/flows/:id/versions row — node/edge COUNTS instead of the full
 * graph so the list stays cheap; the graph itself only travels on rollback
 * (server-side restore).
 */
export interface FlowVersionInfo {
  version: number;
  createdAt: string;
  nodeCount: number;
  edgeCount: number;
}

// ---------------------------------------------------------------------------
// node types (GET /api/node-types — palette + param forms, P2-T2)
// ---------------------------------------------------------------------------

/**
 * Serializable projection of a NodeDef for the editor. `paramsJsonSchema` is
 * the Zod schema converted to JSON Schema (z.toJSONSchema) — the canvas needs
 * ports/meta now; the P2-T3 form engine will consume the schema.
 *
 * Note: nodes with `dynamicOutputs` (Menu/Switch, P2-T6) additionally compute
 * ports from params client-side; `ports.outputs` here is the static base.
 */
export interface NodeTypeInfo {
  type: string;
  category: 'trigger' | 'telegram' | 'flow' | 'data' | 'ai';
  meta: { labelKey: string; descriptionKey?: string; icon?: string };
  ports: { inputs: string[]; outputs: string[] };
  paramsJsonSchema: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// executions (GET /api/executions — inspector + editor node detail view)
// ---------------------------------------------------------------------------

/** List row — no state/log payloads (those ride the detail endpoint). */
export interface ExecutionSummary {
  id: string;
  flowId: string;
  botId: string;
  chatId: number | null;
  status: ExecutionStatus;
  error: string | null;
  startedAt: string;
  updatedAt: string;
}

/**
 * One exec_logs row. `input`/`output` are the capped FlowItem snapshots the
 * executor records per "executed" step (P2-T3.5) — the editor's node detail
 * view renders them as the n8n-style INPUT/OUTPUT panes.
 */
export interface ExecLogEntry {
  id: number;
  nodeId: string | null;
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
  input: FlowItem[] | null;
  output: Record<string, FlowItem[]> | null;
  error: string | null;
  durationMs: number | null;
  ts: string;
}

/** GET /api/executions/:id — summary + wait detail + full step log. */
export interface ExecutionDetail extends ExecutionSummary {
  wait: WaitSpec | null;
  logs: ExecLogEntry[];
}

// ---------------------------------------------------------------------------
// manual test run (POST /api/flows/:id/run — P2-T7)
// ---------------------------------------------------------------------------

/**
 * Result of a manual test run started at a flow.manualTrigger node. The run
 * executes synchronously up to the first WAIT / end / error; the editor then
 * loads the execution detail (logs incl. Code-node console output) by id.
 */
export interface RunFlowResult {
  executionId: string;
  status: ExecutionStatus;
  error: string | null;
}

// ---------------------------------------------------------------------------
// users (Users page — P3-T5)
// ---------------------------------------------------------------------------

/**
 * UserPublic — a per-bot end-user record as the API returns it. GENERIC by
 * construction (invariant I2): `profile` is a free-form bag, `tags` are plain
 * labels — no domain field is ever baked in. `displayName` is a best-effort
 * convenience derived from the mirrored Telegram profile (first_name/username),
 * computed server-side so the editor needn't know the mirror keys.
 */
export interface UserPublic {
  id: string;
  botId: string;
  tgUserId: number;
  profile: Record<string, unknown>;
  tags: string[];
  firstSeen: string;
  lastSeen: string;
  /** Best-effort label from profile (first_name + last_name, else @username, else the id). */
  displayName: string;
}

/**
 * Best-effort display label for a user, from the mirrored Telegram identity in
 * the profile bag: "first_name last_name", else "@username", else "#<tgUserId>".
 * Shared so server and editor render the same label (invariant I5).
 */
export function userDisplayName(u: {
  tgUserId: number;
  profile: Record<string, unknown>;
}): string {
  const first = typeof u.profile.first_name === 'string' ? u.profile.first_name.trim() : '';
  const last = typeof u.profile.last_name === 'string' ? u.profile.last_name.trim() : '';
  const full = `${first} ${last}`.trim();
  if (full !== '') return full;
  const uname = typeof u.profile.username === 'string' ? u.profile.username.trim() : '';
  if (uname !== '') return `@${uname}`;
  return `#${u.tgUserId}`;
}

/** PATCH /api/users/:id — operator edits to tags / profile (both optional, ≥1 required). */
export const UpdateUserBodySchema = z
  .object({
    tags: z.array(z.string().min(1)).optional(),
    profile: z.record(z.string(), z.unknown()).optional(),
  })
  .refine((b) => b.tags !== undefined || b.profile !== undefined, {
    message: 'nothing to update — provide tags and/or profile',
  });
export type UpdateUserBody = z.infer<typeof UpdateUserBodySchema>;

// ---------------------------------------------------------------------------
// public REST API — bearer tokens + v1 surface (P4-T3, PROTOCOL.md §Inbound REST API)
// ---------------------------------------------------------------------------

/**
 * Create an API token (admin-only). `botId` scopes the token to one bot; omit
 * for an instance-wide token. The plaintext token is returned ONCE in the
 * create response and never again (only its hash is stored).
 */
export const CreateApiTokenBodySchema = z.object({
  name: z.string().min(1).max(120),
  /** Optional bot scope; omit/null = instance-wide (all bots & flows). */
  botId: z.string().min(1).nullish(),
});
export type CreateApiTokenBody = z.infer<typeof CreateApiTokenBodySchema>;

/** Public projection of an API token — NEVER carries the secret, only a prefix. */
export interface ApiTokenPublic {
  id: string;
  name: string;
  /** Non-secret display fragment, e.g. "ctb_a1b2c3…". */
  prefix: string;
  /** Bot scope, or null for instance-wide. */
  botId: string | null;
  createdAt: string;
  lastUsedAt: string | null;
}

/** The create response — the ONLY time the full plaintext token is revealed. */
export interface ApiTokenCreated extends ApiTokenPublic {
  /** Full plaintext bearer token. Shown once; store it now. */
  token: string;
}

/**
 * `POST /api/v1/flows/:id/trigger` — start a flow run via the public API.
 * `chat_id` (optional) gives the run a chat (Telegram nodes default to it);
 * omitted ⇒ a chatless run (the flow resolves its own chat, like a webhook).
 * `payload` (optional) becomes the trigger item's `$json.payload`.
 */
export const TriggerFlowBodySchema = z.object({
  chat_id: z.union([z.number().int(), z.string().min(1)]).optional(),
  payload: z.unknown().optional(),
});
export type TriggerFlowBody = z.infer<typeof TriggerFlowBodySchema>;

/**
 * `POST /api/v1/bots/:id/send` — send a Telegram message through a bot's
 * centralized rate-limited sender (no raw token ever crosses the API edge).
 */
export const ApiSendMessageBodySchema = z.object({
  chat_id: z.union([z.number().int(), z.string().min(1)]),
  text: z.string().min(1).max(4096 * 4),
  parse_mode: z.enum(['HTML', 'MarkdownV2']).optional(),
  /** Reuses the node keyboard schema (inline/reply/remove) — one shape (I5). */
  keyboard: KeyboardSchema.optional(),
});
export type ApiSendMessageBody = z.infer<typeof ApiSendMessageBodySchema>;

// ---------------------------------------------------------------------------
// error envelope (shared shape of every non-2xx body)
// ---------------------------------------------------------------------------

export interface ApiErrorBody {
  error: string;
  /** Zod issues on 400 invalid_body; human strings on 422 activation problems. */
  issues?: unknown[];
  problems?: string[];
  /** Structured activation problems (P2-T4) — lets the canvas badge the offending node. */
  nodeProblems?: FlowProblem[];
}
