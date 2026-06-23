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
import type { Executor, NodeRegistry } from '@ctb/core';
import {
  CreateFlowBodySchema,
  FLOW_TEMPLATES,
  FlowExportSchema,
  FlowGraphSchema,
  FlowSettingsSchema,
  ImportFlowBodySchema,
  ImportTemplateBodySchema,
  RollbackFlowBodySchema,
  RunNodeBodySchema,
  UpdateFlowBodySchema,
  defaultFlowSettings,
  findFlowTemplate,
  flowTemplateInfo,
  problemStrings,
  toFlowExport,
  validateFlowForActivation,
  type FlowExport,
  type FlowSettings,
  type FlowVersionInfo,
  type NodeSlotMeta,
} from '@ctb/shared';
import { and, desc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ZodType } from 'zod';
import type { Db } from '../db/index';
import { bots, flowVersions, flows } from '../db/schema';
import {
  flowWebhookHmacKey,
  flowWebhookSecret,
  flowWebhookUrl,
} from '../triggers/webhook';

// Body schemas live in @ctb/shared (P2-T1) so the editor's typed client
// validates against the exact same contract (invariant I5).

type FlowRow = typeof flows.$inferSelect;

/** Stored settings JSON → typed FlowSettings, defaulting anything missing/legacy. */
function readSettings(raw: unknown): FlowSettings {
  const parsed = FlowSettingsSchema.safeParse(raw ?? {});
  return parsed.success ? parsed.data : defaultFlowSettings();
}

function toPublic(row: FlowRow): Record<string, unknown> {
  return {
    id: row.id,
    botId: row.botId,
    name: row.name,
    status: row.status,
    graph: row.graph,
    settings: readSettings(row.settings),
    version: row.version,
    updatedAt: row.updatedAt,
  };
}

export interface FlowsApiDeps {
  db: Db;
  /** Engine registry — source of the param schemas activation validates with. */
  registry?: NodeRegistry;
  /** Engine executor — powers POST /:id/run (manual test runs, P2-T7). */
  executor?: Executor;
  /** CTB_SECRET — derives the per-flow webhook secret/HMAC key (P4-T1). */
  ctbSecret?: string;
  /** Public base URL — builds the absolute webhook URL the editor shows (P4-T1). */
  publicUrl?: string;
  /**
   * Called after any change that affects which flows are active or what their
   * graphs contain (activate / deactivate / edit / delete). The server wires
   * this to `scheduler.reconcile()` so cron `schedule.trigger` jobs track the
   * live flow set (P4-T2). Decoupled by design — the flows API never imports
   * the Scheduler.
   */
  onFlowsChanged?: () => void;
  clock?: () => Date;
}

