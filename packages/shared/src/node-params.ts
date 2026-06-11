import { z } from 'zod';

/**
 * Param schemas for the built-in nodes (invariant I5: one Zod schema in
 * `shared` → server-side validation + editor auto-form + node typing).
 * Wave 1 (P1-T7): tg.trigger, tg.sendMessage, tg.waitForReply,
 * flow.if, data.setFields, flow.stopError — exactly per docs/NODES.md.
 *
 * Param keys are snake_case where NODES.md uses snake_case (save_to,
 * invalid_message, max_retries, notify_user, button_key) so graph JSON
 * reads like the spec.
 */

// ── shared building blocks ───────────────────────────────────────────────────

export const ParseModeSchema = z.enum(['Markdown', 'MarkdownV2', 'HTML']);
export type ParseMode = z.infer<typeof ParseModeSchema>;

/** Inline button: callback → output port "btn:<value>", url/web_app → value is the URL. */
export const InlineButtonSchema = z.object({
  text: z.string().min(1),
  kind: z.enum(['callback', 'url', 'web_app']).default('callback'),
  value: z.string().default(''),
});
export type InlineButton = z.infer<typeof InlineButtonSchema>;

export const KeyboardSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('inline'), rows: z.array(z.array(InlineButtonSchema)).min(1) }),
  z.object({
    kind: z.literal('reply'),
    rows: z.array(z.array(z.string().min(1))).min(1),
    one_time: z.boolean().default(true),
  }),
  z.object({ kind: z.literal('remove') }),
]);
export type Keyboard = z.infer<typeof KeyboardSchema>;

/**
 * Duration strings ("30s", "15m", "2h", "7d"). Parsed by parseDuration in
 * @ctb/nodes; validated here so bad values fail at param-validation time.
 */
export const DurationStringSchema = z
  .string()
  .regex(/^\d+\s*(ms|s|m|h|d)$/, 'expected a duration like "30s", "15m", "2h" or "7d"');

// ── tg.trigger ───────────────────────────────────────────────────────────────

export const TgTriggerParamsSchema = z.object({
  event: z.enum([
    'command',
    'text',
    'button_click',
    'any_message',
    'photo',
    'document',
    'contact',
    'location',
    'chat_join',
  ]),
  /** event=command: "/start" or "start" (router normalizes). */
  command: z.string().optional(),
  /** event=text. */
  pattern: z.string().optional(),
  patternType: z.enum(['exact', 'contains', 'regex']).optional(),
  /** event=button_click: matches Menu buttons marked global. */
  button_key: z.string().optional(),
});
export type TgTriggerParams = z.infer<typeof TgTriggerParamsSchema>;

// ── tg.sendMessage ───────────────────────────────────────────────────────────

export const TgSendMessageParamsSchema = z
  .object({
    /** Target chat id; defaults to the execution's current chat. */
    chat: z.union([z.number(), z.string().min(1)]).optional(),
    type: z.enum(['text', 'photo', 'video', 'document', 'audio', 'sticker']).default('text'),
    /** Message text (type=text) — expressions welcome. */
    text: z.string().optional(),
    /** Caption for media types. */
    caption: z.string().optional(),
    /** Media source: URL | file_id (expression). */
    media: z.string().optional(),
    parse_mode: ParseModeSchema.optional(),
    keyboard: KeyboardSchema.optional(),
    options: z
      .object({
        disable_preview: z.boolean().default(false),
        protect_content: z.boolean().default(false),
        reply_to: z.number().int().optional(),
        silent: z.boolean().default(false),
      })
      .optional(),
  })
  .superRefine((p, ctx) => {
    if (p.type === 'text' && (p.text === undefined || p.text === '')) {
      ctx.addIssue({ code: 'custom', message: 'type "text" requires a non-empty `text`', path: ['text'] });
    }
    if (p.type !== 'text' && (p.media === undefined || p.media === '')) {
      ctx.addIssue({ code: 'custom', message: `type "${p.type}" requires \`media\` (URL or file_id)`, path: ['media'] });
    }
  });
