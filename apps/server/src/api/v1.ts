/**
 * Public REST API v1 (P4-T3, PROTOCOL.md §Inbound REST API). The "open
 * protocol" inbound surface for n8n / scripts / AI agents — bearer-token auth,
 * NOT the panel cookie. Routes live under `/api/v1/` so the app's cookie guard
 * skips them (it only guards `/api/` paths that are NOT `/api/v1/`); this
 * router installs its own bearer-auth preHandler.
 *
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
  TriggerFlowBodySchema,
  userDisplayName,
  type ExecutionStatus,
  type FlowItem,
} from '@ctb/shared';
import { keyboardToMarkup } from '@ctb/nodes';
import { and, desc, eq, type SQL } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Db } from '../db/index';
import { apiTokens, bots, executions, flows } from '../db/schema';
import type { SqliteFlowSource } from '../engine/flow-source';
import type { TelegramGateway } from '../telegram/gateway';
import type { SqliteUserStore } from '../engine/user-store';
import { hashApiToken, parseBearer } from '../lib/api-token';

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
  clock?: () => Date;
}

export function registerV1Api(app: FastifyInstance, deps: V1ApiDeps): void {
  const { db, flowSource, executor, registry, gateway, userStore } = deps;
  const now = (): string => (deps.clock ?? (() => new Date()))().toISOString();

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
