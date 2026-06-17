import type { ZodType } from 'zod';
import { z } from 'zod';
import type { FlowItem } from './item';
import type { NodeId, PortName } from './flow';
import type { WaitSpec } from './execution';

/**
 * CtbUser — the persisted per-bot end-user record (the `users` table, P3-T5).
 * GENERIC by construction (invariant I2): `profile` is a free-form bag the flow
 * author defines, `tags` are plain string labels — CTB never bakes in a domain
 * field. Telegram identity is mirrored into `profile` (first_name/username/…)
 * by the host on upsert, never as dedicated columns.
 */
export interface CtbUser {
  tgUserId: number;
  profile: Record<string, unknown>;
  tags: string[];
  firstSeen: string;
  lastSeen: string;
}

/**
 * One resolved media attachment handed to `ctx.tg.sendMedia` (tg.sendMedia,
 * PA-T1). The node resolves each author-configured media item into one of these
 * — the host then performs the actual upload (URL/file_id passed through, raw
 * `bytes` uploaded as a Telegram InputFile). Reading a CTB file id from disk and
 * obtaining the token/socket stays host-side (invariants I3/I6): the node never
 * touches them; for `source:'file'` it asks the host to read the bytes via the
 * injected `readFile` and passes the resulting Buffer here.
 */
export interface TgInputMedia {
  kind: 'photo' | 'video' | 'document' | 'audio';
  /** Per-item caption (shown on each album item). */
  caption?: string;
  /** A URL Telegram fetches, or a Telegram file_id to re-send. */
  ref?: string;
  /** Raw bytes to upload (mutually exclusive with `ref`). */
  bytes?: Uint8Array;
  /** Upload hints when sending bytes. */
  filename?: string;
  mime?: string;
}

/**
 * A stored file's public projection, returned by `ctx.files.write` (tg.getFile
 * `store:true`, PA-T2). Mirrors the host's `FilePublic` shape — the CTB file
 * `id` is what downstream nodes (tg.sendMedia `source:'file'`) reference.
 */
export interface TgStoredFile {
  id: string;
  mime: string | null;
  size: number | null;
  url: string;
}

/**
 * NodeResult — what a node's execute() returns to the executor (ARCHITECTURE §7).
 * Discriminated union so the executor switch is exhaustive.
 */
export type NodeResult =
  /** Items routed per output port. Missing ports = no items emitted there. */
  | { kind: 'items'; outputs: Partial<Record<PortName, FlowItem[]>> }
  /** Pause: persist state and return; router resumes later per WaitSpec. */
  | { kind: 'wait'; wait: WaitSpec }
  /** Jump to another node, feeding it the given items on "main". */
  | { kind: 'goto'; nodeId: NodeId; items: FlowItem[] }
  /** Finish successfully. */
  | { kind: 'end' }
  /** Finish with error (recorded on the execution + exec_logs). */
  | { kind: 'error'; message: string };

/** Helper constructors keep node code terse and typo-free. */
export const out = (outputs: Partial<Record<PortName, FlowItem[]>>): NodeResult => ({ kind: 'items', outputs });
export const wait = (w: WaitSpec): NodeResult => ({ kind: 'wait', wait: w });
export const goto = (nodeId: NodeId, items: FlowItem[]): NodeResult => ({ kind: 'goto', nodeId, items });
export const end = (): NodeResult => ({ kind: 'end' });
export const fail = (message: string): NodeResult => ({ kind: 'error', message });

/**
 * NodeCtx — capabilities injected by the host (invariant I3/I6).
 * core defines the shape; apps/server provides implementations.
 * Nodes NEVER touch globals — everything arrives through ctx.
 */
