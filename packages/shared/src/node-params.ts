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

// ════════════════════════════════════════════════════════════════════════════
// Wave 2 (P2-T6): tg.menu, flow.switch, flow.wait, http.request, data.kv,
// flow.manualTrigger — exactly per docs/NODES.md.
// ════════════════════════════════════════════════════════════════════════════

// ── tg.menu ──────────────────────────────────────────────────────────────────

/** One menu button: key → output port "btn:<key>"; value rides the clicked item. */
export const MenuButtonSchema = z.object({
  /** Button caption shown to the user. */
  text: z.string().min(1),
  /** Port key — must satisfy PortName chars; "btn:<key>" becomes the edge port. */
  key: z.string().regex(/^[A-Za-z0-9_.-]{1,48}$/, 'letters/digits/_/./- only'),
  /** Optional payload carried to the branch as $json.clicked.value. */
  value: z.string().optional(),
});
export type MenuButton = z.infer<typeof MenuButtonSchema>;

export const TgMenuParamsSchema = z.object({
  text: z.string().min(1),
  parse_mode: ParseModeSchema.optional(),
  /** Button grid: rows of buttons; each button is an output port. */
  buttons: z.array(z.array(MenuButtonSchema).min(1)).min(1),
  /** Edit the previous menu message in place instead of sending a new one. */
  edit_in_place: z.boolean().default(false),
  /** Toast shown by answerCallbackQuery when a button is clicked. */
  answer_callback_text: z.string().optional(),
  /** Duration until the `timeout` port fires. */
  timeout: DurationStringSchema.optional(),
});
export type TgMenuParams = z.infer<typeof TgMenuParamsSchema>;

/** Output ports of a menu instance: one per button (+ timeout when set), deduped. */
export function menuOutputs(params: TgMenuParams): string[] {
  const ports = [...new Set(params.buttons.flat().map((b) => `btn:${b.key}`))];
  if (params.timeout) ports.push('timeout');
  return ports;
}

// ── flow.switch ──────────────────────────────────────────────────────────────

export const SwitchRuleSchema = z.object({
  /** Output port name for this rule. */
  port: z.string().regex(/^[A-Za-z0-9_.-]{1,48}$/, 'letters/digits/_/./- only'),
  /** Compared against `value` — usually an expression result. */
  match: z.unknown(),
  operator: IfOperatorSchema.default('equals'),
});
export type SwitchRule = z.infer<typeof SwitchRuleSchema>;

export const FlowSwitchParamsSchema = z.object({
  /** The inspected value — usually "{{ $json.kind }}" (resolved before run). */
  value: z.unknown(),
  rules: z.array(SwitchRuleSchema).min(1),
});
export type FlowSwitchParams = z.infer<typeof FlowSwitchParamsSchema>;

/** Output ports of a switch instance: one per rule + default, deduped. */
export function switchOutputs(params: FlowSwitchParams): string[] {
  return [...new Set(params.rules.map((r) => r.port)), 'default'];
}

// ── flow.wait (durable delay) ────────────────────────────────────────────────

export const FlowWaitParamsSchema = z
  .object({
    mode: z.enum(['duration', 'until']).default('duration'),
    /** mode=duration: "30s" … "7d". */
    duration: DurationStringSchema.optional(),
    /** mode=until: ISO datetime (usually an expression). */
    until: z.string().optional(),
  })
  .superRefine((p, ctx) => {
    if (p.mode === 'duration' && !p.duration) {
      ctx.addIssue({ code: 'custom', message: 'mode "duration" requires `duration`', path: ['duration'] });
    }
    if (p.mode === 'until' && !p.until) {
      ctx.addIssue({ code: 'custom', message: 'mode "until" requires `until`', path: ['until'] });
    }
  });
export type FlowWaitParams = z.infer<typeof FlowWaitParamsSchema>;

// ── http.request ─────────────────────────────────────────────────────────────

export const HttpKeyValueRowSchema = z.object({
  name: z.string().min(1),
  value: z.string().default(''),
});
export type HttpKeyValueRow = z.infer<typeof HttpKeyValueRowSchema>;

