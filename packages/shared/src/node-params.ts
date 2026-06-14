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
    /**
     * Optional stored credential (P3-T4). When set, the host resolves the
     * credential and injects its auth (header / Bearer / Basic) before the
     * request — the secret never reaches the node or the flow JSON. The editor
     * renders this with the `credentialRef` widget (a selector listing saved
     * credentials) via the `ctbWidget` annotation.
     */
    credentialId: z.string().optional().meta({ ctbWidget: 'credentialRef' }),
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

// ════════════════════════════════════════════════════════════════════════
// P2-T7: data.code — the escape hatch (NODES.md §Data & code, ARCH §8).
// ════════════════════════════════════════════════════════════════════════

// ── data.code ──────────────────────────────────────────────────────────────────────

export const DataCodeParamsSchema = z.object({
  mode: z.enum(['run_once', 'per_item']).default('run_once'),
  /**
   * The user's JavaScript. NEVER expression-resolved (NodeDef.rawParamKeys,
   * Decision Log #16) — `{{ }}` sequences are valid JS and must reach the
   * sandbox verbatim. The editor renders this with the `code` widget
   * (CodeMirror) via the `ctbWidget` schema annotation below.
   */
  code: z.string().min(1).meta({ ctbWidget: 'code' }),
  /** Wall-clock budget per sandbox run; host caps at 10s (NODES.md limit). */
  timeout: DurationStringSchema.optional(),
});
export type DataCodeParams = z.infer<typeof DataCodeParamsSchema>;

// ════════════════════════════════════════════════════════════════════════
// P3-T1: flow.executeSubFlow + flow.return — reusable sub-flows
// (NODES.md §"Execute Sub-Flow", PLAN.md P3-T1, ARCHITECTURE.md §10).
// ════════════════════════════════════════════════════════════════════════

// ── flow.executeSubFlow ─────────────────────────────────────────────────────

/**
 * Call another flow OF THE SAME BOT, passing the current items. The child runs
 * to completion; the items its `flow.return` node receives become this node's
 * `main` output (in `wait` mode). Same-bot ownership and the recursion-depth cap
 * are enforced host-side by the injected `ctx.subflow` capability — the node
 * itself never runs an executor (invariant I6).
 */
export const FlowExecuteSubFlowParamsSchema = z.object({
  /**
   * The child flow to call. The editor renders this with the `flowRef` widget
   * (a selector listing the bot's other flows) via the `ctbWidget` annotation.
   */
  flow_id: z.string().min(1).meta({ ctbWidget: 'flowRef' }),
  /**
   * `wait`: run the child synchronously and emit its returned items on `main`.
   * `fire_and_forget`: start the child, then pass THIS node's input through
   * unchanged on `main` without waiting for the child's result.
   */
  mode: z.enum(['wait', 'fire_and_forget']).default('wait'),
});
export type FlowExecuteSubFlowParams = z.infer<typeof FlowExecuteSubFlowParamsSchema>;

// ── flow.return ──────────────────────────────────────────────────────────────

/**
 * Terminal node inside a sub-flow: the items it receives become the sub-flow's
 * result, handed back to the parent's `flow.executeSubFlow` node. Has no params
 * of its own (the returned items are simply its input). A flow run reaching
 * `flow.return` ends like any other terminal node; the host captures the items.
 */
export const FlowReturnParamsSchema = z.object({});
export type FlowReturnParams = z.infer<typeof FlowReturnParamsSchema>;

// ── flow.loop ────────────────────────────────────────────────────────────────

/**
 * Split items into batches, n8n `splitInBatches` style (P3-T2). The node has
 * two output ports: `loop` (the current batch — wire your per-batch work here,
 * then loop the work's output back into this node's input) and `done` (fires
 * once, with ALL the original items, after the last batch).
 *
 * State is kept per-node in $vars under a reserved key; the node tells a fresh
 * entry from a loop-back by whether that state exists. `reset` forces a fresh
 * start even if a previous (e.g. abandoned) loop left state behind.
 */
