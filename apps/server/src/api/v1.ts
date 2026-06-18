/**
 * Public REST API v1 (P4-T3, PROTOCOL.md §Inbound REST API). The "open
 * protocol" inbound surface for n8n / scripts / AI agents — bearer-token auth,
 * NOT the panel cookie. Routes live under `/api/v1/` so the app's cookie guard
 * skips them (it only guards `/api/` paths that are NOT `/api/v1/`); this
 * router installs its own bearer-auth preHandler.
 *
 *   GET  /api/v1/node-types                                  → node catalog (PC-T1)
 *   POST /api/v1/flows               { bot_id?, botId?, name, graph? } → create (PC-T2)
 *   PATCH /api/v1/flows/:id          { name?, graph?, settings? }      → edit   (PC-T2)
 *   POST /api/v1/flows/:id/validate                          → dry-run validate (PC-T2)
 *   POST /api/v1/flows/:id/activate                          → activate         (PC-T2)
 *   POST /api/v1/flows/:id/deactivate                        → deactivate       (PC-T2)
 *   POST /api/v1/flows/:id/trigger   { chat_id?, payload? }  → start a flow run
 *   POST /api/v1/bots/:id/send       { chat_id, text, ... }  → send a TG message
 *   GET  /api/v1/executions?flow_id=&bot_id=&status=&limit=  → list executions
 *   GET  /api/v1/users?bot_id=                               → list bot users
 *
 * Auth: `Authorization: Bearer <token>`. A token may be instance-wide or scoped
 * to one bot; a bot-scoped token is rejected (403) on any request targeting a
 * different bot — the flow/bot/execution/user must all belong to its bot.
 *
 * The token's SHA-256 hash is looked up (never the plaintext); a match stamps
 * `last_used_at`. Telegram sends go through the bot's centralized rate-limited
 * sender — the raw token never crosses this edge (invariants I3/I6).
 */
import { randomUUID } from 'node:crypto';
import type { Executor, NodeRegistry } from '@ctb/core';
import {
  ApiSendMessageBodySchema,
  CreateFlowBodySchema,
  FlowGraphSchema,
  TriggerFlowBodySchema,
  UpdateFlowBodySchema,
  defaultFlowSettings,
  problemStrings,
  userDisplayName,
  validateFlowForActivation,
  type ExecutionStatus,
  type FlowItem,
  type NodeSlotMeta,
} from '@ctb/shared';
import { keyboardToMarkup } from '@ctb/nodes';
import { and, desc, eq, type SQL } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodType } from 'zod';
import type { Db } from '../db/index';
import { apiTokens, bots, executions, flowVersions, flows } from '../db/schema';
import type { SqliteFlowSource } from '../engine/flow-source';
import type { TelegramGateway } from '../telegram/gateway';
import type { SqliteUserStore } from '../engine/user-store';
import { hashApiToken, parseBearer } from '../lib/api-token';
import { nodeTypeInfos } from './node-types';
import { registerMcpApi } from './mcp';
import type { SqliteCollectionStore } from '../collections/store';

const EXEC_STATUSES = new Set<ExecutionStatus>([
  'running',
  'waiting',
  'done',
  'error',
  'canceled',
]);
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/** The authenticated token, stashed on the request for handlers. */
interface AuthedToken {
  id: string;
  /** Bot scope, or null = instance-wide. */
  botId: string | null;
}

export interface V1ApiDeps {
  db: Db;
  flowSource: SqliteFlowSource;
  executor: Executor;
  registry: NodeRegistry;
  gateway: TelegramGateway;
  userStore: SqliteUserStore;
  /**
   * Collection store (optional) — reused by the MCP `query_collection` tool
   * (PC-T3) so an external agent can read a bot's structured data. Absent ⇒
   * the tool reports `collections_not_available`.
   */
  collectionStore?: SqliteCollectionStore | undefined;
  /**
   * Called after a v1 authoring write changes which flows are active or what
   * their graphs contain (PC-T2: activate / graph edit). Wired by the server to
   * `scheduler.reconcile()` exactly like the panel's flows API, so a v1-authored
   * `schedule.trigger` flow re-arms its cron job. Decoupled by design — v1 never
   * imports the Scheduler (I3).
   */
  onFlowsChanged?: () => void;
  clock?: () => Date;
}

type FlowRow = typeof flows.$inferSelect;

