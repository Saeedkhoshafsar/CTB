/**
 * Flows REST API (PLAN P1-T8, lifecycle P2-T4) — CRUD + activate/deactivate +
 * version history + rollback.
 *
 * The graph is the exact FlowGraph JSON the canvas edits (ARCH §4); every
 * write validates it against FlowGraphSchema (invariant I5). Saving a new
 * graph bumps `version` and snapshots the previous one into flow_versions;
 * GET /:id/versions lists them and POST /:id/rollback restores one (the
 * restore itself snapshots the outgoing graph — rollback is undoable).
 *
 * Activation (P2-T4) validates every enabled node's params against the
 * registry schemas via the SHARED validateFlowForActivation — the editor's
 * test fake calls the same function, so server and canvas badges can't drift.
 *
 * All routes live under /api/ and are covered by the app-level auth guard.
 */
import { randomUUID } from 'node:crypto';
import type { NodeRegistry } from '@ctb/core';
import {
  CreateFlowBodySchema,
  FlowGraphSchema,
  RollbackFlowBodySchema,
  UpdateFlowBodySchema,
  problemStrings,
  validateFlowForActivation,
  type FlowVersionInfo,
} from '@ctb/shared';
import { and, desc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ZodType } from 'zod';
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

export interface FlowsApiDeps {
  db: Db;
  /** Engine registry — source of the param schemas activation validates with. */
  registry?: NodeRegistry;
  clock?: () => Date;
}

export function registerFlowsApi(app: FastifyInstance, deps: FlowsApiDeps): void {
  const { db } = deps;
  const now = (): string => (deps.clock ?? (() => new Date()))().toISOString();
  // type → Zod params schema, built once — registry defs are static per process.
  const paramSchemas: ReadonlyMap<string, ZodType> = new Map(
    (deps.registry?.list() ?? []).map((def) => [def.type, def.paramsSchema]),
  );

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
    const nodeProblems = validateFlowForActivation(graph.data, paramSchemas);
    if (nodeProblems.length > 0) {
      return reply
        .code(422)
        .send({ error: 'not_activatable', problems: problemStrings(nodeProblems), nodeProblems });
    }
    db.update(flows).set({ status: 'active', updatedAt: now() }).where(eq(flows.id, id)).run();
    return { ok: true, status: 'active' };
  });

  // ---- lifecycle: version history + rollback (P2-T4) ----------------------

  app.get('/api/flows/:id/versions', async (req, reply) => {
    const { id } = req.params as { id: string };
    const flow = db.select().from(flows).where(eq(flows.id, id)).get();
    if (!flow) return reply.code(404).send({ error: 'not_found' });
    const rows = db
      .select()
      .from(flowVersions)
      .where(eq(flowVersions.flowId, id))
      .orderBy(desc(flowVersions.version))
      .all();
    const versions: FlowVersionInfo[] = rows.map((v) => {
      const g = v.graph as { nodes?: unknown[]; edges?: unknown[] };
      return {
        version: v.version,
        createdAt: v.createdAt,
        nodeCount: Array.isArray(g.nodes) ? g.nodes.length : 0,
        edgeCount: Array.isArray(g.edges) ? g.edges.length : 0,
      };
    });
    return { current: flow.version, versions };
  });

  app.post('/api/flows/:id/rollback', async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = RollbackFlowBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_body', issues: parsed.error.issues });
    }
    const row = db.select().from(flows).where(eq(flows.id, id)).get();
    if (!row) return reply.code(404).send({ error: 'not_found' });
    const snap = db
      .select()
      .from(flowVersions)
      .where(and(eq(flowVersions.flowId, id), eq(flowVersions.version, parsed.data.version)))
      .get();
    if (!snap) return reply.code(404).send({ error: 'version_not_found' });

    // Snapshots written by old code may predate schema tweaks — re-validate
    // before promoting one back to the live document (I5: nothing unvalidated
    // becomes the graph).
    const graph = FlowGraphSchema.safeParse(snap.graph);
    if (!graph.success) {
      return reply.code(422).send({ error: 'invalid_graph', issues: graph.error.issues });
    }

    // Rollback is itself undoable: the outgoing graph gets snapshotted too.
    db.insert(flowVersions)
      .values({ id: randomUUID(), flowId: row.id, version: row.version, graph: row.graph, createdAt: now() })
      .run();
    db.update(flows)
      .set({ graph: graph.data, version: row.version + 1, updatedAt: now() })
      .where(eq(flows.id, id))
      .run();
    const updated = db.select().from(flows).where(eq(flows.id, id)).get()!;
    return { flow: toPublic(updated) };
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
