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

// ---------------------------------------------------------------------------
// auth
// ---------------------------------------------------------------------------

export const LoginBodySchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});
export type LoginBody = z.infer<typeof LoginBodySchema>;

export interface SessionUser {
  username: string;
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
});
export type UpdateFlowBody = z.infer<typeof UpdateFlowBodySchema>;

/** What GET /api/flows returns per row. */
export interface FlowPublic {
  id: string;
  botId: string;
  name: string;
  status: FlowStatus;
  graph: z.infer<typeof FlowGraphSchema>;
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