export const FlowLoopParamsSchema = z.object({
  /** Items per batch on the `loop` port. 1 = one item at a time (n8n default). */
  batch_size: z.coerce.number().int().min(1).default(1),
  /** Discard any leftover loop state on entry and start a brand-new loop. */
  reset: z.boolean().default(false),
});
export type FlowLoopParams = z.infer<typeof FlowLoopParamsSchema>;

// ── flow.merge ───────────────────────────────────────────────────────────────

/**
 * Combine the two input branches `input1` + `input2` (P3-T2):
 *  • `append`       — emit items from whichever branch arrives, in arrival order
 *                     (no waiting; each activation passes its items straight on).
 *  • `wait_both`    — hold the first branch's items until the OTHER branch also
 *                     arrives, then emit both together (input1 first). If only
 *                     one branch ever fires, nothing is emitted.
 *  • `choose_first` — emit the first branch to arrive; ignore the later one.
 */
export const FlowMergeParamsSchema = z.object({
  mode: z.enum(['append', 'wait_both', 'choose_first']).default('append'),
});
export type FlowMergeParams = z.infer<typeof FlowMergeParamsSchema>;

// ── tg.editMessage ───────────────────────────────────────────────────────────

/**
 * Edit an existing message's text/caption and/or inline keyboard (P3-T3,
 * NODES.md §"Edit Message"). `message_id` defaults to the message id carried on
 * the input item — `$json.sent_message_id` (set by tg.sendMessage) or
 * `$json.clicked.message_id` (set by the router on a button click) — so the
 * common "edit what I just sent / what was clicked" case needs no param.
 * `target` picks what to edit:
 *  • `text`     — editMessageText (the common case)
 *  • `caption`  — editMessageCaption (media messages)
 *  • `keyboard` — editMessageReplyMarkup only (swap buttons, leave text)
 */
export const TgEditMessageParamsSchema = z
  .object({
    /** Chat id; defaults to the execution's current chat. */
    chat: z.union([z.number(), z.string().min(1)]).optional(),
    /** Message id to edit; blank → last message sent in this execution. */
    message_id: z.union([z.number().int(), z.string()]).optional(),
    target: z.enum(['text', 'caption', 'keyboard']).default('text'),
    /** New text (target=text) / new caption (target=caption). */
    text: z.string().optional(),
    parse_mode: ParseModeSchema.optional(),
    /** Replacement inline keyboard (optional for text/caption; the payload for keyboard). */
    keyboard: KeyboardSchema.optional(),
  })
  .superRefine((p, ctx) => {
    if ((p.target === 'text' || p.target === 'caption') && (p.text === undefined || p.text === '')) {
      ctx.addIssue({ code: 'custom', message: `target "${p.target}" requires non-empty \`text\``, path: ['text'] });
    }
    if (p.target === 'keyboard' && p.keyboard === undefined) {
      ctx.addIssue({ code: 'custom', message: 'target "keyboard" requires a `keyboard`', path: ['keyboard'] });
    }
  });
export type TgEditMessageParams = z.infer<typeof TgEditMessageParamsSchema>;

// ── tg.deleteMessage ─────────────────────────────────────────────────────────

/**
 * Delete a message by id (P3-T3). `message_id` defaults to the message id on
 * the input item (`$json.sent_message_id` or `$json.clicked.message_id`).
 * Passes input items through unchanged.
 */
export const TgDeleteMessageParamsSchema = z.object({
  chat: z.union([z.number(), z.string().min(1)]).optional(),
  message_id: z.union([z.number().int(), z.string()]).optional(),
});
export type TgDeleteMessageParams = z.infer<typeof TgDeleteMessageParamsSchema>;

// ── tg.answerCallback ────────────────────────────────────────────────────────

/**
 * Acknowledge a button click outside Menu (P3-T3, NODES.md §"Answer Callback").
 * `callback_query_id` defaults to `$json.callback_query_id` (set by the router's
 * callbackItem) so in the common case the node needs no params. `show_alert`
 * turns the toast into a modal alert.
 */