export interface NodeCtx {
  readonly executionId: string;
  readonly flowId: string;
  readonly botId: string;
  readonly chatId: number | null;
  /**
   * The graph id of the node currently executing (P3-T2). Lets a stateful node
   * scope its own $vars bucket so two instances of the same type never collide
   * (flow.loop keeps its batch cursor under a per-node key). Nodes don't learn
   * their id any other way — the executor stamps it here.
   */
  readonly nodeId: string;
  /**
   * Items grouped by the INPUT PORT they arrived on (P3-T2). `execute()` still
   * receives the flattened merge of all ports for the common case; a node that
   * must distinguish branches (flow.merge: which side fired?) reads this instead.
   * Empty ports are omitted (the router never routes empty arrays).
   */
  readonly inputsByPort: Record<string, FlowItem[]>;
  /** Evaluate a {{ }} expression template against an item + $vars. */
  eval(template: string, itemJson: Record<string, unknown>): Promise<string>;
  /** Execution-scoped variables ($vars). */
  vars: {
    get(key: string): unknown;
    set(key: string, value: unknown): void;
    all(): Record<string, unknown>;
  };
  /** Persistent key-value store (data.kv backing). */
  kv: {
    get(scope: 'user' | 'bot' | 'flow', key: string): Promise<unknown>;
    set(scope: 'user' | 'bot' | 'flow', key: string, value: unknown): Promise<void>;
    delete(scope: 'user' | 'bot' | 'flow', key: string): Promise<void>;
  };
  /**
   * Stored-credential resolver (P3-T4). A node passes a `credentialId` and gets
   * back the auth HEADERS that credential injects — the decrypted secret never
   * crosses into node code (invariant I7). Resolves null when the credential is
   * missing/undecryptable or when the host has no credential store (unit tests).
   */
  credentials: {
    authHeaders(credentialId: string): Promise<Record<string, string> | null>;
  } | null;
  /** Outbound HTTP (host-limited). */
  http: {
    request(opts: {
      method: string;
      url: string;
      headers?: Record<string, string>;
      body?: string | Record<string, unknown>;
      timeoutMs?: number;
    }): Promise<{ status: number; headers: Record<string, string>; body: unknown }>;
  };
  /** Telegram sender (centralized, rate-limited). Null when flow has no chat context. */
  tg: {
    sendMessage(opts: Record<string, unknown>): Promise<{ messageId: number }>;
    /** editMessageText — optional capability (tg.menu edit_in_place, P2-T6; tg.editMessage, P3-T3). */
    editMessageText?(opts: Record<string, unknown>): Promise<void>;
    /**
     * editMessageCaption — edit the caption of a media message (P3-T3). Optional;
     * tg.editMessage falls back to a clear error when the host doesn't inject it.
     */
    editMessageCaption?(opts: Record<string, unknown>): Promise<void>;
    /**
     * editMessageReplyMarkup — replace just a message's inline keyboard (P3-T3).
     * Lets tg.editMessage swap buttons without touching text/caption.
     */
    editMessageReplyMarkup?(opts: Record<string, unknown>): Promise<void>;
    /** deleteMessage — remove a message by id (tg.deleteMessage, P3-T3). */
    deleteMessage?(opts: Record<string, unknown>): Promise<void>;
    /**
     * answerCallbackQuery — toast/alert acknowledging a button click when
     * handling raw callbacks outside Menu (tg.answerCallback, P3-T3).
     */
    answerCallbackQuery?(opts: Record<string, unknown>): Promise<void>;
    /** sendChatAction — typing / upload_photo / … indicator (tg.chatAction, P3-T3). */
    sendChatAction?(opts: Record<string, unknown>): Promise<void>;
    /**
     * sendMedia — send one media message OR an album/media-group of 2–10
     * photos/videos (tg.sendMedia, PA-T1). The host maps each `TgInputMedia` to
     * the right Bot-API call (`sendPhoto`/`sendVideo`/`sendDocument`/`sendAudio`
     * for a single item, `sendMediaGroup` for an album) and uploads any `bytes`
     * as a Telegram InputFile — so the node never touches a token or socket
     * (invariants I3/I6). Returns the ids of every message Telegram created (an
     * album yields one id per item). Optional: tg.sendMedia fails with a clear
     * error when the host doesn't inject it.
     */
    sendMedia?(opts: {
      chat_id: number | string;
      media: TgInputMedia[];
      caption?: string;
      parse_mode?: string;
      reply_markup?: unknown;
      protect_content?: boolean;
      reply_to_message_id?: number;
      disable_notification?: boolean;
    }): Promise<{ messageIds: number[] }>;
    /**
     * getFile — resolve a Telegram `file_id` and DOWNLOAD its bytes (tg.getFile,
     * PA-T2). The host calls the Bot-API `getFile` to learn the `file_path`/size,
     * then downloads the bytes from Telegram's file endpoint using the bot token
     * — so the node never touches the token or the network (invariants I3/I6).
     * Returns the raw bytes plus the metadata Telegram reported. Optional:
     * tg.getFile fails with a clear error when the host doesn't inject it.
     */
    getFile?(fileId: string): Promise<{
      bytes: Uint8Array;
      filePath: string;
      size: number | null;
      mime: string | null;
    }>;
  } | null;
  /**
   * File-store reader (tg.sendMedia `source:'file'`, PA-T1). Reads the raw bytes
   * of a CTB file id (a Collection `image`/`file` value, or a stored upload)
   * from the host's file store — the node never touches disk (invariants
   * I3/I6). Null when no file store is wired (unit tests with no store) — the
   * node then fails with a clear error. Throws if the id is unknown / not a
   * local file.
   */
  files: {
    read(fileId: string): Promise<{ bytes: Uint8Array; mime: string | null }>;
    /**
     * Store raw bytes on disk and return a CTB file id + its public projection
     * (tg.getFile `store:true`, PA-T2). The bytes are owned by THIS run's bot
     * (the host stamps `botId`); the node never touches disk (invariant I6).
     */
    write(bytes: Uint8Array, mime: string | null): Promise<TgStoredFile>;
  } | null;
  /** Structured logging into exec_logs. */
  log(level: 'debug' | 'info' | 'warn' | 'error', message: string, data?: unknown): void;
  /** Current time — injected (executor clock) so nodes computing deadlines stay testable. */
  now(): Date;
  /**
   * Sandboxed user-code runner (data.code, ARCH §8 / P2-T7). Runs `source`
   * inside the worker-pool sandbox with the standard `$` scope built from
   * `items` ($items, $json = items[0].json, plus $vars/$execution/$flow/…
   * assembled by the executor) and host-limited `$http`/`$kv` capability
   * proxies (invariant I6 — the allow-list and caps are enforced host-side).
   * Returns the script's `return` value plus captured console output.
   */
  code: {
    run(
      source: string,
      items: FlowItem[],
      opts?: { timeoutMs?: number },
    ): Promise<{ value: unknown; logs: string[] }>;
  };
  /**
   * Sub-flow runner (flow.executeSubFlow, P3-T1). Runs another flow OF THE SAME
   * BOT to completion with `items` as its entry payload, and resolves with the
   * items its `flow.return` node received (empty array if it has none). The host
   * enforces same-bot ownership and the recursion-depth cap (invariant I6 — the
   * node never instantiates an executor itself). Null when sub-flow execution is
   * not available on this instance (e.g. unit tests with no flow source).
   */
  subflow: {
    run(flowId: string, items: FlowItem[]): Promise<{ items: FlowItem[] }>;
  } | null;
  /**
   * User-profile store (data.userProfile, P3-T5). Reads/updates the per-bot
   * end-user record (the `users` table) — a GENERIC CRM-ish primitive (tags +
   * a free-form profile bag, never domain fields, invariant I2). All ops are
   * scoped to the execution's bot by the host; `tgUserId` defaults to the
   * execution's own user when omitted. Null when no user store is wired (unit
   * tests) — the node then fails with a clear error.
   */
  users: {
    /** Read a user record; null if that user has never been seen. */
    get(tgUserId?: number): Promise<CtbUser | null>;
    /** Merge (or replace) profile fields; returns the updated record. */
    setProfile(
      fields: Record<string, unknown>,
      opts?: { mode?: 'merge' | 'replace'; tgUserId?: number },
    ): Promise<CtbUser>;
    /** Add tags (de-duplicated); returns the updated record. */
    addTags(tags: string[], tgUserId?: number): Promise<CtbUser>;
    /** Remove tags; returns the updated record. */
    removeTags(tags: string[], tgUserId?: number): Promise<CtbUser>;
  } | null;
  /**
   * Collections data layer (data.collection, P3.5-T5). Generic CRUD against a
   * user-defined Collection of THIS bot, looked up by slug — as domain-agnostic
   * as `kv` (invariant I2). The host owns the schema, validation (shared
   * `validateRecord`) and the record-write event bus; the node only sees this
   * facade. Writes accept `suppressEvents` so a flow can opt out of firing
   * `collection.recordChanged` (and the host applies a depth-1 loop guard so a
   * flow's own writes never re-trigger the flow that started it). Null when no
   * collection store is wired (unit tests) — the node then fails with a clear
   * error. All ops resolve `slug` within the execution's bot.
   */
  collections: {
    /** Find records by filter → `{ records, total }` (read-time defaults applied). Throws on unknown slug. */
    find(slug: string, filter: CollectionFilter): Promise<{ records: CollectionRecord[]; total: number }>;
    /** Read one record by id (null if missing / belongs to another collection). */
    get(slug: string, recordId: string): Promise<CollectionRecord | null>;
    /** Count records matching a filter (ignores limit/offset). */
    count(slug: string, filter: CollectionFilter): Promise<number>;
    /** Insert a record (validated). Fires recordChanged unless `suppressEvents`. */
    insert(slug: string, data: Record<string, unknown>, opts?: { suppressEvents?: boolean }): Promise<CollectionRecord>;
    /** Update a record by id (merge|replace). Fires recordChanged unless suppressed. */
    update(
      slug: string,
      recordId: string,
      patch: Record<string, unknown>,
      opts?: { mode?: 'merge' | 'replace'; suppressEvents?: boolean },
    ): Promise<CollectionRecord>;
    /** Delete records by id or filter (`confirmMany` guards multi-delete). Returns #deleted. */
    delete(
      slug: string,
      target: { recordId?: string; filter?: CollectionFilter },
      opts?: { confirmMany?: boolean; suppressEvents?: boolean },
    ): Promise<number>;
  } | null;
  /**
   * LLM chat capability (ai.llmChat, P5-T1). The host resolves a stored
   * OpenAI-compatible credential (base_url + key) by id and performs the
   * `POST {baseUrl}/chat/completions` request — the decrypted key never crosses
   * into node code (invariants I6/I7); the node only passes a credentialId, the
   * model and the messages. Null when no AI service is wired (unit tests) — the
   * node then fails with a clear error. Throws on a credential miss or a
   * transport/API error so the node can surface it.
   */
  ai: {
    chat(req: AiChatRequest): Promise<AiChatResult>;
  } | null;
  /**
   * MCP client capability (ai.mcpClient, P5-T3). The host resolves a stored
   * `mcpServer` credential (endpoint URL + optional key) by id and performs the
   * Model-Context-Protocol JSON-RPC calls — the decrypted key never crosses into
   * node code (invariants I6/I7); the node only passes a credentialId plus the
   * tool name + arguments. Null when no MCP service is wired (unit tests) — the
   * node then fails with a clear error. Throws on a credential miss or a
   * transport/protocol/tool error so the node can surface it.
   */
  mcp: {
    /** List the tools the MCP server advertises (MCP `tools/list`). */
    listTools(req: McpListToolsRequest): Promise<McpTool[]>;
    /** Invoke one tool by name with arguments (MCP `tools/call`). */
    callTool(req: McpCallToolRequest): Promise<McpToolCallResult>;
  } | null;
}