/** Public projection of a flow row for the v1 authoring surface (PC-T2). */
function toPublicFlow(row: FlowRow): Record<string, unknown> {
  return {
    id: row.id,
    botId: row.botId,
    name: row.name,
    status: row.status,
    graph: row.graph,
    settings: row.settings ?? defaultFlowSettings(),
    version: row.version,
    updatedAt: row.updatedAt,
  };
}

export function registerV1Api(app: FastifyInstance, deps: V1ApiDeps): void {
  const { db, flowSource, executor, registry, gateway, userStore } = deps;
  const now = (): string => (deps.clock ?? (() => new Date()))().toISOString();
  const flowsChanged = (): void => deps.onFlowsChanged?.();

  // PC-T2: the SAME activation-validation inputs the panel's flows API uses
  // (built once — registry defs are static per process). `paramSchemas` maps a
  // node type to its Zod params schema; `nodeMeta` carries the PB-T1 typed
  // sub-connection facts (role/slots/provides). Both feed the SHARED
  // `validateFlowForActivation`, so a v1-authored flow is judged byte-identically
  // to one built in the editor (I5 — no drift between surfaces).
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

  // PC-T1: the public node CATALOG. Computed ONCE — node defs are static for a
  // process lifetime, exactly like the internal `/api/node-types` (this is the
  // SAME projection, so the bearer-auth public surface can never advertise a
  // node the engine can't execute). The `meta.labelKey`/`descriptionKey` are
  // the i18n keys whose fa/en human text lives in the editor catalog; an
  // external builder reads `type`/`category`/`role`/`ports`/`inputSlots`/
  // `provides`/`paramsJsonSchema` to know exactly what bricks exist.
  const nodeCatalogPayload = { nodeTypes: nodeTypeInfos(registry) };

  // Encapsulated scope: a bearer-auth preHandler that ONLY guards /api/v1/*.
  void app.register(async (scope) => {
    scope.addHook('preHandler', async (req, reply) => {
      const token = parseBearer(req.headers.authorization);
      if (!token) {
        return reply.code(401).send({ error: 'missing_bearer_token' });
      }
      const row = db
        .select()
        .from(apiTokens)
        .where(eq(apiTokens.tokenHash, hashApiToken(token)))
        .get();
      if (!row) {
        return reply.code(401).send({ error: 'invalid_token' });
      }
      // Stamp last-used (best-effort; never block the request on it).
      try {
        db.update(apiTokens).set({ lastUsedAt: now() }).where(eq(apiTokens.id, row.id)).run();
      } catch {
        /* ignore */
      }
      (req as FastifyRequest & { apiToken: AuthedToken }).apiToken = {
        id: row.id,
        botId: row.botId,
      };
    });

    /** A bot-scoped token may only act on its own bot. */
    const tokenAllowsBot = (req: FastifyRequest, botId: string): boolean => {
      const tok = (req as FastifyRequest & { apiToken: AuthedToken }).apiToken;
      return tok.botId === null || tok.botId === botId;
    };

    // ---- GET /api/v1/node-types (PC-T1) ----------------------------------
    // The machine-readable node catalog. Any valid token (instance-wide OR
    // bot-scoped) may read it — the node library is the SAME for every bot, so
    // there is nothing bot-specific to scope here.
    scope.get('/api/v1/node-types', async () => nodeCatalogPayload);

    // ---- POST /api/v1/mcp (PC-T3) ----------------------------------------
    // CTB as an MCP *server*: a streamable-HTTP JSON-RPC endpoint exposing the
    // builder capabilities (list_nodes / validate_flow / create_flow /
    // trigger_flow / query_collection / send_message) to external AI agents.
    // Mounted INSIDE this bearer-auth scope so it shares the same token guard;
    // each tool reads the per-request token's bot scope via `tokenAllowsBot`'s
    // source. Reuses the SAME engine handles + shared schemas as the REST
    // routes above (I5 — a flow built over MCP equals one built over REST).
    registerMcpApi({
      scope,
      db,
      flowSource,
      executor,
      registry,
      gateway,
      collectionStore: deps.collectionStore,
      tokenBotId: (req) =>
        (req as FastifyRequest & { apiToken: AuthedToken }).apiToken.botId,
      now,
      onFlowsChanged: deps.onFlowsChanged,
    });

    // ====================================================================
    // PC-T2 — Flow authoring surface. An external agent can build, validate,
    // and activate a flow (not just trigger one). Every write reuses the SAME
    // shared schemas + validator as the panel's flows API (I5), so a v1-authored
    // flow is identical to an editor-built one. Bot scope is enforced: a
    // bot-scoped token may only author on its own bot.
    // ====================================================================

    // ---- POST /api/v1/flows ----------------------------------------------
    // Create a draft flow. Body: { botId | bot_id, name, graph? } — graph
    // defaults to an empty graph (CreateFlowBodySchema). The graph is validated
    // by FlowGraphSchema; a draft is NOT activation-checked (that's /activate).
    scope.post('/api/v1/flows', async (req, reply) => {
      // Accept snake_case `bot_id` (the v1 convention) as an alias of `botId`.
      const raw = (req.body ?? {}) as Record<string, unknown>;
      const body =
        raw['botId'] === undefined && raw['bot_id'] !== undefined
          ? { ...raw, botId: raw['bot_id'] }
          : raw;
      const parsed = CreateFlowBodySchema.safeParse(body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid_body', issues: parsed.error.issues });
      }
      if (!tokenAllowsBot(req, parsed.data.botId)) {
        return reply.code(403).send({ error: 'token_not_authorized_for_bot' });
      }
      const bot = db.select().from(bots).where(eq(bots.id, parsed.data.botId)).get();
      if (!bot) return reply.code(400).send({ error: 'unknown_bot' });

      const row: FlowRow = {
        id: randomUUID(),
        botId: parsed.data.botId,
        name: parsed.data.name,
        status: 'draft',
        graph: parsed.data.graph,
        settings: defaultFlowSettings(),
        version: 1,
        updatedAt: now(),
      };
      db.insert(flows).values(row).run();
      return reply.code(201).send({ flow: toPublicFlow(row) });
    });

    // ---- PATCH /api/v1/flows/:id -----------------------------------------
    // Edit name / graph / settings. A graph change snapshots the outgoing
    // version (rollback stays available) and bumps `version`, exactly like the
    // panel's PATCH. Editing an ACTIVE flow's graph re-arms its schedules.
    scope.patch('/api/v1/flows/:id', async (req, reply) => {
      const { id } = req.params as { id: string };
      const parsed = UpdateFlowBodySchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid_body', issues: parsed.error.issues });
      }
      const row = db.select().from(flows).where(eq(flows.id, id)).get();
      if (!row) return reply.code(404).send({ error: 'flow_not_found' });
      if (!tokenAllowsBot(req, row.botId)) {
        return reply.code(403).send({ error: 'token_not_authorized_for_bot' });
      }

      const patch: Partial<FlowRow> = { updatedAt: now() };
      if (parsed.data.name !== undefined) patch.name = parsed.data.name;
      if (parsed.data.settings !== undefined) {
        // The error-handler must be another flow OF THE SAME BOT (mirrors the
        // panel's PATCH rule) — a cross-bot handler can never run here, and a
        // self-handler would loop on every failure.
        const handlerId = parsed.data.settings.errorHandlerFlowId;
        if (handlerId !== null) {
          if (handlerId === id) {
            return reply.code(400).send({ error: 'error_handler_self' });
          }
          const handler = db.select().from(flows).where(eq(flows.id, handlerId)).get();
          if (!handler || handler.botId !== row.botId) {
            return reply.code(400).send({ error: 'error_handler_not_same_bot' });
          }
        }
        patch.settings = parsed.data.settings;
      }
      if (parsed.data.graph !== undefined) {
        db.insert(flowVersions)
          .values({
            id: randomUUID(),
            flowId: row.id,
            version: row.version,
            graph: row.graph,
            createdAt: now(),
          })
          .run();
        patch.graph = parsed.data.graph;
        patch.version = row.version + 1;
      }
      db.update(flows).set(patch).where(eq(flows.id, id)).run();
      const updated = db.select().from(flows).where(eq(flows.id, id)).get()!;
      if (updated.status === 'active' && parsed.data.graph !== undefined) flowsChanged();
      return { flow: toPublicFlow(updated) };
    });

    // ---- POST /api/v1/flows/:id/validate ---------------------------------
    // Dry-run: report the activation problems of the STORED graph WITHOUT
    // changing anything. `{ ok, problems[], nodeProblems[] }` — the same
    // problem shape the panel's /activate returns on 422.
    scope.post('/api/v1/flows/:id/validate', async (req, reply) => {
      const { id } = req.params as { id: string };
      const row = db.select().from(flows).where(eq(flows.id, id)).get();
      if (!row) return reply.code(404).send({ error: 'flow_not_found' });
      if (!tokenAllowsBot(req, row.botId)) {
        return reply.code(403).send({ error: 'token_not_authorized_for_bot' });
      }
      const graph = FlowGraphSchema.safeParse(row.graph);
      if (!graph.success) {
        return reply.code(422).send({ error: 'invalid_graph', issues: graph.error.issues });
      }
      const nodeProblems = validateFlowForActivation(graph.data, paramSchemas, nodeMeta);
      return {
        ok: nodeProblems.length === 0,
        problems: problemStrings(nodeProblems),
        nodeProblems,
      };
    });

    // ---- POST /api/v1/flows/:id/activate ---------------------------------
    // Validate + flip to active. 422 with problems if not activatable.
    scope.post('/api/v1/flows/:id/activate', async (req, reply) => {
      const { id } = req.params as { id: string };
      const row = db.select().from(flows).where(eq(flows.id, id)).get();
      if (!row) return reply.code(404).send({ error: 'flow_not_found' });
      if (!tokenAllowsBot(req, row.botId)) {
        return reply.code(403).send({ error: 'token_not_authorized_for_bot' });
      }
      const graph = FlowGraphSchema.safeParse(row.graph);
      if (!graph.success) {
        return reply.code(422).send({ error: 'invalid_graph', issues: graph.error.issues });
      }
      const nodeProblems = validateFlowForActivation(graph.data, paramSchemas, nodeMeta);
      if (nodeProblems.length > 0) {
        return reply
          .code(422)
          .send({ error: 'not_activatable', problems: problemStrings(nodeProblems), nodeProblems });
      }
      db.update(flows).set({ status: 'active', updatedAt: now() }).where(eq(flows.id, id)).run();
      flowsChanged();
      return { ok: true, status: 'active' };
    });

    // ---- POST /api/v1/flows/:id/deactivate -------------------------------
    scope.post('/api/v1/flows/:id/deactivate', async (req, reply) => {
      const { id } = req.params as { id: string };
      const row = db.select().from(flows).where(eq(flows.id, id)).get();
      if (!row) return reply.code(404).send({ error: 'flow_not_found' });
      if (!tokenAllowsBot(req, row.botId)) {
        return reply.code(403).send({ error: 'token_not_authorized_for_bot' });
      }
      const res = db
        .update(flows)
        .set({ status: 'draft', updatedAt: now() })
        .where(and(eq(flows.id, id), eq(flows.status, 'active')))
        .run();
      if (res.changes > 0) flowsChanged();
      return { ok: true, status: 'draft' };
    });

    // ---- POST /api/v1/flows/:id/trigger ----------------------------------
    scope.post('/api/v1/flows/:id/trigger', async (req, reply) => {
      const { id } = req.params as { id: string };
      const parsed = TriggerFlowBodySchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid_body', issues: parsed.error.issues });
      }

      const flowRow = db.select().from(flows).where(eq(flows.id, id)).get();
      if (!flowRow) return reply.code(404).send({ error: 'flow_not_found' });
      if (!tokenAllowsBot(req, flowRow.botId)) {
        return reply.code(403).send({ error: 'token_not_authorized_for_bot' });
      }

      const flow = await flowSource.getFlow(id);
      if (!flow) return reply.code(422).send({ error: 'invalid_graph' });

      // Enter at the flow's first enabled trigger node (any trigger category —
      // tg.trigger / manual / webhook / schedule all pass items through on main).
      const entry = flow.graph.nodes.find(
        (n) => !n.disabled && registry.get(n.type).category === 'trigger',
      );
      if (!entry) return reply.code(422).send({ error: 'no_trigger_node' });

      // chat_id is optional — coerce a numeric string to a number so Telegram
      // nodes get a real chat id; a non-numeric string (e.g. "@channel") rides
      // through as-is. Omitted ⇒ chatless run (the flow resolves its own chat).
      let chatId: number | null = null;
      if (parsed.data.chat_id !== undefined) {
        const c = parsed.data.chat_id;
        chatId = typeof c === 'number' ? c : Number.isFinite(Number(c)) ? Number(c) : null;
      }

      const item: FlowItem = {
        json: {
          source: 'api',
          ...(parsed.data.payload !== undefined ? { payload: parsed.data.payload } : {}),
          ...(parsed.data.chat_id !== undefined ? { chat_id: parsed.data.chat_id } : {}),
        },
      };

      const executionId = randomUUID();
      // Fire-and-forget: the public API is async (mirrors the webhook async
      // mode). The caller polls GET /api/v1/executions for the outcome.
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

      return reply.code(202).send({ ok: true, executionId });
    });

    // ---- POST /api/v1/bots/:id/send --------------------------------------
    scope.post('/api/v1/bots/:id/send', async (req, reply) => {
      const { id } = req.params as { id: string };
      const parsed = ApiSendMessageBodySchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid_body', issues: parsed.error.issues });
      }
      if (!tokenAllowsBot(req, id)) {
        return reply.code(403).send({ error: 'token_not_authorized_for_bot' });
      }

      const botRow = db.select().from(bots).where(eq(bots.id, id)).get();
      if (!botRow) return reply.code(404).send({ error: 'bot_not_found' });

      const handle = gateway.get(id);
      if (!handle) {
        // The bot exists but isn't started — there's no sender to use.
        return reply.code(409).send({ error: 'bot_not_running' });
      }

      try {
        const sent = await handle.sender.sendMessage({
          chat_id: parsed.data.chat_id,
          text: parsed.data.text,
          ...(parsed.data.parse_mode ? { parse_mode: parsed.data.parse_mode } : {}),
          ...(parsed.data.keyboard
            ? { reply_markup: keyboardToMarkup(parsed.data.keyboard) }
            : {}),
        });
        return reply.code(200).send({ ok: true, messageId: sent.messageId });
      } catch (err) {
        req.log.error({ err }, `v1 send failed for bot ${id}`);
        return reply.code(502).send({ error: 'send_failed' });
      }
    });

    // ---- GET /api/v1/executions ------------------------------------------
    scope.get('/api/v1/executions', async (req, reply) => {
      const q = req.query as {
        flow_id?: string;
        bot_id?: string;
        status?: string;
        limit?: string;
      };
      if (q.status !== undefined && !EXEC_STATUSES.has(q.status as ExecutionStatus)) {
        return reply.code(400).send({ error: 'invalid_status' });
      }
      const limit = Math.min(Math.max(Number(q.limit) || DEFAULT_LIMIT, 1), MAX_LIMIT);

      const tok = (req as FastifyRequest & { apiToken: AuthedToken }).apiToken;
      const conds: SQL[] = [];
      if (q.flow_id) conds.push(eq(executions.flowId, q.flow_id));
      if (q.bot_id) {
        if (!tokenAllowsBot(req, q.bot_id)) {
          return reply.code(403).send({ error: 'token_not_authorized_for_bot' });
        }
        conds.push(eq(executions.botId, q.bot_id));
      }
      // A bot-scoped token only ever sees its own bot's executions.
      if (tok.botId !== null) conds.push(eq(executions.botId, tok.botId));
      if (q.status) conds.push(eq(executions.status, q.status as ExecutionStatus));

      const base = db.select().from(executions);
      const rows = (conds.length > 0 ? base.where(and(...conds)) : base)
        .orderBy(desc(executions.startedAt))
        .limit(limit)
        .all();

      return {
        executions: rows.map((r) => ({
          id: r.id,
          flowId: r.flowId,
          botId: r.botId,
          chatId: r.chatId,
          status: r.status,
          error: r.error,
          startedAt: r.startedAt,
          updatedAt: r.updatedAt,
        })),
      };
    });

    // ---- GET /api/v1/users ------------------------------------------------
    scope.get('/api/v1/users', async (req, reply) => {
      const q = req.query as { bot_id?: string; limit?: string; offset?: string };
      if (!q.bot_id) return reply.code(400).send({ error: 'bot_id_required' });
      if (!tokenAllowsBot(req, q.bot_id)) {
        return reply.code(403).send({ error: 'token_not_authorized_for_bot' });
      }
      const rows = userStore.list(q.bot_id, {
        ...(q.limit !== undefined ? { limit: Number(q.limit) } : {}),
        ...(q.offset !== undefined ? { offset: Number(q.offset) } : {}),
      });
      return {
        users: rows.map((r) => ({
          id: r.id,
          botId: q.bot_id,
          tgUserId: r.user.tgUserId,
          profile: r.user.profile,
          tags: r.user.tags,
          firstSeen: r.user.firstSeen,
          lastSeen: r.user.lastSeen,
          displayName: userDisplayName(r.user),
        })),
      };
    });
  });
}
