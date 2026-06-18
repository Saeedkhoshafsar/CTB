/**
 * CTB as an MCP *server* (PC-T3, PROTOCOL.md §MCP server). Exposes CTB's core
 * builder capabilities as Model-Context-Protocol tools so an *external* AI agent
 * (Claude Desktop, an IDE assistant, another orchestrator) can discover the node
 * library and assemble/run flows programmatically. This is the INVERSE of the
 * `ai.mcpClient` node (P5-T3, where a CTB agent *consumes* a remote MCP server).
 *
 * Transport: streamable-HTTP MCP — a single `POST /api/v1/mcp` endpoint speaking
 * plain JSON-RPC 2.0 (the wire format the MCP spec is built on). We implement
 * the protocol natively (no MCP SDK dependency) so it lives INSIDE the existing
 * bearer-auth `/api/v1` scope and reuses the EXACT capabilities the REST routes
 * expose — there is therefore NO surface drift (I5): a flow created over MCP is
 * byte-identical to one created over REST or in the editor.
 *
 * Methods handled:
 *   initialize                      → protocol handshake + capabilities
 *   notifications/initialized       → (notification, no response)
 *   ping                            → {}
 *   tools/list                      → the 6 CTB tools + their JSON Schemas
 *   tools/call { name, arguments }  → run one tool, return its result content
 *
 * Tools (all bounded by the calling token's bot scope, like the REST surface):
 *   list_nodes        — the node catalog (same projection as GET /api/v1/node-types)
 *   validate_flow     — dry-run activation check of a graph (nothing saved)
 *   create_flow       — create a draft flow (same as POST /api/v1/flows)
 *   trigger_flow      — start a run of an existing flow
 *   query_collection  — read records from a bot Collection (filterable)
 *   send_message      — send a Telegram message via the bot's rate-limited sender
 *
 * Auth: this router is mounted via `registerMcpApi` which the v1 router calls
 * from INSIDE its bearer-auth scope, so the same `Authorization: Bearer ctb_…`
 * preHandler guards it and the authenticated token (bot scope) is on the request.
 */
import { randomUUID } from 'node:crypto';
import type { NodeRegistry } from '@ctb/core';
import {
  CreateFlowBodySchema,
  FlowGraphSchema,
  JSON_RPC_ERRORS,
  JsonRpcRequestSchema,
  MCP_PROTOCOL_VERSION,
  MCP_SERVER_INFO,
  McpToolCallParamsSchema,
  RecordFilterSchema,
  defaultFlowSettings,
  problemStrings,
  validateFlowForActivation,
  type FlowItem,
  type JsonRpcId,
  type JsonRpcResponse,
  type NodeSlotMeta,
} from '@ctb/shared';
import { keyboardToMarkup } from '@ctb/nodes';
import { eq } from 'drizzle-orm';
import { z, type ZodType } from 'zod';
import { bots, flows } from '../db/schema';
import { nodeTypeInfos } from './node-types';
import type { McpDeps } from './mcp-deps';

/** A JSON-RPC result envelope. */
function ok(id: JsonRpcId, result: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id, result };
}

/** A JSON-RPC error envelope. */
function err(id: JsonRpcId, code: number, message: string, data?: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id, error: data === undefined ? { code, message } : { code, message, data } };
}

/**
 * MCP `tools/call` results carry a `content` array of typed blocks. We return a
 * single JSON text block (the canonical MCP way to ship structured data to a
 * model) plus `isError` on a tool-level failure (distinct from a JSON-RPC
 * protocol error — the call SUCCEEDED, the tool reported a problem).
 */
function toolResult(value: unknown, isError = false): { content: { type: 'text'; text: string }[]; isError?: boolean } {
  const block = { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] };
  return isError ? { ...block, isError: true } : block;
}

/** A tool whose arguments failed validation → an MCP tool-level error result. */
function toolBadArgs(parsed: z.ZodError): ReturnType<typeof toolResult> {
  return toolResult({ error: 'invalid_arguments', issues: parsed.issues }, true);
}

/**
 * Register the MCP endpoint on an already-bearer-authenticated Fastify scope.
 * Called from `registerV1Api` so the token (and its bot scope) is on the request.
 */