export function registerFlowsApi(app: FastifyInstance, deps: FlowsApiDeps): void {
  const { db } = deps;
  const now = (): string => (deps.clock ?? (() => new Date()))().toISOString();
  /** Notify the host that the active-flow set / graphs changed (P4-T2). */
  const flowsChanged = (): void => deps.onFlowsChanged?.();
  // type → Zod params schema, built once — registry defs are static per process.
  const paramSchemas: ReadonlyMap<string, ZodType> = new Map(
    (deps.registry?.list() ?? []).map((def) => [def.type, def.paramsSchema]),
  );
  // type → typed sub-connection facts (role/slots/provides) for PB-T1 activation
  // rules, from the SAME registry (I5). Mirrored by the editor's test fake.
  // Built with omitted (not undefined) keys to satisfy exactOptionalPropertyTypes.
  const nodeMeta: ReadonlyMap<string, NodeSlotMeta> = new Map(
    (deps.registry?.list() ?? []).map((def) => {
      const m: NodeSlotMeta = {};
      if (def.role) m.role = def.role;
      if (def.inputSlots) m.inputSlots = def.inputSlots;
      if (def.provides) m.provides = def.provides;
      return [def.type, m] as const;
    }),
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
      settings: defaultFlowSettings(),
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
    if (parsed.data.settings !== undefined) {
      // Error-handler must be another flow OF THE SAME BOT (P3-T6) — a handler
      // on a different bot could never run in this bot's context, and pointing
      // a flow at itself would loop on every failure. Reject both.
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
    // An edit to an ACTIVE flow's graph can change its schedule.trigger set.
    if (updated.status === 'active' && parsed.data.graph !== undefined) flowsChanged();
    return { flow: toPublic(updated) };
  });

  app.delete('/api/flows/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const wasActive = db.select().from(flows).where(eq(flows.id, id)).get()?.status === 'active';
    const res = db.delete(flows).where(eq(flows.id, id)).run();
    if (res.changes === 0) return reply.code(404).send({ error: 'not_found' });
    if (wasActive) flowsChanged();
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

  // ---- import / export (P3-T7) --------------------------------------------
  //
  // A flow's design is portable: GET /:id/export emits a versioned, identity-
  // free envelope (graph + settings minus the un-portable error handler);
  // POST /import re-hydrates one into a NEW flow on the named bot. The shared
  // FlowExportSchema validates on the way out AND in (I5), so export→import
  // is identical-semantics by construction (the graph round-trips byte-for-
  // byte; only the cross-flow error handler is intentionally dropped).

  /** Persist a validated export as a brand-new draft flow on `botId`. */
  function createFromExport(botId: string, exp: FlowExport, nameOverride?: string): FlowRow {
    const settings: FlowSettings = {
      executionPolicy: exp.settings.executionPolicy,
      // export never carries a handler (un-portable); a fresh flow starts clean.
      errorHandlerFlowId: null,
    };
    const row: FlowRow = {
      id: randomUUID(),
      botId,
      name: nameOverride ?? exp.name,
      status: 'draft',
      graph: exp.graph,
      settings,
      version: 1,
      updatedAt: now(),
    };
    db.insert(flows).values(row).run();
    return row;
  }

  app.get('/api/flows/:id/export', async (req, reply) => {
    const { id } = req.params as { id: string };
    const row = db.select().from(flows).where(eq(flows.id, id)).get();
    if (!row) return reply.code(404).send({ error: 'not_found' });
    // Re-validate the stored graph before emitting it — never export junk.
    const graph = FlowGraphSchema.safeParse(row.graph);
    if (!graph.success) {
      return reply.code(422).send({ error: 'invalid_graph', issues: graph.error.issues });
    }
    const exported = toFlowExport({ name: row.name, graph: graph.data, settings: readSettings(row.settings) });
    return { export: exported };
  });

  app.post('/api/flows/import', async (req, reply) => {
    const parsed = ImportFlowBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_body', issues: parsed.error.issues });
    }
    const bot = db.select().from(bots).where(eq(bots.id, parsed.data.botId)).get();
    if (!bot) return reply.code(400).send({ error: 'unknown_bot' });

    const env = FlowExportSchema.safeParse(parsed.data.export);
    if (!env.success) {
      return reply.code(400).send({ error: 'invalid_export', issues: env.error.issues });
    }
    const row = createFromExport(parsed.data.botId, env.data, parsed.data.name);
    return reply.code(201).send({ flow: toPublic(row) });
  });

  // ---- starter template gallery (P3-T7) -----------------------------------

  app.get('/api/flow-templates', async () => {
    return { templates: FLOW_TEMPLATES.map(flowTemplateInfo) };
  });

  app.post('/api/flows/import-template', async (req, reply) => {
    const parsed = ImportTemplateBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_body', issues: parsed.error.issues });
    }
    const bot = db.select().from(bots).where(eq(bots.id, parsed.data.botId)).get();
    if (!bot) return reply.code(400).send({ error: 'unknown_bot' });

    const template = findFlowTemplate(parsed.data.templateId);
    if (!template) return reply.code(404).send({ error: 'unknown_template' });

    const row = createFromExport(parsed.data.botId, template.export, parsed.data.name);
    return reply.code(201).send({ flow: toPublic(row) });
  });

  // ---- manual test run (P2-T7) --------------------------------------------
  //
  // Starts an execution at the flow's flow.manualTrigger node and runs it
  // synchronously to the first WAIT / end / error. Works on drafts (testing
  // is exactly what you do BEFORE activating); the saved graph is used — the
  // editor calls saveNow() first. Chat-less context: tg capability is null,
  // so flows whose first steps send Telegram messages fail with a pointed
  // node error in the log — honest behavior for a test run without a chat.
  app.post('/api/flows/:id/run', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!deps.executor) return reply.code(503).send({ error: 'engine_not_configured' });
    const row = db.select().from(flows).where(eq(flows.id, id)).get();
    if (!row) return reply.code(404).send({ error: 'not_found' });

    const graph = FlowGraphSchema.safeParse(row.graph);
    if (!graph.success) {
      return reply.code(422).send({ error: 'invalid_graph', issues: graph.error.issues });
    }
    const trigger = graph.data.nodes.find((n) => n.type === 'flow.manualTrigger' && !n.disabled);
    if (!trigger) {
      return reply.code(422).send({
        error: 'no_manual_trigger',
        problems: ['flow has no enabled flow.manualTrigger node — add one to test-run'],
      });
    }

    const executionId = randomUUID();
    const result = await deps.executor.start({
      executionId,
      flow: { id: row.id, name: row.name },
      graph: graph.data,
      botId: row.botId,
      chatId: null,
      userId: null,
      entry: { nodeId: trigger.id, items: { main: [] } },
      // The editor's "Test run" is a TEST run (I-T1): nodes carrying pinnedData
      // short-circuit to that sample instead of executing. Production runs
      // (router/scheduler/webhook) never set this, so they ignore pins.
      testRun: true,
    });
    return { executionId, status: result.status, error: result.error };
  });

  // ---- single-node run (I-T2, gap G16) ------------------------------------
  //
  // Execute ONE node and stop, without running the whole flow. The editor's
  // "Run this node" button: it enters the engine AT the requested node with the
  // given input (or one empty item), runs exactly that node via the full
  // resolve → eval → Zod → execute path (so the result is byte-identical to a
  // whole-flow run of that node), and ends — the executor's stopAfterNode
  // boundary never routes the output downstream. It is always a TEST run, so a
  // pinned node (I-T1) honours its pin. Works on drafts. Chat-less context: the
  // tg capability is null, so a node needing a chat fails with a pointed log
  // error — honest for a node test without a chat (pin its upstream instead).
  app.post('/api/flows/:id/run-node', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!deps.executor) return reply.code(503).send({ error: 'engine_not_configured' });
    const body = RunNodeBodySchema.safeParse(req.body);
    if (!body.success) {
      return reply.code(400).send({ error: 'invalid_body', issues: body.error.issues });
    }
    const row = db.select().from(flows).where(eq(flows.id, id)).get();
    if (!row) return reply.code(404).send({ error: 'not_found' });

    const graph = FlowGraphSchema.safeParse(row.graph);
    if (!graph.success) {
      return reply.code(422).send({ error: 'invalid_graph', issues: graph.error.issues });
    }
    const node = graph.data.nodes.find((n) => n.id === body.data.nodeId);
    if (!node) {
      return reply.code(404).send({ error: 'node_not_found' });
    }
    if (node.disabled) {
      return reply.code(422).send({
        error: 'node_disabled',
        problems: [`node "${node.id}" is disabled — enable it to run`],
      });
    }

    const executionId = randomUUID();
    const result = await deps.executor.start({
      executionId,
      flow: { id: row.id, name: row.name },
      graph: graph.data,
      botId: row.botId,
      chatId: null,
      userId: null,
      // Enter the engine AT the target node with the supplied input (one empty
      // item by default, mirroring a manual-trigger run).
      entry: { nodeId: node.id, items: { main: body.data.input ?? [{ json: {} }] } },
      // Always a TEST run so a pinned node honours its pin (I-T1).
      testRun: true,
      // The single-node boundary: execute this node, then stop (I-T2).
      stopAfterNode: node.id,
    });
    return { executionId, status: result.status, error: result.error };
  });

  // Webhook Trigger connection info (P4-T1). Returns the unguessable URL +
  // HMAC key the editor shows so a user can wire n8n / curl to the flow. The
  // secrets are DERIVED from CTB_SECRET (no DB column); 503 if not configured.
  app.get('/api/flows/:id/webhook', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!deps.ctbSecret) return reply.code(503).send({ error: 'webhook_secret_not_configured' });
    const row = db.select().from(flows).where(eq(flows.id, id)).get();
    if (!row) return reply.code(404).send({ error: 'not_found' });
    return {
      flowId: id,
      path: `/hooks/flow/${id}/${flowWebhookSecret(id, deps.ctbSecret)}`,
      url: flowWebhookUrl(id, deps.ctbSecret, deps.publicUrl),
      hmacKey: flowWebhookHmacKey(id, deps.ctbSecret),
      signatureHeader: 'X-CTB-Signature',
    };
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
    } else {
      flowsChanged();
    }
    return { ok: true, status: 'draft' };
  });
}