export const TgAnswerCallbackParamsSchema = z.object({
  /** Callback query id; blank → $json.callback_query_id of the current item. */
  callback_query_id: z.string().optional(),
  /** Toast/alert text (optional — empty just dismisses the loading spinner). */
  text: z.string().optional(),
  show_alert: z.boolean().default(false),
});
export type TgAnswerCallbackParams = z.infer<typeof TgAnswerCallbackParamsSchema>;

// ── tg.chatAction ────────────────────────────────────────────────────────────

/**
 * Send a chat action indicator — "typing…", "uploading photo…", etc. (P3-T3,
 * NODES.md §"Send Chat Action"). Telegram auto-clears it after ~5s or when the
 * next message arrives; passes input items through unchanged.
 */
export const TgChatActionParamsSchema = z.object({
  chat: z.union([z.number(), z.string().min(1)]).optional(),
  action: z
    .enum([
      'typing',
      'upload_photo',
      'record_video',
      'upload_video',
      'record_voice',
      'upload_voice',
      'upload_document',
      'choose_sticker',
      'find_location',
      'record_video_note',
      'upload_video_note',
    ])
    .default('typing'),
});
export type TgChatActionParams = z.infer<typeof TgChatActionParamsSchema>;

// ── data.userProfile (P3-T5) ─────────────────────────────────────────────────

/** One "field = value" mapping row (value is an expression, resolved by the executor). */
export const ProfileFieldRowSchema = z.object({
  /** Profile field name — a dotted path is allowed (e.g. "address.city"). */
  field: z.string().min(1),
  /** Value expression — `{{ }}` resolved like every other param before the node runs. */
  value: z.string().default(''),
});
export type ProfileFieldRow = z.infer<typeof ProfileFieldRowSchema>;

/**
 * data.userProfile — read/update the CTB user record (NODES.md §User Profile).
 * A GENERIC CRM-ish primitive: it only ever touches `profile` (a free-form bag
 * the flow author defines) and `tags` (string labels) — it never knows any
 * domain field (invariant I2). Operates on the execution's own user by default;
 * an explicit `user` (tg user id, expression) targets a different one.
 *
 * Ops:
 *  - get          → reads the record; merged into $json.<save_as> (default "user")
 *  - set_profile  → writes the `fields` rows into profile (merge|replace); read-back merged
 *  - add_tags     → adds `tags` (de-duplicated); read-back merged
 *  - remove_tags  → removes `tags`; read-back merged
 */
export const UserProfileParamsSchema = z
  .object({
    op: z.enum(['get', 'set_profile', 'add_tags', 'remove_tags']).default('get'),
    /** Target user (tg user id) — expression; empty ⇒ the execution's own user. */
    user: z.string().optional(),
    /** op=set_profile: field rows written into the profile bag. */
    fields: z.array(ProfileFieldRowSchema).optional(),
    /**
     * op=set_profile: `merge` keeps untouched profile keys (default),
     * `replace` swaps the whole profile bag for just these fields.
     */
    mode: z.enum(['merge', 'replace']).default('merge'),
    /** op=add_tags|remove_tags: tag labels (comma-separated string OR rows). */
    tags: z.array(z.string().min(1)).optional(),
    /** Result record lands in $json.<save_as> (default "user"). */
    save_as: z
      .string()
      .regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
      .optional(),
  })
  .superRefine((p, ctx) => {
    if (p.op === 'set_profile' && (!p.fields || p.fields.length === 0)) {
      ctx.addIssue({ code: 'custom', message: 'op "set_profile" requires at least one field', path: ['fields'] });
    }
    if ((p.op === 'add_tags' || p.op === 'remove_tags') && (!p.tags || p.tags.length === 0)) {
      ctx.addIssue({ code: 'custom', message: `op "${p.op}" requires at least one tag`, path: ['tags'] });
    }
  });
export type UserProfileParams = z.infer<typeof UserProfileParamsSchema>;

// ── data.collection (P3.5-T5) ────────────────────────────────────────────────

