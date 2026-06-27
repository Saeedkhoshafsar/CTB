/**
 * Executions REST API (P2-T3.5 read endpoints + P2-T5 cancel).
 *
 *   GET  /api/executions?flowId=&status=&limit=  → ExecutionSummary[]
 *   GET  /api/executions/:id                     → ExecutionDetail (logs incl.
 *                                                  per-step I/O item snapshots)
 *   POST /api/executions/:id/cancel              → waiting/running → canceled
 *
 * The editor's node detail view (NDV) loads the latest execution of the open
 * flow and maps exec_logs "executed" rows (input/output FlowItems, recorded
 * by the executor with LOG_ITEMS_CAP) onto canvas nodes — the n8n pattern:
 * INPUT pane | params | OUTPUT pane. The P2-T5 inspector page lists/filters
 * executions, renders the node-by-node log and cancels stuck conversations.
 *
 * Cancel semantics mirror the router's /cancel path: status → canceled,
 * wait cleared (the timeout scanner ignores non-waiting rows; the chat is
 * free for a fresh trigger). Finished executions can't be canceled → 409 —
 * the inspector disables the button, but a refresh race must still be safe.
 */
import type { ExecLogEntry, ExecutionSummary } from '@ctb/shared';
import { and, desc, eq, inArray, type SQL } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { Db } from '../db/index';
import { execLogs, executions } from '../db/schema';

type ExecRow = typeof executions.$inferSelect;
type LogRow = typeof execLogs.$inferSelect;

const STATUSES = new Set(['running', 'waiting', 'done', 'error', 'canceled']);
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

function toSummary(row: ExecRow): ExecutionSummary {
  return {
    id: row.id,
    flowId: row.flowId,
    botId: row.botId,
    chatId: row.chatId,
    status: row.status,
    error: row.error,
    startedAt: row.startedAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Is this stored `output` value a real per-port FlowItem map
 * (`Record<string, FlowItem[]>`) rather than an ad-hoc debug marker like
 * `{ kind: 'error' }`? The error-snapshot row (executor) writes the generic
 * `data` marker into the output column, which is NOT a port map — serving it as
 * `output` made the editor's data pane iterate a non-array and crash the whole
 * NDV to a black screen. We only expose `output` when every value is an array.
 */
function isPortMap(value: unknown): value is ExecLogEntry['output'] {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.values(value as Record<string, unknown>).every((v) => Array.isArray(v));
}

function toLog(row: LogRow): ExecLogEntry {
  // Only "executed" steps carry item snapshots; generic rows reuse the output
  // column for ad-hoc debug data which is NOT the FlowItem map — hide it here
  // so the DTO stays honest (the P2-T5 inspector will surface it separately).
  const hasIo = row.input !== null && row.input !== undefined;
  return {
    id: row.id,
    nodeId: row.nodeId,
    level: row.level,
    message: row.message,
    input: hasIo ? (row.input as ExecLogEntry['input']) : null,
    // Guard the output shape (see isPortMap): a non-port-map marker → null.
    output: hasIo && isPortMap(row.output) ? (row.output as ExecLogEntry['output']) : null,
    error: row.error,
    durationMs: row.durationMs,
    ts: row.ts,
  };
}

export interface ExecutionsApiDeps {
  db: Db;
  clock?: () => Date;
}

export function registerExecutionsApi(app: FastifyInstance, deps: ExecutionsApiDeps): void {
  const { db } = deps;
  const now = (): string => (deps.clock ?? (() => new Date()))().toISOString();

  app.get('/api/executions', async (req, reply) => {
    const q = req.query as { flowId?: string; botId?: string; status?: string; limit?: string };
    if (q.status !== undefined && !STATUSES.has(q.status)) {
      return reply.code(400).send({ error: 'invalid_status' });
    }
    const limit = Math.min(Math.max(Number(q.limit) || DEFAULT_LIMIT, 1), MAX_LIMIT);

    const conds: SQL[] = [];
    if (q.flowId) conds.push(eq(executions.flowId, q.flowId));
    if (q.botId) conds.push(eq(executions.botId, q.botId));
    if (q.status) conds.push(eq(executions.status, q.status as ExecRow['status']));

    const base = db.select().from(executions);
    const rows = (conds.length > 0 ? base.where(and(...conds)) : base)
      .orderBy(desc(executions.startedAt))
      .limit(limit)
      .all();
    return { executions: rows.map(toSummary) };
  });

  app.get('/api/executions/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const row = db.select().from(executions).where(eq(executions.id, id)).get();
    if (!row) return reply.code(404).send({ error: 'not_found' });

    const logs = db
      .select()
      .from(execLogs)
      .where(eq(execLogs.executionId, id))
      .orderBy(execLogs.id)
      .all();

    const detail = {
      ...toSummary(row),
      wait: row.wait ?? null,
      logs: logs.map(toLog),
    };
    return { execution: detail };
  });

  app.post('/api/executions/:id/cancel', async (req, reply) => {
    const { id } = req.params as { id: string };
    // Single guarded UPDATE — no read-then-write race with the router: only
    // a still-live row flips, exactly like the router's /cancel handler
    // (status → canceled, wait cleared so the timeout scanner ignores it).
    const ts = now();
    const res = db
      .update(executions)
      .set({ status: 'canceled', wait: null, waitTimeoutAt: null, updatedAt: ts })
      .where(and(eq(executions.id, id), inArray(executions.status, ['waiting', 'running'])))
      .run();

    if (res.changes === 0) {
      const row = db.select().from(executions).where(eq(executions.id, id)).get();
      if (!row) return reply.code(404).send({ error: 'not_found' });
      return reply.code(409).send({ error: 'not_cancelable', status: row.status });
    }

    // Audit row in the step log so the inspector shows WHO/WHAT ended the run.
    db.insert(execLogs)
      .values({ executionId: id, nodeId: null, level: 'info', message: 'canceled via inspector', ts })
      .run();

    const row = db.select().from(executions).where(eq(executions.id, id)).get();
    return { ok: true, execution: toSummary(row!) };
  });
}
