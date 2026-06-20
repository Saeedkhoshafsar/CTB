/**
 * Drizzle schema — exactly per docs/ARCHITECTURE.md §4 (incl. Collections layer §13).
 * snake_case columns (CLAUDE.md §7). JSON documents stored as TEXT with json mode.
 */
import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

export const bots = sqliteTable('bots', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  /** Telegram token, AES-256-GCM encrypted (invariant I7). */
  tokenEnc: text('token_enc').notNull(),
  mode: text('mode', { enum: ['webhook', 'polling'] }).notNull().default('polling'),
  status: text('status', { enum: ['active', 'inactive', 'error'] }).notNull().default('inactive'),
  settings: text('settings', { mode: 'json' }).notNull().default('{}'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const flows = sqliteTable(
  'flows',
  {
    id: text('id').primaryKey(),
    botId: text('bot_id').notNull().references(() => bots.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    status: text('status', { enum: ['draft', 'active'] }).notNull().default('draft'),
    /** FlowGraph JSON — the exact document the canvas edits (FlowGraphSchema). */
    graph: text('graph', { mode: 'json' }).notNull(),
    /** FlowSettings JSON (executionPolicy + errorHandlerFlowId, P3-T6). */
    settings: text('settings', { mode: 'json' }).notNull().default('{}'),
    version: integer('version').notNull().default(1),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [index('flows_bot_idx').on(t.botId)],
);

/**
 * Pending triggers (P3-T6, executionPolicy='queue'). When a trigger fires for
 * a (flow, chat) that already has a WAITING execution and the flow's policy is
 * `queue`, the router parks the trigger here instead of starting/replacing.
 * Once the waiting run reaches a terminal state, the router drains the oldest
 * pending row for that (flow, chat) and starts it. FIFO via the autoincrement id.
 */
export const pendingTriggers = sqliteTable(
  'pending_triggers',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    botId: text('bot_id').notNull().references(() => bots.id, { onDelete: 'cascade' }),
    flowId: text('flow_id').notNull().references(() => flows.id, { onDelete: 'cascade' }),
    chatId: integer('chat_id').notNull(),
    /** Trigger node the parked run should enter through. */
    entryNodeId: text('entry_node_id').notNull(),
    /** tg user id (string) for the parked run's userId, or null. */
    userId: text('user_id'),
    /** The trigger FlowItem JSON (one item) the parked run starts with. */
    item: text('item', { mode: 'json' }).notNull(),
    createdAt: text('created_at').notNull(),
  },
  (t) => [index('pending_triggers_chat_idx').on(t.botId, t.flowId, t.chatId, t.id)],
);

export const flowVersions = sqliteTable(
  'flow_versions',
  {
    id: text('id').primaryKey(),
    flowId: text('flow_id').notNull().references(() => flows.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    graph: text('graph', { mode: 'json' }).notNull(),
    createdAt: text('created_at').notNull(),
  },
  (t) => [uniqueIndex('flow_versions_unique').on(t.flowId, t.version)],
);

export const credentials = sqliteTable('credentials', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  type: text('type').notNull(),
  /** Encrypted JSON blob (invariant I7) — never returned in plaintext by the API. */
  dataEnc: text('data_enc').notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const executions = sqliteTable(
  'executions',
  {
    id: text('id').primaryKey(),
    flowId: text('flow_id').notNull().references(() => flows.id, { onDelete: 'cascade' }),
    botId: text('bot_id').notNull().references(() => bots.id, { onDelete: 'cascade' }),
    chatId: integer('chat_id'),
    userId: text('user_id'),
    status: text('status', { enum: ['running', 'waiting', 'done', 'error', 'canceled'] }).notNull(),
    /** ExecutionState JSON (cursor, items, vars, steps) — invariant I4. */
    state: text('state', { mode: 'json' }).notNull(),
    /** WaitSpec JSON or null. */
    wait: text('wait', { mode: 'json' }),
    /** Denormalized from wait.timeoutAt/resumeAt for the timeout scanner index. */
    waitTimeoutAt: text('wait_timeout_at'),
    error: text('error'),
    startedAt: text('started_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [
    index('executions_waiting_idx').on(t.botId, t.chatId, t.status),
    index('executions_timeout_idx').on(t.status, t.waitTimeoutAt),
    index('executions_flow_idx').on(t.flowId, t.status),
  ],
);

export const execLogs = sqliteTable(
  'exec_logs',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    executionId: text('execution_id').notNull().references(() => executions.id, { onDelete: 'cascade' }),
    nodeId: text('node_id'),
    level: text('level', { enum: ['debug', 'info', 'warn', 'error'] }).notNull(),
    message: text('message').notNull().default(''),
    input: text('input', { mode: 'json' }),
    output: text('output', { mode: 'json' }),
    error: text('error'),
    durationMs: integer('duration_ms'),
    ts: text('ts').notNull(),
  },
  (t) => [index('exec_logs_exec_idx').on(t.executionId)],
);

export const kvStore = sqliteTable(
  'kv_store',
  {
    botId: text('bot_id').notNull().references(() => bots.id, { onDelete: 'cascade' }),
    scope: text('scope', { enum: ['user', 'bot', 'flow'] }).notNull(),
    /** tg user id for scope=user, flow id for scope=flow, '' for scope=bot. */
    scopeId: text('scope_id').notNull().default(''),
    key: text('key').notNull(),
    value: text('value', { mode: 'json' }),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [uniqueIndex('kv_unique').on(t.botId, t.scope, t.scopeId, t.key)],
);

export const users = sqliteTable(
  'users',
  {
    id: text('id').primaryKey(),
    botId: text('bot_id').notNull().references(() => bots.id, { onDelete: 'cascade' }),
    tgUserId: integer('tg_user_id').notNull(),
    profile: text('profile', { mode: 'json' }).notNull().default('{}'),
    tags: text('tags', { mode: 'json' }).notNull().default('[]'),
    firstSeen: text('first_seen').notNull(),
    lastSeen: text('last_seen').notNull(),
  },
  (t) => [uniqueIndex('users_bot_tg_unique').on(t.botId, t.tgUserId)],
);

/**
 * API tokens (P4-T3, PROTOCOL.md §Inbound REST API). Bearer tokens that
 * authenticate the public `/api/v1/*` surface (trigger a flow, send a message,
 * query executions/users). The plaintext token is shown ONCE on creation and
 * NEVER stored — only its SHA-256 hash lives here (invariant I7 spirit: a DB
 * leak can't replay tokens). An optional `bot_id` scopes a token to one bot;
 * null = instance-wide (every bot/flow). `prefix` is a non-secret display
 * fragment so the panel can identify a token without revealing it.
 */
export const apiTokens = sqliteTable(
  'api_tokens',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    /** SHA-256 hex of the plaintext token — the token itself is never stored. */
    tokenHash: text('token_hash').notNull(),
    /** First chars of the token (e.g. "ctb_a1b2c3") — non-secret, for display. */
    prefix: text('prefix').notNull(),
    /** Optional bot scope: null = instance-wide; else restricted to this bot. */
    botId: text('bot_id').references(() => bots.id, { onDelete: 'cascade' }),
    createdAt: text('created_at').notNull(),
    /** Last time a request authenticated with this token (null = never used). */
    lastUsedAt: text('last_used_at'),
  },
  (t) => [uniqueIndex('api_tokens_hash_unique').on(t.tokenHash)],
);

/**
 * Outbound instance webhooks (P4-T4, PROTOCOL.md §Outbound). A subscription:
 * when a matching event fires (execution.finished / execution.failed /
 * user.first_seen), CTB POSTs the event envelope to `url`, optionally signed
 * with `secret` (HMAC-SHA256 over the raw body). Scoped per-bot or instance-wide.
 */
export const instanceWebhooks = sqliteTable('instance_webhooks', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  /** Destination URL CTB POSTs the event envelope to. */
  url: text('url').notNull(),
  /** Optional HMAC signing key; when set, requests carry X-CTB-Signature. */
  secret: text('secret'),
  /** JSON array of subscribed event names (e.g. ["execution.finished"]). */
  events: text('events', { mode: 'json' }).$type<string[]>().notNull(),
  /** Optional bot scope: null = all bots; else only this bot's events. */
  botId: text('bot_id').references(() => bots.id, { onDelete: 'cascade' }),
  /** Disabled subscriptions are kept but never fire. */
  active: integer('active', { mode: 'boolean' }).notNull().default(true),
  createdAt: text('created_at').notNull(),
  /** Last time a delivery was attempted (null = never). */
  lastFiredAt: text('last_fired_at'),
  /** Last delivery error (null = last attempt OK or never fired). */
  lastError: text('last_error'),
});

// ---------- Collections layer (ARCHITECTURE §13) ----------

export const collections = sqliteTable(
  'collections',
  {
    id: text('id').primaryKey(),
    botId: text('bot_id').notNull().references(() => bots.id, { onDelete: 'cascade' }),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    icon: text('icon'),
    /** CollectionSchema JSON (field definitions) — defined in @ctb/shared at P3.5-T1. */
    schema: text('schema', { mode: 'json' }).notNull(),
    /** Display hints: list columns, default sort. */
    display: text('display', { mode: 'json' }).notNull().default('{}'),
    version: integer('version').notNull().default(1),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [uniqueIndex('collections_bot_slug_unique').on(t.botId, t.slug)],
);

export const records = sqliteTable(
  'records',
  {
    id: text('id').primaryKey(),
    collectionId: text('collection_id').notNull().references(() => collections.id, { onDelete: 'cascade' }),
    /** The record document, validated against the collection schema on write. */
    data: text('data', { mode: 'json' }).notNull(),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    /** 'admin' | 'api' | 'flow:<flowId>' — provenance for recordChanged trigger. */
    createdBy: text('created_by').notNull().default('admin'),
  },
  (t) => [index('records_collection_idx').on(t.collectionId)],
);

export const files = sqliteTable('files', {
  id: text('id').primaryKey(),
  botId: text('bot_id').notNull().references(() => bots.id, { onDelete: 'cascade' }),
  kind: text('kind', { enum: ['local', 'tg_file_id'] }).notNull(),
  pathOrFileId: text('path_or_file_id').notNull(),
  mime: text('mime'),
  size: integer('size'),
  createdAt: text('created_at').notNull(),
});

/**
 * AI spend ledger (PD-T2 — agent cost governance). One row per LLM call made
 * through `ctx.ai.chat` (ai.llmChat + ai.agent's per-step calls), written by the
 * host AFTER the provider replies with reported usage. The host both ENFORCES
 * the per-bot daily caps (by summing today's rows) and SURFACES the spend in the
 * panel (per-credential + today/all-time totals). `day` is the UTC date string
 * (`YYYY-MM-DD`) denormalized from `ts` so the daily-cap + today queries hit an
 * index instead of scanning/parsing every timestamp.
 */
export const aiUsage = sqliteTable(
  'ai_usage',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    botId: text('bot_id').notNull().references(() => bots.id, { onDelete: 'cascade' }),
    /** Originating flow/execution, when the call came from a run (null otherwise). */
    flowId: text('flow_id'),
    executionId: text('execution_id'),
    /** The credential the call was billed to (per-credential metering). */
    credentialId: text('credential_id').notNull().default(''),
    model: text('model').notNull().default(''),
    promptTokens: integer('prompt_tokens').notNull().default(0),
    completionTokens: integer('completion_tokens').notNull().default(0),
    totalTokens: integer('total_tokens').notNull().default(0),
    /** UTC date (YYYY-MM-DD) of `ts`, indexed for the daily-cap + today queries. */
    day: text('day').notNull(),
    ts: text('ts').notNull(),
  },
  (t) => [
    index('ai_usage_bot_day_idx').on(t.botId, t.day),
    index('ai_usage_bot_cred_idx').on(t.botId, t.credentialId),
  ],
);
