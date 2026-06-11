/**
 * Flows REST API (PLAN P1-T8) — CRUD on flow graphs + activate/deactivate.
 *
 * The graph is the exact FlowGraph JSON the canvas edits (ARCH §4); every
 * write validates it against FlowGraphSchema (invariant I5). Saving a new
 * graph bumps `version` and snapshots the previous one into flow_versions
 * (rollback UI lands in P2-T4 — the data is durable from day one).
 *
 * All routes live under /api/ and are covered by the app-level auth guard.
 */
import { randomUUID } from 'node:crypto';
import { CreateFlowBodySchema, FlowGraphSchema, UpdateFlowBodySchema } from '@ctb/shared';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { z } from 'zod';
import type { Db } from '../db/index';
import { bots, flowVersions, flows } from '../db/schema';

// Body schemas live in @ctb/shared (P2-T1) so the editor's typed client
// validates against the exact same contract (invariant I5).

type FlowRow = typeof flows.$inferSelect;

function toPublic(row: FlowRow): Record<string, unknown> {
  return {
    id: row.id,
    botId: row.botId,
    name: row.name,
    status: row.status,
    graph: row.graph,
    version: row.version,
    updatedAt: row.updatedAt,
  };
}

/** A graph must contain ≥1 enabled trigger node to be activatable. */
function activationProblems(graph: z.infer<typeof FlowGraphSchema>): string[] {
  const problems: string[] = [];
  const triggers = graph.nodes.filter((n) => n.type === 'tg.trigger' && !n.disabled);
  if (triggers.length === 0) problems.push('flow has no enabled tg.trigger node');
  return problems;
}

export interface FlowsApiDeps {
  db: Db;
  clock?: () => Date;
}

export function registerFlowsApi(app: FastifyInstance, deps: FlowsApiDeps): void {
  const { db } = deps;
  const now = (): string => (deps.clock ?? (() => new Date()))().toISOString();

  app.get('/api/flows', async (req) => {
    const { botId } = req.query as { botId?: string };
    const rows = botId
      ? db.select().from(flows).where(eq(flows.botId, botId)).all()
      : db.select().from(flows).all();
    return { flows: rows.map(toPublic) };
  });

  app.get('/api/flows/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const row = db.select().from(flows).where(eq(flows.id, id)).get();
    if (!row) return reply.code(404).send({ error: 'not_found' });
    return { flow: toPublic(row) };
  });

  app.post('/api/flows', async (req, reply) => {
    const parsed = CreateFlowBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_body', issues: parsed.error.issues });
    }
    const bot = db.select().from(bots).where(eq(bots.id, parsed.data.botId)).get();
    if (!bot) return reply.code(400).send({ error: 'unknown_bot' });

    const row: FlowRow = {
      id: randomUUID(),
      botId: parsed.data.botId,
      name: parsed.data.name,
      status: 'draft',
      graph: parsed.data.graph,
      version: 1,
      updatedAt: now(),
    };
    db.insert(flows).values(row).run();
    return reply.code(201).send({ flow: toPublic(row) });
  });

  app.patch('/api/flows/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = UpdateFlowBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_body', issues: parsed.error.issues });
    }
    const row = db.select().from(flows).where(eq(flows.id, id)).get();
    if (!row) return reply.code(404).send({ error: 'not_found' });

    const patch: Partial<FlowRow> = { updatedAt: now() };
    if (parsed.data.name !== undefined) patch.name = parsed.data.name;
    if (parsed.data.graph !== undefined) {
      // Snapshot the outgoing version for rollback (P2-T4 UI; durable now).
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
    return { flow: toPublic(updated) };
  });

  app.delete('/api/flows/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const res = db.delete(flows).where(eq(flows.id, id)).run();
    if (res.changes === 0) return reply.code(404).send({ error: 'not_found' });
    return { ok: true };
  });

  app.post('/api/flows/:id/activate', async (req, reply) => {
    const { id } = req.params as { id: string };
    const row = db.select().from(flows).where(eq(flows.id, id)).get();
    if (!row) return reply.code(404).send({ error: 'not_found' });

    const graph = FlowGraphSchema.safeParse(row.graph);
    if (!graph.success) {
      return reply.code(422).send({ error: 'invalid_graph', issues: graph.error.issues });
    }
    const problems = activationProblems(graph.data);
    if (problems.length > 0) {
      return reply.code(422).send({ error: 'not_activatable', problems });
    }
    db.update(flows).set({ status: 'active', updatedAt: now() }).where(eq(flows.id, id)).run();
    return { ok: true, status: 'active' };
  });

  app.post('/api/flows/:id/deactivate', async (req, reply) => {
    const { id } = req.params as { id: string };
    const res = db
      .update(flows)
      .set({ status: 'draft', updatedAt: now() })
      .where(and(eq(flows.id, id), eq(flows.status, 'active')))
      .run();
    if (res.changes === 0) {
      const exists = db.select().from(flows).where(eq(flows.id, id)).get();
      if (!exists) return reply.code(404).send({ error: 'not_found' });
    }
    return { ok: true, status: 'draft' };
  });
}
