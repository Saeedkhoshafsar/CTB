/**
 * REST API contract (P2-T1) — request bodies + public DTOs shared by the
 * Fastify server (validation) and the editor's typed client (invariant I5:
 * ONE Zod schema per shape; server and editor can never drift apart).
 *
 * DTO rule: `*Public` types describe exactly what the server returns —
 * e.g. bots carry a masked `tokenHint`, NEVER the token (invariant I7).
 */
import { z } from 'zod';
import { FlowGraphSchema } from './flow';

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
// error envelope (shared shape of every non-2xx body)
// ---------------------------------------------------------------------------

export interface ApiErrorBody {
  error: string;
  /** Zod issues on 400 invalid_body; human strings on 422 activation problems. */
  issues?: unknown[];
  problems?: string[];
}
