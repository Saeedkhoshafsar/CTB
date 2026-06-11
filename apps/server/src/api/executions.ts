/**
 * Executions REST API (P2-T3.5 slice of P2-T5) — read-only inspector data.
 *
 *   GET /api/executions?flowId=&status=&limit=   → ExecutionSummary[]
 *   GET /api/executions/:id                      → ExecutionDetail (logs incl.
 *                                                  per-step I/O item snapshots)
 *
 * The editor's node detail view (NDV) loads the latest execution of the open
 * flow and maps exec_logs "executed" rows (input/output FlowItems, recorded
 * by the executor with LOG_ITEMS_CAP) onto canvas nodes — the n8n pattern:
 * INPUT pane | params | OUTPUT pane. The full executions page is P2-T5;
 * cancel/management actions land there.
 */
import type { ExecLogEntry, ExecutionSummary } from '@ctb/shared';
import { and, desc, eq, type SQL } from 'drizzle-orm';
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
    output: hasIo ? (row.output as ExecLogEntry['output']) : null,
    error: row.error,
    durationMs: row.durationMs,
    ts: row.ts,
  };
}

export interface ExecutionsApiDeps {
  db: Db;
}

export function registerExecutionsApi(app: FastifyInstance, deps: ExecutionsApiDeps): void {
  const { db } = deps;

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
}
