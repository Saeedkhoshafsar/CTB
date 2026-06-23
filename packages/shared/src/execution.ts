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
    /**
     * Variable name the validated reply value is saved to on resume
     * ($vars.<saveTo>, Decision Log #14) — applied by the router via
     * Executor.resume({ varsPatch }) because the wait node never re-executes.
     */
    saveTo: z.string().optional(),
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
    /**
     * Per-key button metadata (tg.menu, P2-T6): the router enriches the resume
     * item's `$json.clicked` with label/value from here, because the menu node
     * never re-executes on resume (Decision Log #13 applies to menus too).
     * Optional + additive — waits persisted before P2-T6 still parse.
     */
    buttons: z
      .record(z.string(), z.object({ label: z.string().optional(), value: z.string().optional() }))
      .optional(),
    /** answerCallbackQuery toast shown when a matching button is clicked. */
    answerText: z.string().optional(),
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
  /**
   * This run is a TEST run, started from the editor's "Test run" button (I-T1).
   * Persisted on the state so the flag SURVIVES pause/resume (invariant I4): a
   * test run that pauses at a wait node and later resumes must keep honouring
   * pinned data (`FlowNode.pinnedData`) on the remaining nodes. A production run
   * (router/scheduler/webhook/trigger) leaves this absent → falsy → pinned data
   * is ignored. OPTIONAL (no default) so every persisted ExecutionState from
   * before I-T1 parses byte-identically. Decision Log #21.
   */
  testRun: z.boolean().optional(),
  /**
   * Single-node run boundary (I-T2, gap G16). When set, the executor runs the
   * one node at `cursor` and then ENDS the run instead of routing downstream —
   * the editor's "Run this node" affordance. Persisted on the state so it
   * survives a pause/resume (a single-node run of a wait node reports `waiting`
   * and still stops cleanly). OPTIONAL (no default) so every persisted state
   * from before I-T2 parses byte-identically. A production run leaves it absent.
   * Decision Log #22.
   */
  stopAfterNode: NodeIdSchema.optional(),
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