/** Comparison operators the Collection filter understands (mirrors shared FilterOp). */
export const CollectionFilterOpSchema = z.enum([
  'eq',
  'ne',
  'gt',
  'gte',
  'lt',
  'lte',
  'contains',
  'in',
  'exists',
]);
export type CollectionFilterOp = z.infer<typeof CollectionFilterOpSchema>;

/**
 * One `where` row in a data.collection find/update/delete. `field` is a record
 * field path (json key, dotted ok); `value` is an EXPRESSION (resolved by the
 * executor before execute()). `in` expects a comma-separated value, `exists`
 * ignores value (defaults to exists:true).
 */
export const CollectionWhereRowSchema = z.object({
  field: z.string().min(1),
  op: CollectionFilterOpSchema.default('eq'),
  value: z.string().default(''),
});
export type CollectionWhereRow = z.infer<typeof CollectionWhereRowSchema>;

/** One sort row. */
export const CollectionSortRowSchema = z.object({
  field: z.string().min(1),
  dir: z.enum(['asc', 'desc']).default('asc'),
});
export type CollectionSortRow = z.infer<typeof CollectionSortRowSchema>;

/** One `field = value(expression)` mapping row for insert/update. */
export const CollectionFieldMapRowSchema = z.object({
  /** Target field name — dotted path allowed (e.g. "address.city"). */
  field: z.string().min(1),
  /**
   * Value expression — `{{ }}` resolved like every other param. COERCED to a
   * string: the executor re-validates params AFTER resolving expressions, so an
   * expression that yields a number/boolean (e.g. `{{ $vars.qty }}` → 2) would
   * otherwise fail this row's `z.string()`. The mapping value is conceptually
   * always a string template; the node hands it to `validateRecord`, which
   * coerces it to the record field's real type (number/boolean/…). So coercing
   * here is correct AND keeps the field types honest at write time.
   */
  value: z.coerce.string().default(''),
});
export type CollectionFieldMapRow = z.infer<typeof CollectionFieldMapRowSchema>;

/**
 * data.collection — generic CRUD against a user-defined Collection (NODES.md
 * §Collection). As domain-agnostic as KV (invariant I2): CTB has no idea
 * whether records are products, tickets or recipes — the host owns the schema.
 *
 * Ops:
 *  - find    → `where`/`sort`/`limit`/`offset` → ONE output item per record
 *              (`{ record, record_id }`); no matches → `empty` port
 *  - get     → `record_id` (expression) → one item, or `empty` port
 *  - insert  → `fields` rows → `{ record, record_id }`
 *  - update  → `record_id` OR `where` (first match) + `fields` rows; `mode`
 *              merge|replace for group fields → `{ record, record_id }`
 *  - delete  → `record_id` OR `where` + `confirm_many` guard → `{ deleted: n }`
 *  - count   → `where` → `{ count }`
 *
 * `suppress_events`: writes from this node do not fire `collection.recordChanged`.
 */