export const HttpRequestParamsSchema = z
  .object({
    method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']).default('GET'),
    url: z.string().min(1),
    query: z.array(HttpKeyValueRowSchema).optional(),
    headers: z.array(HttpKeyValueRowSchema).optional(),
    body_type: z.enum(['none', 'json', 'form', 'raw']).default('none'),
    /** body_type=json|raw: the payload (expressions welcome). */
    body: z.string().optional(),
    /** body_type=form: name=value rows, urlencoded. */
    form: z.array(HttpKeyValueRowSchema).optional(),
    timeout: DurationStringSchema.optional(),
    /** Non-2xx → $json.statusCode instead of failing the execution. */
    never_error: z.boolean().default(false),
  })
  .superRefine((p, ctx) => {
    if ((p.body_type === 'json' || p.body_type === 'raw') && (p.body === undefined || p.body === '')) {
      ctx.addIssue({ code: 'custom', message: `body_type "${p.body_type}" requires \`body\``, path: ['body'] });
    }
  });
export type HttpRequestParams = z.infer<typeof HttpRequestParamsSchema>;

// ── data.kv ──────────────────────────────────────────────────────────────────

export const DataKvParamsSchema = z
  .object({
    op: z.enum(['get', 'set', 'delete', 'increment']).default('get'),
    scope: z.enum(['user', 'bot', 'flow']).default('user'),
    key: z.string().min(1),
    /** op=set: stored value · op=increment: numeric step (default 1). */
    value: z.unknown().optional(),
    /** op=get|increment: result lands in $json.<save_as> (default "value"). */
    save_as: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).optional(),
  })
  .superRefine((p, ctx) => {
    if (p.op === 'set' && p.value === undefined) {
      ctx.addIssue({ code: 'custom', message: 'op "set" requires `value`', path: ['value'] });
    }
  });
export type DataKvParams = z.infer<typeof DataKvParamsSchema>;

// ── flow.manualTrigger ───────────────────────────────────────────────────────

export const FlowManualTriggerParamsSchema = z.object({
  /** Sample payload emitted as the first item's $json (JSON text). */
  sample: z.string().optional(),
});
export type FlowManualTriggerParams = z.infer<typeof FlowManualTriggerParamsSchema>;

// ── dynamic output ports (editor-side mirror of NodeDef.dynamicOutputs) ──────

const PORT_KEY_RE = /^[A-Za-z0-9_.-]{1,48}$/;

/**
 * Effective output ports for nodes whose ports derive from params
 * (tg.menu, flow.switch). Returns null for static-port types.
 *
 * Lives in shared so the EDITOR (which only sees NodeTypeInfo, not NodeDef)
 * and the node implementations compute ports from the SAME key convention —
 * a menu edge the canvas draws is always one the engine can route.
 *
 * Deliberately DRAFT-TOLERANT: while the user is mid-edit the params may not
 * pass the full Zod schema yet (empty text, missing rows). We extract every
 * structurally-valid port key best-effort instead of all-or-nothing, so the
 * canvas grows handles as buttons/rules are typed, never crashes, and never
 * hides already-wired ports because an unrelated field is still empty.
 */
export function dynamicOutputPorts(type: string, rawParams: unknown): string[] | null {
  const p = (rawParams ?? {}) as Record<string, unknown>;
  if (type === 'tg.menu') {
    const ports: string[] = [];
    if (Array.isArray(p.buttons)) {
      for (const row of p.buttons) {
        if (!Array.isArray(row)) continue;
        for (const btn of row) {
          const key = (btn as { key?: unknown } | null)?.key;
          if (typeof key === 'string' && PORT_KEY_RE.test(key)) ports.push(`btn:${key}`);
        }
      }
    }
    const deduped = [...new Set(ports)];
    if (typeof p.timeout === 'string' && p.timeout !== '') deduped.push('timeout');
    return deduped;
  }
  if (type === 'flow.switch') {
    const ports: string[] = [];
    if (Array.isArray(p.rules)) {
      for (const rule of p.rules) {
        const port = (rule as { port?: unknown } | null)?.port;
        if (typeof port === 'string' && PORT_KEY_RE.test(port)) ports.push(port);
      }
    }
    return [...new Set(ports), 'default'];
  }
  return null;
}