export type TgSendMessageParams = z.infer<typeof TgSendMessageParamsSchema>;

// ── tg.waitForReply ──────────────────────────────────────────────────────────

/** Prompt = plain string or a mini Send Message (text + parse_mode + keyboard). */
export const WaitPromptSchema = z.union([
  z.string().min(1),
  z.object({
    text: z.string().min(1),
    parse_mode: ParseModeSchema.optional(),
    keyboard: KeyboardSchema.optional(),
  }),
]);
export type WaitPrompt = z.infer<typeof WaitPromptSchema>;

export const TgWaitForReplyParamsSchema = z.object({
  /** Optional message sent before pausing. */
  prompt: WaitPromptSchema.optional(),
  expect: z.enum(['text', 'number', 'photo', 'document', 'contact', 'location', 'any']).default('text'),
  /** Router-enforced (Decision Log #13): regex (text), min/max (number value | text length). */
  validation: z
    .object({
      regex: z.string().optional(),
      min: z.number().optional(),
      max: z.number().optional(),
    })
    .optional(),
  /** Sent on each failed validation while retries remain. */
  invalid_message: z.string().optional(),
  /** After this many failed retries → `invalid` port. */
  max_retries: z.number().int().nonnegative().default(0),
  /** Variable name: reply value lands in $vars.<name> (Decision Log #14). */
  save_to: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).optional(),
  /** Duration until the `timeout` port fires (e.g. "15m", "2d"). */
  timeout: DurationStringSchema.optional(),
});
export type TgWaitForReplyParams = z.infer<typeof TgWaitForReplyParamsSchema>;

// ── flow.if ──────────────────────────────────────────────────────────────────

export const IfOperatorSchema = z.enum([
  'equals',
  'notEquals',
  'contains',
  'regex',
  'gt',
  'gte',
  'lt',
  'lte',
  'exists',
  'is_empty',
]);
export type IfOperator = z.infer<typeof IfOperatorSchema>;

export const IfConditionSchema = z.object({
  /** Usually an expression: "{{ $vars.age }}" — already resolved when the node runs. */
  value1: z.unknown(),
  operator: IfOperatorSchema,
  /** Unused for exists / is_empty. */
  value2: z.unknown().optional(),
});
export type IfCondition = z.infer<typeof IfConditionSchema>;

export const FlowIfParamsSchema = z.object({
  conditions: z.array(IfConditionSchema).min(1),
  combine: z.enum(['and', 'or']).default('and'),
});
export type FlowIfParams = z.infer<typeof FlowIfParamsSchema>;

// ── data.setFields ───────────────────────────────────────────────────────────

export const SetFieldRowSchema = z.object({
  name: z.string().min(1),
  /** Any resolved value (expressions already evaluated). Unused for op=remove. */
  value: z.unknown().optional(),
  /** Where the field lands: the item's $json or the execution's $vars. */
  target: z.enum(['json', 'vars']).default('json'),
  op: z.enum(['set', 'remove']).default('set'),
});
export type SetFieldRow = z.infer<typeof SetFieldRowSchema>;

export const DataSetFieldsParamsSchema = z.object({
  fields: z.array(SetFieldRowSchema).min(1),
  /** Drop every json key that wasn't set by this node (json-target rows only). */
  keep_only_set: z.boolean().default(false),
});
export type DataSetFieldsParams = z.infer<typeof DataSetFieldsParamsSchema>;

// ── flow.stopError ───────────────────────────────────────────────────────────

export const FlowStopErrorParamsSchema = z.object({
  message: z.string().min(1),
  /** Also send `message` to the user's chat (when the execution has one). */
  notify_user: z.boolean().default(false),
});
export type FlowStopErrorParams = z.infer<typeof FlowStopErrorParamsSchema>;