export const CollectionParamsSchema = z
  .object({
    /**
     * Collection slug (selected from this bot's collections in the editor via a
     * dedicated selector — the `collectionRef` `ctbWidget` annotation, mirroring
     * how `flow_id`/`credentialId` surface flow/credential pickers).
     */
    collection: z.string().min(1).meta({ ctbWidget: 'collectionRef' }),
    operation: z.enum(['find', 'get', 'insert', 'update', 'delete', 'count']).default('find'),
    /** find/update/delete: where rows. */
    where: z.array(CollectionWhereRowSchema).default([]),
    /** find: sort rows. */
    sort: z.array(CollectionSortRowSchema).default([]),
    /** find: max rows (expression-free; positive int). */
    limit: z.number().int().positive().max(1000).optional(),
    /** find: skip N rows. */
    offset: z.number().int().nonnegative().optional(),
    /** get/update/delete: target record id (expression). */
    record_id: z.string().optional(),
    /** insert/update: field mapping rows. */
    fields: z.array(CollectionFieldMapRowSchema).default([]),
    /** update: `merge` (shallow top-level merge, default) | `replace` (whole doc). */
    mode: z.enum(['merge', 'replace']).default('merge'),
    /** delete: refuse to delete more than one row unless set. */
    confirm_many: z.boolean().default(false),
    /** Writes don't fire collection.recordChanged. */
    suppress_events: z.boolean().default(false),
  })
  .superRefine((p, ctx) => {
    if (p.operation === 'get' && (p.record_id === undefined || p.record_id === '')) {
      ctx.addIssue({ code: 'custom', message: 'op "get" requires record_id', path: ['record_id'] });
    }
    if (p.operation === 'insert' && p.fields.length === 0) {
      ctx.addIssue({ code: 'custom', message: 'op "insert" requires at least one field', path: ['fields'] });
    }
    if (p.operation === 'update') {
      if ((p.record_id === undefined || p.record_id === '') && p.where.length === 0) {
        ctx.addIssue({ code: 'custom', message: 'op "update" requires record_id or where', path: ['record_id'] });
      }
      if (p.fields.length === 0) {
        ctx.addIssue({ code: 'custom', message: 'op "update" requires at least one field', path: ['fields'] });
      }
    }
    if (p.operation === 'delete' && (p.record_id === undefined || p.record_id === '') && p.where.length === 0) {
      ctx.addIssue({ code: 'custom', message: 'op "delete" requires record_id or where', path: ['record_id'] });
    }
  });
export type CollectionParams = z.infer<typeof CollectionParamsSchema>;

// ── collection.recordChanged trigger (P3.5-T5) ───────────────────────────────

/**
 * collection.recordChanged — fires a flow when a record is created/updated/
 * deleted (from the admin panel, the records API, or another flow — unless that
 * write set `suppress_events`). NODES.md §Record Changed Trigger.
 *
 * - `events`: subset of created|updated|deleted (≥1).
 * - `field_filter` (updated only): only fire if one of these fields changed.
 * - `condition` (optional): expression on the new record; fire only when truthy.
 *
 * The MATCH happens host-side (the record-write event bus scans active flows);
 * by the time execute() runs the item is already built, so the node is a typed
 * pass-through (like tg.trigger).
 */
export const RecordChangedParamsSchema = z.object({
  /** Collection slug this trigger watches (selected via the `collectionRef` widget). */
  collection: z.string().min(1).meta({ ctbWidget: 'collectionRef' }),
  /** Which write kinds fire the trigger (at least one). */
  events: z.array(z.enum(['created', 'updated', 'deleted'])).min(1).default(['created']),
  /** updated-only: only fire when one of these fields actually changed. */
  field_filter: z.array(z.string().min(1)).default([]),
  /** Optional guard expression on the new record (e.g. `{{ $json.record.status === 'shipped' }}`). */
  condition: z.string().optional(),
});
export type RecordChangedParams = z.infer<typeof RecordChangedParamsSchema>;

// ── webhook.trigger (P4-T1) ──────────────────────────────────────────────────

/**
 * webhook.trigger — inbound HTTP entry point (NODES.md §Webhook Trigger,
 * PROTOCOL.md §Inbound). `POST /hooks/flow/:flowId/:secret` → the request
 * body/headers/query/method become the first item's `$json`.
 *
 * Every param here is a HOST-side directive consumed by the webhook ROUTE
 * (apps/server/src/triggers/webhook.ts), not a runtime template — by the time
 * the node's execute() runs the host has already authenticated the request and
 * built the item, so the node is a pure pass-through (like tg.trigger).
 *
 * - `mode`: async → the route replies `202 {ok,executionId}` and runs the flow
 *   out-of-band; sync → the route holds the connection until a
 *   `flow.respondToWebhook` node runs (or `sync_timeout` elapses → 504).
 * - `verify_signature`: require an `X-CTB-Signature: sha256=<hex>` HMAC over the
 *   raw body (keyed by a per-flow secret DERIVED from CTB_SECRET) → 401 if bad.
 * - `sync_timeout`: seconds the sync request may wait (1–120).
 * - `target_chat`: doc/UX-only expression naming which chat the Telegram nodes
 *   in this flow talk to (e.g. `{{ $json.chat_id }}`); resolved by those nodes,
 *   never by the route, so it is a raw param the executor leaves untouched.
 */
