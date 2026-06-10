import { z } from 'zod';
import { FlowItemSchema } from './item';
import { NodeIdSchema } from './flow';

/**
 * Execution — one run of a flow for one chat. The heart of pause/resume
 * (invariant I4): everything needed to resume lives here, never only in memory.
 */

export const ExecutionStatusSchema = z.enum(['running', 'waiting', 'done', 'error', 'canceled']);
export type ExecutionStatus = z.infer<typeof ExecutionStatusSchema>;

/**
 * WaitSpec — what a paused execution is waiting for.
 * Stored in executions.wait; matched by the update router (ARCHITECTURE §7).
 */
/**
 * Validation rules carried INSIDE the reply WaitSpec (Decision Log #13):
 * the wait node writes them; the update router enforces them on resume
 * (the executor never re-runs a wait node — resume routes from its ports).
 */
export const ReplyValidationSchema = z.object({
  /** Regex the text must match (expect=text). */
  regex: z.string().optional(),
  /** Numeric range (expect=number) / length range (expect=text). */
  min: z.number().optional(),
  max: z.number().optional(),
});
export type ReplyValidation = z.infer<typeof ReplyValidationSchema>;

export const WaitSpecSchema = z.discriminatedUnion('kind', [
  /** Wait for a user reply (tg.waitForReply). */
  z.object({
    kind: z.literal('reply'),
    nodeId: NodeIdSchema,
    expect: z.enum(['text', 'number', 'photo', 'document', 'contact', 'location', 'any']),
    /** Router-enforced validation (Decision Log #13). */
    validation: ReplyValidationSchema.optional(),
    /** Sent by the router on each failed validation while retries remain. */
    invalidMessage: z.string().optional(),
    retriesLeft: z.number().int().nonnegative().default(0),
    timeoutAt: z.iso.datetime().nullable().default(null),
  }),
  /** Wait for a button click on a specific message (tg.menu). */
  z.object({
    kind: z.literal('callback'),
    nodeId: NodeIdSchema,
    messageId: z.number().int().optional(),
    /** Accepted callback keys → output ports ("btn:<key>"). */
    keys: z.array(z.string().min(1)).min(1),
    timeoutAt: z.iso.datetime().nullable().default(null),
  }),
  /** Durable delay (flow.wait). */
  z.object({
    kind: z.literal('delay'),
    nodeId: NodeIdSchema,
    resumeAt: z.iso.datetime(),
  }),
]);
export type WaitSpec = z.infer<typeof WaitSpecSchema>;

/**
 * ExecutionState — the serialized engine state persisted at WAIT and checkpoints.
 * items = pending input items for the cursor node; vars = $vars scope.
 */
export const ExecutionStateSchema = z.object({
  cursor: NodeIdSchema.nullable(),
  /** Items waiting to enter the cursor node, keyed by its input port. */
  items: z.record(z.string(), z.array(FlowItemSchema)),
  vars: z.record(z.string(), z.unknown()).default({}),
  /** Steps executed so far (loop-safety budget, ARCHITECTURE §7). */
  steps: z.number().int().nonnegative().default(0),
});
export type ExecutionState = z.infer<typeof ExecutionStateSchema>;

export const ExecutionSchema = z.object({
  id: z.string().min(1),
  flowId: z.string().min(1),
  botId: z.string().min(1),
  chatId: z.number().int().nullable(),
  userId: z.string().nullable(),
  status: ExecutionStatusSchema,
  state: ExecutionStateSchema,
  wait: WaitSpecSchema.nullable(),
  error: z.string().nullable().default(null),
  startedAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type Execution = z.infer<typeof ExecutionSchema>;