/** What ai.mcpClient asks the host to list (the secret credential is resolved host-side). */
export interface McpListToolsRequest {
  /** Stored credential id (mcpServer). The host turns it into endpoint URL + key. */
  credentialId: string;
}

/** What ai.mcpClient asks the host to call. */
export interface McpCallToolRequest {
  credentialId: string;
  /** The tool's name as advertised by the server. */
  name: string;
  /** JSON arguments for the tool (shape defined by the tool's inputSchema). */
  arguments: Record<string, unknown>;
}

/** A tool advertised by an MCP server (MCP `tools/list` entry). */
export interface McpTool {
  name: string;
  description?: string;
  /** JSON Schema of the tool's arguments (best-effort; opaque to CTB). */
  inputSchema?: Record<string, unknown>;
}

/**
 * The result of an MCP `tools/call`. MCP returns `content` (an array of blocks,
 * usually text) plus an `isError` flag. We surface the raw content, a flattened
 * `text` convenience (joined text blocks), and `isError`.
 */
export interface McpToolCallResult {
  /** Raw content blocks as returned by the server. */
  content: unknown[];
  /** Text blocks joined with newlines (empty when the result has none). */
  text: string;
  /** True when the server flagged the call as an error result. */
  isError: boolean;
}

/**
 * One message in an LLM conversation (OpenAI chat-completions shape).
 *
 * The `tool` role and the assistant `toolCalls` field support the ai.agent
 * tool-calling loop (P5-T4) — they're additive and optional, so ai.llmChat
 * (which never sets them) is unaffected. An assistant turn that requests tools
 * carries `toolCalls`; the node then appends one `role:'tool'` message per call
 * (linked by `toolCallId`) carrying the tool's result, and asks the model again.
 */