export const WebhookTriggerParamsSchema = z.object({
  mode: z.enum(['async', 'sync']).default('async'),
  verify_signature: z.boolean().default(false),
  sync_timeout: z.number().int().min(1).max(120).default(30),
  target_chat: z.string().optional(),
});
export type WebhookTriggerParams = z.infer<typeof WebhookTriggerParamsSchema>;

// ── flow.respondToWebhook (P4-T1) ────────────────────────────────────────────

/**
 * flow.respondToWebhook — produces the HTTP response for a SYNC Webhook Trigger
 * (NODES.md §Respond to Webhook). It parks `{status,bodyType,body,headers}`
 * under a reserved `$vars` key (the EXACT mechanism flow.return uses) and passes
 * its input through on `main` — it is NOT terminal, so the flow can keep going
 * after answering. The webhook route reads the parked value once the run
 * reaches a terminal/waiting status.
 *
 * - `body_type`: json → the body is sent as `application/json` (must be valid
 *   JSON text, or it is sent verbatim as text); text → `text/plain`.
 * - `headers`: extra response headers (name/value rows). A `Content-Type` row
 *   overrides the body_type default.
 */
export const RespondHeaderRowSchema = z.object({
  name: z.string().min(1),
  value: z.string().default(''),
});
export type RespondHeaderRow = z.infer<typeof RespondHeaderRowSchema>;

export const FlowRespondToWebhookParamsSchema = z.object({
  status: z.number().int().min(100).max(599).default(200),
  body_type: z.enum(['json', 'text']).default('json'),
  /** Response body (expression-aware). Empty = no body. */
  body: z.string().default(''),
  headers: z.array(RespondHeaderRowSchema).default([]),
});
export type FlowRespondToWebhookParams = z.infer<typeof FlowRespondToWebhookParamsSchema>;

// ── schedule.trigger (P4-T2) ─────────────────────────────────────────────────

/**
 * schedule.trigger — time-based entry point (NODES.md §Schedule Trigger). The
 * HOST runs a cron job per active `schedule.trigger` node (apps/server/src/
 * triggers/schedule.ts); when it fires it starts the flow and builds the first
 * item, so the node itself is a pure pass-through (like tg.trigger / webhook).
 *
 * Every param here is a HOST-side directive consumed by the Scheduler, NOT a
 * runtime template:
 * - `cron`: a 5- or 6-field cron expression (croner). Evaluated in `timezone`.
 * - `timezone`: IANA tz name (e.g. `Asia/Tehran`); empty = the server's local tz.
 * - `for_each_user`: when true the schedule fans out — one run per KNOWN bot
 *   user (each run's chat = that user's tg id) instead of a single chatless run.
 * - `rate_per_min`: fan-out throttle (runs started per minute) so a big user
 *   base doesn't hammer Telegram all at once. Ignored when `for_each_user` is
 *   false. 0 = unlimited.
 * - `target_chat`: doc/UX-only expression naming which chat the Telegram nodes
 *   talk to for a NON-fan-out schedule (e.g. an admin channel id); resolved by
 *   those nodes, never by the scheduler — a raw param the executor leaves alone.
 */
export const ScheduleTriggerParamsSchema = z.object({
  cron: z.string().min(1).default('0 9 * * *'),
  timezone: z.string().default(''),
  for_each_user: z.boolean().default(false),
  rate_per_min: z.number().int().min(0).max(6000).default(60),
  target_chat: z.string().optional(),
});
export type ScheduleTriggerParams = z.infer<typeof ScheduleTriggerParamsSchema>;

// ── ai.llmChat (P5-T1) ───────────────────────────────────────────────────────