export function registerMcpApi(deps: McpDeps): void {
  const { scope, db, flowSource, executor, registry, gateway, collectionStore } = deps;
  const now = (): string => deps.now();
  const flowsChanged = (): void => deps.onFlowsChanged?.();

  // The SAME activation-validation inputs the REST flows surface uses (I5).
  const paramSchemas: ReadonlyMap<string, ZodType> = new Map(
    registry.list().map((def) => [def.type, def.paramsSchema]),
  );
  const nodeMeta: ReadonlyMap<string, NodeSlotMeta> = new Map(
    registry.list().map((def) => {
      const m: NodeSlotMeta = {};
      if (def.role) m.role = def.role;
      if (def.inputSlots) m.inputSlots = def.inputSlots;
      if (def.provides) m.provides = def.provides;
      return [def.type, m] as const;
    }),
  );

  // The node catalog — computed once, the SAME projection as GET /api/v1/node-types.
  const nodeCatalog = { nodeTypes: nodeTypeInfos(registry) };

  // ---- JSON Schemas for each tool's `arguments` -------------------------
  // Reuse the SHARED Zod schemas (I5) where one exists, so the MCP-advertised
  // argument shape matches what the REST routes accept byte-for-byte.
  const flowGraphJson = z.toJSONSchema(FlowGraphSchema as ZodType, { target: 'draft-2020-12' });
  const recordFilterJson = z.toJSONSchema(RecordFilterSchema as ZodType, { target: 'draft-2020-12' });

  const TOOLS = [
    {
      name: 'list_nodes',
      description:
        'List every node type CTB can run (the builder palette). Returns each node\'s type, category, params JSON-Schema, and typed sub-connection surface. Call this first to discover what bricks exist before building a flow.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
      name: 'validate_flow',
      description:
        'Dry-run the activation check on a flow graph WITHOUT saving anything. Returns { ok, problems[] } — use it to confirm a graph is activatable before create_flow + activate.',
      inputSchema: {
        type: 'object',
        properties: { graph: flowGraphJson },
        required: ['graph'],
        additionalProperties: false,
      },
    },
    {
      name: 'create_flow',
      description:
        'Create a DRAFT flow for a bot. Body: { bot_id, name, graph? }. Returns the created flow (id, status:draft). Activate it afterwards via the REST /api/v1/flows/:id/activate route.',
      inputSchema: {
        type: 'object',
        properties: {
          bot_id: { type: 'string', description: 'The bot this flow belongs to.' },
          name: { type: 'string', description: 'Human-readable flow name.' },
          graph: flowGraphJson,
        },
        required: ['bot_id', 'name'],
        additionalProperties: false,
      },
    },
    {
      name: 'trigger_flow',
      description:
        'Start a run of an existing flow. Body: { flow_id, chat_id?, payload? }. Async (fire-and-forget) — returns { executionId }; poll executions via REST for the outcome.',
      inputSchema: {
        type: 'object',
        properties: {
          flow_id: { type: 'string' },
          chat_id: { type: ['string', 'number'] },
          payload: { type: 'object', additionalProperties: true },
        },
        required: ['flow_id'],
        additionalProperties: false,
      },
    },
    {
      name: 'query_collection',
      description:
        'Read records from a bot Collection (structured data store) by slug. Body: { bot_id, collection, filter? }. Returns { records, total }. The filter is the standard CTB record filter (where/sort/limit/offset).',
      inputSchema: {
        type: 'object',
        properties: {
          bot_id: { type: 'string' },
          collection: { type: 'string', description: 'The collection slug.' },
          filter: recordFilterJson,
        },
        required: ['bot_id', 'collection'],
        additionalProperties: false,
      },
    },
    {
      name: 'send_message',
      description:
        'Send a Telegram text message from a bot. Body: { bot_id, chat_id, text, parse_mode? }. The bot must be running. Returns { messageId }.',
      inputSchema: {
        type: 'object',
        properties: {
          bot_id: { type: 'string' },
          chat_id: { type: ['string', 'number'] },
          text: { type: 'string' },
          parse_mode: { type: 'string', enum: ['HTML', 'MarkdownV2'] },
        },
        required: ['bot_id', 'chat_id', 'text'],
        additionalProperties: false,
      },
    },
  ] as const;

  // ---- argument schemas for the bot-targeting tools --------------------
  // (create_flow reuses CreateFlowBodySchema after a bot_id→botId alias.)
  const TriggerArgs = z.object({
    flow_id: z.string().min(1),
    chat_id: z.union([z.string(), z.number()]).optional(),
    payload: z.record(z.string(), z.unknown()).optional(),
  });
  const QueryArgs = z.object({
    bot_id: z.string().min(1),
    collection: z.string().min(1),
    filter: RecordFilterSchema.partial().optional(),
  });
  // parse_mode matches the REST send surface EXACTLY (I5): only HTML / MarkdownV2.
  const SendArgs = z.object({
    bot_id: z.string().min(1),
    chat_id: z.union([z.string(), z.number()]),
    text: z.string().min(1),
    parse_mode: z.enum(['HTML', 'MarkdownV2']).optional(),
  });

  // ---- the six tool implementations ------------------------------------
  // Each returns an MCP tool result; bot-scope and not-found are tool-level
  // errors (the call succeeded, the tool reported a problem), NOT JSON-RPC
  // errors (which are reserved for malformed protocol messages). `tokenBotId`
  // is the per-request token's bot scope (null = instance-wide); `allowsBot`
  // mirrors the REST router's `tokenAllowsBot`.

  async function runTool(
    name: string,
    args: Record<string, unknown>,
    tokenBotId: string | null,
  ): Promise<ReturnType<typeof toolResult>> {
    const allowsBot = (botId: string): boolean => tokenBotId === null || tokenBotId === botId;
    switch (name) {
      case 'list_nodes':
        return toolResult(nodeCatalog);

      case 'validate_flow': {
        const graph = FlowGraphSchema.safeParse(args['graph']);
        if (!graph.success) return toolBadArgs(graph.error);
        const nodeProblems = validateFlowForActivation(graph.data, paramSchemas, nodeMeta);
        return toolResult({ ok: nodeProblems.length === 0, problems: problemStrings(nodeProblems), nodeProblems });
      }

      case 'create_flow': {
        // Accept snake_case bot_id (the v1 convention) as the botId alias.
        const aliased =
          args['botId'] === undefined && args['bot_id'] !== undefined
            ? { ...args, botId: args['bot_id'] }
            : args;
        const parsed = CreateFlowBodySchema.safeParse(aliased);
        if (!parsed.success) return toolBadArgs(parsed.error);
        if (!allowsBot(parsed.data.botId)) {
          return toolResult({ error: 'token_not_authorized_for_bot' }, true);
        }
        const bot = db.select().from(bots).where(eq(bots.id, parsed.data.botId)).get();
        if (!bot) return toolResult({ error: 'unknown_bot' }, true);
        const row = {
          id: randomUUID(),
          botId: parsed.data.botId,
          name: parsed.data.name,
          status: 'draft' as const,
          graph: parsed.data.graph,
          settings: defaultFlowSettings(),
          version: 1,
          updatedAt: now(),
        };
        db.insert(flows).values(row).run();
        return toolResult({
          flow: {
            id: row.id,
            botId: row.botId,
            name: row.name,
            status: row.status,
            version: row.version,
          },
        });
      }

      case 'trigger_flow': {
        const parsed = TriggerArgs.safeParse(args);
        if (!parsed.success) return toolBadArgs(parsed.error);
        const flowRow = db.select().from(flows).where(eq(flows.id, parsed.data.flow_id)).get();
        if (!flowRow) return toolResult({ error: 'flow_not_found' }, true);
        if (!allowsBot(flowRow.botId)) {
          return toolResult({ error: 'token_not_authorized_for_bot' }, true);
        }
        const flow = await flowSource.getFlow(parsed.data.flow_id);
        if (!flow) return toolResult({ error: 'invalid_graph' }, true);
        const entry = flow.graph.nodes.find(
          (n) => !n.disabled && registry.get(n.type).category === 'trigger',
        );
        if (!entry) return toolResult({ error: 'no_trigger_node' }, true);

        let chatId: number | null = null;
        if (parsed.data.chat_id !== undefined) {
          const c = parsed.data.chat_id;
          chatId = typeof c === 'number' ? c : Number.isFinite(Number(c)) ? Number(c) : null;
        }
        const item: FlowItem = {
          json: {
            source: 'mcp',
            ...(parsed.data.payload !== undefined ? { payload: parsed.data.payload } : {}),
            ...(parsed.data.chat_id !== undefined ? { chat_id: parsed.data.chat_id } : {}),
          },
        };
        const executionId = randomUUID();
        void executor
          .start({
            executionId,
            flow: { id: flow.id, name: flow.name },
            graph: flow.graph,
            botId: flowRow.botId,
            chatId,
            userId: null,
            entry: { nodeId: entry.id, items: { main: [item] } },
          })
          .catch(() => undefined);
        return toolResult({ ok: true, executionId });
      }

      case 'query_collection': {
        const parsed = QueryArgs.safeParse(args);
        if (!parsed.success) return toolBadArgs(parsed.error);
        if (!allowsBot(parsed.data.bot_id)) {
          return toolResult({ error: 'token_not_authorized_for_bot' }, true);
        }
        if (!collectionStore) {
          return toolResult({ error: 'collections_not_available' }, true);
        }
        const col = collectionStore.getBySlug(parsed.data.bot_id, parsed.data.collection);
        if (!col) return toolResult({ error: 'collection_not_found' }, true);
        // Build a clean filter omitting absent keys (exactOptionalPropertyTypes).
        const f = parsed.data.filter ?? {};
        const filter: Parameters<typeof collectionStore.find>[1] = {
          ...(f.where !== undefined ? { where: f.where } : {}),
          ...(f.sort !== undefined ? { sort: f.sort } : {}),
          ...(f.limit !== undefined ? { limit: f.limit } : {}),
          ...(f.offset !== undefined ? { offset: f.offset } : {}),
        };
        const res = collectionStore.find(col.id, filter);
        return toolResult({ records: res.records, total: res.total });
      }

      case 'send_message': {
        const parsed = SendArgs.safeParse(args);
        if (!parsed.success) return toolBadArgs(parsed.error);
        if (!allowsBot(parsed.data.bot_id)) {
          return toolResult({ error: 'token_not_authorized_for_bot' }, true);
        }
        const botRow = db.select().from(bots).where(eq(bots.id, parsed.data.bot_id)).get();
        if (!botRow) return toolResult({ error: 'bot_not_found' }, true);
        const handle = gateway.get(parsed.data.bot_id);
        if (!handle) return toolResult({ error: 'bot_not_running' }, true);
        try {
          const sent = await handle.sender.sendMessage({
            chat_id: parsed.data.chat_id,
            text: parsed.data.text,
            ...(parsed.data.parse_mode ? { parse_mode: parsed.data.parse_mode } : {}),
          });
          return toolResult({ ok: true, messageId: sent.messageId });
        } catch {
          return toolResult({ error: 'send_failed' }, true);
        }
      }

      default:
        return toolResult({ error: `unknown_tool: ${name}` }, true);
    }
  }

  // ---- the streamable-HTTP JSON-RPC endpoint ---------------------------
  scope.post('/api/v1/mcp', async (req, reply) => {
    const parsed = JsonRpcRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .code(200)
        .send(err(null, JSON_RPC_ERRORS.invalidRequest, 'invalid JSON-RPC request', parsed.error.issues));
    }
    const msg = parsed.data;
    const id: JsonRpcId = msg.id ?? null;
    const isNotification = msg.id === undefined;

    // Notifications (no id) get an empty 202 ack and never a JSON-RPC response.
    if (isNotification) {
      return reply.code(202).send();
    }

    switch (msg.method) {
      case 'initialize':
        return reply.send(
          ok(id, {
            protocolVersion: MCP_PROTOCOL_VERSION,
            capabilities: { tools: { listChanged: false } },
            serverInfo: MCP_SERVER_INFO,
            instructions:
              'CTB builder MCP server. Use list_nodes to discover node types, validate_flow to dry-run a graph, create_flow to save a draft, trigger_flow to run one, query_collection to read structured data, and send_message to message a chat. All calls are bounded by your token\'s bot scope.',
          }),
        );

      case 'ping':
        return reply.send(ok(id, {}));

      case 'tools/list':
        return reply.send(ok(id, { tools: TOOLS }));

      case 'tools/call': {
        const callParsed = McpToolCallParamsSchema.safeParse(msg.params);
        if (!callParsed.success) {
          return reply.send(
            err(id, JSON_RPC_ERRORS.invalidParams, 'invalid tools/call params', callParsed.error.issues),
          );
        }
        if (!TOOLS.some((t) => t.name === callParsed.data.name)) {
          return reply.send(err(id, JSON_RPC_ERRORS.invalidParams, `unknown tool: ${callParsed.data.name}`));
        }
        try {
          const result = await runTool(
            callParsed.data.name,
            callParsed.data.arguments,
            deps.tokenBotId(req),
          );
          return reply.send(ok(id, result));
        } catch (e) {
          req.log.error({ err: e }, `mcp tool ${callParsed.data.name} threw`);
          return reply.send(err(id, JSON_RPC_ERRORS.internalError, 'tool execution failed'));
        }
      }

      default:
        return reply.send(err(id, JSON_RPC_ERRORS.methodNotFound, `method not found: ${msg.method}`));
    }
  });

  // The MCP tools never toggle which flows are ACTIVE: create_flow only makes a
  // DRAFT, and trigger_flow runs an existing flow without changing the active
  // set. So the scheduler never needs reconciling here — `onFlowsChanged` stays
  // referenced for parity with the REST surface but is intentionally not fired.
  void flowsChanged;
}