export interface AiChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  /** Tool calls the assistant requested (assistant turns only, P5-T4). */
  toolCalls?: AiToolCall[];
  /** The id of the tool call this message answers (`role:'tool'` only, P5-T4). */
  toolCallId?: string;
}

/**
 * A tool the agent may call (P5-T4). The shape mirrors an OpenAI
 * function-tool: a name, a human/model-readable description, and a JSON Schema
 * of the parameters. The host translates this into the provider's `tools` array.
 */
export interface AiToolSpec {
  name: string;
  description?: string;
  /** JSON Schema of the tool's arguments (defaults to an open object). */
  parameters?: Record<string, unknown>;
}

/** One tool call the model requested in an assistant turn (P5-T4). */
export interface AiToolCall {
  /** Provider-assigned id, echoed back on the matching `role:'tool'` message. */
  id: string;
  /** The tool's name (must match a provided AiToolSpec.name). */
  name: string;
  /** Raw JSON arguments string as the model produced it (parsed by the node). */
  argumentsJson: string;
}

/** What ai.llmChat asks the host to run (the secret credential is resolved host-side). */
export interface AiChatRequest {
  /** Stored credential id (openAiApi). The host turns it into base URL + key. */
  credentialId: string;
  model: string;
  messages: AiChatMessage[];
  temperature?: number;
  maxTokens?: number;
  /** Tools the model may call (ai.agent, P5-T4). Omitted → a plain chat call. */
  tools?: AiToolSpec[];
}