/**
 * LLM Chat (NODES.md §AI nodes). Calls an OpenAI-compatible chat-completions
 * endpoint via the host `ctx.ai` capability. The provider (OpenAI / OpenRouter /
 * Anthropic-proxy / local) is chosen by the selected `credentialId` (openAiApi:
 * base_url + key) — the node never sees the key (invariants I6/I7).
 *
 * `memory: conversation` persists the rolling last-N turns per chat in KV, so a
 * support bot remembers the dialogue without an external DB. `none` is stateless.
 * The model's reply lands in `$json.<save_as>` (default `ai`) as `{ reply, usage }`.
 */
export const AiMemorySchema = z.enum(['none', 'conversation']);
export type AiMemory = z.infer<typeof AiMemorySchema>;

export const AiLlmChatParamsSchema = z.object({
  /**
   * The OpenAI-compatible credential (base_url + key). The editor renders a
   * selector filtered to `openAiApi` credentials via the `credentialRef`
   * widget; the host resolves it to base URL + bearer key (the node only ever
   * sees the id — invariant I7).
   */
  credentialId: z.string().min(1).meta({ ctbWidget: 'credentialRef', credentialType: 'openAiApi' }),
  /** Model name as the provider expects it, e.g. `gpt-4o-mini`, `llama-3.1-8b`. */
  model: z.string().min(1).default('gpt-4o-mini'),
  /** Optional system prompt steering the assistant (expression-aware). */
  system_prompt: z.string().default(''),
  /** The user turn to send (expression-aware — usually `{{ $json.text }}`). */
  user_prompt: z.string().min(1),
  /** Sampling temperature 0–2 (provider default when omitted). */
  temperature: z.coerce.number().min(0).max(2).optional(),
  /** Hard cap on response tokens (provider default when omitted). */
  max_tokens: z.coerce.number().int().min(1).max(32_000).optional(),
  /** none = stateless; conversation = remember the rolling last-N turns per chat. */
  memory: AiMemorySchema.default('none'),
  /**
   * How many PRIOR turns (user+assistant pairs) to replay when memory is on.
   * Bounded so the prompt — and the KV row — stay small.
   */
  memory_window: z.coerce.number().int().min(1).max(50).default(10),
  /** Where the `{ reply, usage }` result lands on each output item. */
  save_as: z
    .string()
    .regex(/^[A-Za-z_$][A-Za-z0-9_$]*$/, 'must be a valid identifier')
    .default('ai'),
});
export type AiLlmChatParams = z.infer<typeof AiLlmChatParamsSchema>;

// ── ai.classify (P5-T2) ──────────────────────────────────────────────────────

/**
 * AI Classify (NODES.md §AI nodes). A Switch powered by an LLM: the model is
 * asked to pick exactly ONE of the configured categories for the `input` text,
 * and the item is routed to that category's output port. An unrecognized /
 * empty answer falls through to the `other` port.
 *
 * Like ai.llmChat the provider call happens HOST-side via `ctx.ai.chat()` — the
 * node only passes a `credentialId` + model + messages (invariants I6/I7). Runs
 * ONCE per node run (one LLM call routes the whole batch — categorising N items
 * separately would multiply cost; the typical use is "route this conversation
 * turn", a single value).
 */
export const ClassifyCategorySchema = z.object({
  /** Output port key — letters/digits/_/./- (must not be the reserved `other`). */
  key: z
    .string()
    .regex(/^[A-Za-z0-9_.-]{1,48}$/, 'letters/digits/_/./- only')
    .refine((k) => k !== 'other', '`other` is reserved for the fallback port'),
  /** What this category means — the model reads these to choose. */
  description: z.string().default(''),
});
export type ClassifyCategory = z.infer<typeof ClassifyCategorySchema>;

export const AiClassifyParamsSchema = z.object({
  /** OpenAI-compatible credential (base_url + key); host resolves it (I7). */
  credentialId: z.string().min(1).meta({ ctbWidget: 'credentialRef', credentialType: 'openAiApi' }),
  /** Model name as the provider expects it, e.g. `gpt-4o-mini`. */
  model: z.string().min(1).default('gpt-4o-mini'),
  /** The text to classify (expression-aware — usually `{{ $json.text }}`). */
  input: z.string().min(1),
  /** The categories; each becomes an output port. At least one required. */
  categories: z.array(ClassifyCategorySchema).min(1),
  /** Optional extra steering prepended to the classification instruction. */
  system_prompt: z.string().default(''),
  /** Sampling temperature 0–2 (provider default when omitted; low is best here). */
  temperature: z.coerce.number().min(0).max(2).optional(),
  /** Where the `{ category }` result lands on each routed item (default `classification`). */
  save_as: z
    .string()
    .regex(/^[A-Za-z_$][A-Za-z0-9_$]*$/, 'must be a valid identifier')
    .default('classification'),
});
export type AiClassifyParams = z.infer<typeof AiClassifyParamsSchema>;

/** Output ports of a classify instance: one per category + `other`, deduped. */
export function classifyOutputs(params: AiClassifyParams): string[] {
  return [...new Set(params.categories.map((c) => c.key)), 'other'];
}

// ── ai.extract (P5-T2) ───────────────────────────────────────────────────────

/**
 * AI Extract (NODES.md §AI nodes). Pulls structured JSON out of free text: the
 * model is asked to return a JSON object matching the configured `fields`, the
 * node parses it and (on a parse/shape failure) retries up to `max_retries`
 * times before failing. The extracted object lands in `$json.<save_as>`
 * (default `extracted`).
 *
 * Provider call is HOST-side via `ctx.ai.chat()` (I6/I7). Runs ONCE per node
 * run — the extraction targets the resolved `input` (a single value), and one
 * LLM call should not be multiplied by the item count.
 */
export const ExtractFieldTypeSchema = z.enum(['string', 'number', 'boolean']);
export type ExtractFieldType = z.infer<typeof ExtractFieldTypeSchema>;

export const ExtractFieldSchema = z.object({
  /** Output JSON key — a valid identifier so `$json.extracted.<name>` is clean. */
  name: z.string().regex(/^[A-Za-z_$][A-Za-z0-9_$]*$/, 'must be a valid identifier'),
  type: ExtractFieldTypeSchema.default('string'),
  /** What to extract for this field — the model reads it. */
  description: z.string().default(''),
  /** When true, a missing/null value for this field fails validation → retry. */
  required: z.boolean().default(false),
});
export type ExtractField = z.infer<typeof ExtractFieldSchema>;

export const AiExtractParamsSchema = z.object({
  /** OpenAI-compatible credential (base_url + key); host resolves it (I7). */
  credentialId: z.string().min(1).meta({ ctbWidget: 'credentialRef', credentialType: 'openAiApi' }),
  /** Model name as the provider expects it, e.g. `gpt-4o-mini`. */
  model: z.string().min(1).default('gpt-4o-mini'),
  /** The source text to extract from (expression-aware — usually `{{ $json.text }}`). */
  input: z.string().min(1),
  /** The target schema — fields to pull out. At least one required. */
  fields: z.array(ExtractFieldSchema).min(1),
  /** Optional extra steering prepended to the extraction instruction. */
  system_prompt: z.string().default(''),
  /** Sampling temperature 0–2 (provider default when omitted; low is best here). */
  temperature: z.coerce.number().min(0).max(2).optional(),
  /** How many times to re-ask when the reply isn't valid JSON / misses required fields. */
  max_retries: z.coerce.number().int().min(0).max(5).default(2),
  /** Where the extracted object lands on each output item (default `extracted`). */
  save_as: z
    .string()
    .regex(/^[A-Za-z_$][A-Za-z0-9_$]*$/, 'must be a valid identifier')
    .default('extracted'),
});
export type AiExtractParams = z.infer<typeof AiExtractParamsSchema>;

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
  if (type === 'ai.classify') {
    const ports: string[] = [];
    if (Array.isArray(p.categories)) {
      for (const cat of p.categories) {
        const key = (cat as { key?: unknown } | null)?.key;
        if (typeof key === 'string' && key !== 'other' && PORT_KEY_RE.test(key)) ports.push(key);
      }
    }
    return [...new Set(ports), 'other'];
  }
  return null;
}