/** Token-usage figures as returned by an OpenAI-compatible API (best-effort). */
export interface AiChatUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

/** The host's reply to an AiChatRequest. */
export interface AiChatResult {
  /** The assistant's text reply (first choice; empty when it only called tools). */
  reply: string;
  /** Token usage, when the provider reports it. */
  usage: AiChatUsage;
  /** The model the provider actually used (echoed back when present). */
  model?: string;
  /** Tool calls the model requested this turn (ai.agent, P5-T4). Empty/absent → none. */
  toolCalls?: AiToolCall[];
}

/** A record as seen by data.collection (the host's RecordPublic, minus host-only ids). */
export interface CollectionRecord {
  id: string;
  data: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

/** The filter shape data.collection passes to the host (mirrors shared RecordFilter). */
export interface CollectionFilter {
  where?: { field: string; op: string; value?: unknown }[];
  sort?: { field: string; dir?: 'asc' | 'desc' }[];
  limit?: number;
  offset?: number;
}

export const NodeCategorySchema = z.enum(['trigger', 'telegram', 'flow', 'data', 'ai']);
export type NodeCategory = z.infer<typeof NodeCategorySchema>;

/**
 * NodeDef — the implementation contract for packages/nodes (NODES.md §contract).
 * paramsSchema drives BOTH server-side validation and the editor's auto-form.
 */
export interface NodeDef<P = unknown> {
  type: string; // "tg.sendMessage"
  category: NodeCategory;
  /** Display metadata for the editor palette (i18n keys, not literals). */
  meta: { labelKey: string; descriptionKey?: string; icon?: string };
  ports: { inputs: PortName[]; outputs: PortName[] };
  /**
   * Some nodes (Menu, Switch) derive extra output ports from params.
   * Editor and engine both call this; defaults to static ports.outputs.
   */
  dynamicOutputs?(params: P): PortName[];
  /**
   * Top-level param keys the executor must NOT expression-resolve before
   * execute() (Decision Log #16). data.code lists `code` here: `{{ }}` is
   * valid JavaScript and must reach the sandbox verbatim — resolving it
   * would corrupt user programs.
   */
  rawParamKeys?: readonly string[];
  paramsSchema: ZodType<P>;
  execute(ctx: NodeCtx, params: P, items: FlowItem[]): Promise<NodeResult>;
}
