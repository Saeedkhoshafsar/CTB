/**
 * In-memory fake of the server's bots+flows+auth API for editor tests.
 * Mirrors the real route semantics (status codes, envelopes, token masking)
 * closely enough to exercise the typed client and stores without a server.
 */
import {
  CollectionParamsSchema,
  CreateCollectionBodySchema,
  CreateRecordBodySchema,
  DataKvParamsSchema,
  DataSetFieldsParamsSchema,
  RecordChangedParamsSchema,
  FLOW_TEMPLATES,
  FlowExportSchema,
  FlowGraphSchema,
  FlowIfParamsSchema,
  FlowManualTriggerParamsSchema,
  FlowStopErrorParamsSchema,
  FlowSwitchParamsSchema,
  FlowWaitParamsSchema,
  HttpRequestParamsSchema,
  TgMenuParamsSchema,
  TgSendMessageParamsSchema,
  TgTriggerParamsSchema,
  TgWaitForReplyParamsSchema,
  UpdateCollectionBodySchema,
  UpdateRecordBodySchema,
  UpdateUserBodySchema,
  QueryRecordsBodySchema,
  RecordValidationError,
  defaultFlowSettings,
  findFlowTemplate,
  flowTemplateInfo,
  problemStrings,
  toFlowExport,
  userDisplayName,
  validateFlowForActivation,
  validateRecord,
  type BotPublic,
  type CollectionPublic,
  type ExecutionDetail,
  type FilePublic,
  type FlowGraph,
  type FlowPublic,
  type NodeTypeInfo,
  type RecordFilter,
  type RecordPublic,
  type UserPublic,
} from '@ctb/shared';
import { z, type ZodType } from 'zod';
import type { FetchLike } from '../src/api/client';

/** Same conversion the real endpoint applies (apps/server/src/api/node-types.ts). */
function toParamsJsonSchema(schema: ZodType): Record<string, unknown> {
  return z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }) as Record<string, unknown>;
}

/**
 * Static mirror of GET /api/node-types for the P1 builtin six.
 * The editor may not import @ctb/nodes (dependency direction, I3), so the
 * fake hardcodes the SAME ports the real registry exposes — the server-side
 * node-types.test.ts asserts those ports against the real registry, keeping
 * this copy honest. Param schemas, however, are NOT copies: they come from
 * the same `@ctb/shared` Zod schemas the nodes register (I5), converted with
 * the same z.toJSONSchema options the real endpoint uses — so P2-T3 form
 * tests run against the genuine schemas.
 */
/**
 * type → params schema map for activation validation — the SAME schemas the
 * real registry holds (I5), fed to the SAME shared validateFlowForActivation
 * the real endpoint calls, so the fake's 422 semantics cannot drift.
 */
const PARAM_SCHEMAS: ReadonlyMap<string, ZodType> = new Map<string, ZodType>([
  ['tg.trigger', TgTriggerParamsSchema],
  ['tg.sendMessage', TgSendMessageParamsSchema],
  ['tg.waitForReply', TgWaitForReplyParamsSchema],
  ['flow.if', FlowIfParamsSchema],
  ['data.setFields', DataSetFieldsParamsSchema],
  ['flow.stopError', FlowStopErrorParamsSchema],
  // wave 2 (P2-T6)
  ['tg.menu', TgMenuParamsSchema],
  ['flow.switch', FlowSwitchParamsSchema],
  ['flow.wait', FlowWaitParamsSchema],
  ['http.request', HttpRequestParamsSchema],
  ['data.kv', DataKvParamsSchema],
  ['flow.manualTrigger', FlowManualTriggerParamsSchema],
]);

export const FAKE_NODE_TYPES: NodeTypeInfo[] = [
  { type: 'tg.trigger', category: 'trigger', meta: { labelKey: 'nodes.tg.trigger.label', icon: 'zap' }, ports: { inputs: [], outputs: ['main'] }, paramsJsonSchema: toParamsJsonSchema(TgTriggerParamsSchema) },
  { type: 'tg.sendMessage', category: 'telegram', meta: { labelKey: 'nodes.tg.sendMessage.label', icon: 'send' }, ports: { inputs: ['main'], outputs: ['main'] }, paramsJsonSchema: toParamsJsonSchema(TgSendMessageParamsSchema) },
  { type: 'tg.waitForReply', category: 'telegram', meta: { labelKey: 'nodes.tg.waitForReply.label', icon: 'message-circle-question' }, ports: { inputs: ['main'], outputs: ['reply', 'timeout', 'invalid'] }, paramsJsonSchema: toParamsJsonSchema(TgWaitForReplyParamsSchema) },
  { type: 'flow.if', category: 'flow', meta: { labelKey: 'nodes.flow.if.label', icon: 'git-branch' }, ports: { inputs: ['main'], outputs: ['true', 'false'] }, paramsJsonSchema: toParamsJsonSchema(FlowIfParamsSchema) },
  { type: 'data.setFields', category: 'data', meta: { labelKey: 'nodes.data.setFields.label', icon: 'pencil' }, ports: { inputs: ['main'], outputs: ['main'] }, paramsJsonSchema: toParamsJsonSchema(DataSetFieldsParamsSchema) },
  { type: 'flow.stopError', category: 'flow', meta: { labelKey: 'nodes.flow.stopError.label', icon: 'octagon-x' }, ports: { inputs: ['main'], outputs: [] }, paramsJsonSchema: toParamsJsonSchema(FlowStopErrorParamsSchema) },
  // wave 2 (P2-T6) — menu/switch outputs are DYNAMIC (computed from params
  // client-side via shared dynamicOutputPorts); the static base is empty,
  // matching the real NodeDef.ports.outputs.
  { type: 'tg.menu', category: 'telegram', meta: { labelKey: 'nodes.tg.menu.label', icon: 'list' }, ports: { inputs: ['main'], outputs: [] }, paramsJsonSchema: toParamsJsonSchema(TgMenuParamsSchema) },
  { type: 'flow.switch', category: 'flow', meta: { labelKey: 'nodes.flow.switch.label', icon: 'split' }, ports: { inputs: ['main'], outputs: [] }, paramsJsonSchema: toParamsJsonSchema(FlowSwitchParamsSchema) },
  { type: 'flow.wait', category: 'flow', meta: { labelKey: 'nodes.flow.wait.label', icon: 'clock' }, ports: { inputs: ['main'], outputs: ['main'] }, paramsJsonSchema: toParamsJsonSchema(FlowWaitParamsSchema) },
  { type: 'http.request', category: 'data', meta: { labelKey: 'nodes.http.request.label', icon: 'globe' }, ports: { inputs: ['main'], outputs: ['main'] }, paramsJsonSchema: toParamsJsonSchema(HttpRequestParamsSchema) },
  { type: 'data.kv', category: 'data', meta: { labelKey: 'nodes.data.kv.label', icon: 'database' }, ports: { inputs: ['main'], outputs: ['main'] }, paramsJsonSchema: toParamsJsonSchema(DataKvParamsSchema) },
  { type: 'flow.manualTrigger', category: 'trigger', meta: { labelKey: 'nodes.flow.manualTrigger.label', icon: 'play' }, ports: { inputs: [], outputs: ['main'] }, paramsJsonSchema: toParamsJsonSchema(FlowManualTriggerParamsSchema) },
  { type: 'data.collection', category: 'data', meta: { labelKey: 'nodes.data.collection.label', icon: 'database' }, ports: { inputs: ['main'], outputs: ['main', 'empty'] }, paramsJsonSchema: toParamsJsonSchema(CollectionParamsSchema) },
  { type: 'collection.recordChanged', category: 'trigger', meta: { labelKey: 'nodes.collection.recordChanged.label', icon: 'database' }, ports: { inputs: [], outputs: ['main'] }, paramsJsonSchema: toParamsJsonSchema(RecordChangedParamsSchema) },
];

interface FlowVersionRow {
  version: number;
  graph: FlowGraph;
  createdAt: string;
}

export interface FakeServer {
  fetch: FetchLike;
  bots: Map<string, BotPublic & { token: string }>;
  flows: Map<string, FlowPublic>;
  /** flowId → snapshots (mirrors flow_versions: outgoing graph per bump). */
  flowVersions: Map<string, FlowVersionRow[]>;
  /** Seed executions here (newest first is the caller's job — fake sorts by startedAt desc). */
  executions: Map<string, ExecutionDetail>;
  /** Seed users here (Users page, P3-T5). */
  users: Map<string, UserPublic>;
  /** Collections + records (Data section, P3.5-T3). */
  collections: Map<string, CollectionPublic>;
  records: Map<string, RecordPublic>;
  /** Uploaded files (image/file fields, P3.5-T4). */
  files: Map<string, FilePublic & { bytes: string }>;
  loggedIn: boolean;
  calls: { method: string; path: string; body?: unknown }[];
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

let seq = 0;
const uid = (p: string) => `${p}-${++seq}`;

/**
 * A small in-memory mirror of the store's RecordFilter compiler — enough to let
 * the panel's where/sort/limit/offset behaviour be tested end-to-end without a
 * real SQLite store.
 */
function applyRecordFilter(records: RecordPublic[], filter: RecordFilter): RecordPublic[] {
  let out = records.filter((rec) =>
    filter.where.every((w) => {
      const v = rec.data[w.field];
      switch (w.op) {
        case 'eq':
          return v === w.value;
        case 'ne':
          return v !== w.value;
        case 'gt':
          return typeof v === 'number' && typeof w.value === 'number' && v > w.value;
        case 'gte':
          return typeof v === 'number' && typeof w.value === 'number' && v >= w.value;
        case 'lt':
          return typeof v === 'number' && typeof w.value === 'number' && v < w.value;
        case 'lte':
          return typeof v === 'number' && typeof w.value === 'number' && v <= w.value;
        case 'contains':
          return typeof v === 'string' && typeof w.value === 'string' && v.includes(w.value);
        case 'in':
          return Array.isArray(w.value) && (w.value as unknown[]).includes(v);
        case 'exists':
          return w.value === false ? v === undefined || v === null : v !== undefined && v !== null;
        default:
          return true;
      }
    }),
  );
  for (const s of [...filter.sort].reverse()) {
    out = [...out].sort((a, b) => {
      const av = a.data[s.field];
      const bv = b.data[s.field];
      const cmp = av === bv ? 0 : (av as number) > (bv as number) ? 1 : -1;
      return s.dir === 'desc' ? -cmp : cmp;
    });
  }
  return out;
}

export function createFakeServer(): FakeServer {
  const srv: FakeServer = {
    bots: new Map(),
    flows: new Map(),
    flowVersions: new Map(),
    executions: new Map(),
    users: new Map(),
    collections: new Map(),
    records: new Map(),
    files: new Map(),
    loggedIn: false,
    calls: [],
    fetch: async (input, init) => {
      const method = init?.method ?? 'GET';
      const url = new URL(input, 'http://test');
      const path = url.pathname;
      const body = init?.body ? JSON.parse(init.body as string) : undefined;
      srv.calls.push({ method, path, ...(body !== undefined ? { body } : {}) });

      // ---- auth ----
      if (path === '/api/auth/login' && method === 'POST') {
        if (body?.username === 'admin' && body?.password === 'pw') {
          srv.loggedIn = true;
          return json(200, { ok: true, user: { username: 'admin' } });
        }
        return json(401, { error: 'invalid_credentials' });
      }
      if (path === '/api/auth/logout' && method === 'POST') {
        srv.loggedIn = false;
        return json(200, { ok: true });
      }
      if (path === '/api/auth/me') {
        return srv.loggedIn
          ? json(200, { user: { username: 'admin' } })
          : json(401, { error: 'unauthorized' });
      }

      if (!srv.loggedIn) return json(401, { error: 'unauthorized' });

      // ---- executions (P2-T3.5) ----
      if (path === '/api/executions' && method === 'GET') {
        const flowId = url.searchParams.get('flowId');
        const botId = url.searchParams.get('botId');
        const status = url.searchParams.get('status');
        if (status && !['running', 'waiting', 'done', 'error', 'canceled'].includes(status)) {
          return json(400, { error: 'invalid_status' });
        }
        const limit = Math.min(Math.max(Number(url.searchParams.get('limit') ?? 50), 1), 200);
        const executions = [...srv.executions.values()]
          .filter(
            (e) =>
              (!flowId || e.flowId === flowId) &&
              (!botId || e.botId === botId) &&
              (!status || e.status === status),
          )
          .sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1))
          .slice(0, limit)
          .map(({ wait: _w, logs: _l, ...summary }) => summary);
        return json(200, { executions });
      }
      const cancelMatch = path.match(/^\/api\/executions\/([^/]+)\/cancel$/);
      if (cancelMatch && method === 'POST') {
        const exec = srv.executions.get(cancelMatch[1]!);
        if (!exec) return json(404, { error: 'not_found' });
        if (exec.status !== 'waiting' && exec.status !== 'running') {
          return json(409, { error: 'not_cancelable', status: exec.status });
        }
        exec.status = 'canceled';
        exec.wait = null;
        exec.updatedAt = new Date().toISOString();
        const { wait: _w, logs: _l, ...summary } = exec;
        return json(200, { ok: true, execution: summary });
      }
      const execMatch = path.match(/^\/api\/executions\/([^/]+)$/);
      if (execMatch && method === 'GET') {
        const exec = srv.executions.get(execMatch[1]!);
        return exec ? json(200, { execution: exec }) : json(404, { error: 'not_found' });
      }

      // ---- node types (P2-T2) ----
      if (path === '/api/node-types' && method === 'GET') {
        return json(200, { nodeTypes: FAKE_NODE_TYPES });
      }

      // ---- bots ----
      if (path === '/api/bots' && method === 'GET') {
        return json(200, { bots: [...srv.bots.values()].map(({ token: _t, ...pub }) => pub) });
      }
      if (path === '/api/bots' && method === 'POST') {
        const id = uid('bot');
        const ts = new Date().toISOString();
        const [tid = '', rest = ''] = (body.token as string).split(':');
        const bot = {
          id,
          name: body.name,
          token: body.token,
          tokenHint: `${tid}:${rest.slice(0, 3)}…${rest.slice(-3)}`,
          mode: body.mode ?? 'polling',
          status: 'inactive' as const,
          settings: body.settings ?? {},
          createdAt: ts,
          updatedAt: ts,
        };
        srv.bots.set(id, bot);
        const { token: _t, ...pub } = bot;
        return json(201, { bot: pub });
      }
      const botMatch = path.match(/^\/api\/bots\/([^/]+)(\/(start|stop))?$/);
      if (botMatch) {
        const bot = srv.bots.get(botMatch[1]!);
        if (!bot) return json(404, { error: 'not_found' });
        const action = botMatch[3];
        if (action === 'start') {
          bot.status = 'active';
          return json(200, { ok: true });
        }
        if (action === 'stop') {
          bot.status = 'inactive';
          return json(200, { ok: true });
        }
        if (method === 'GET') {
          const { token: _t, ...pub } = bot;
          return json(200, { bot: pub });
        }
        if (method === 'DELETE') {
          srv.bots.delete(bot.id);
          for (const [fid, f] of srv.flows) if (f.botId === bot.id) srv.flows.delete(fid);
          return json(200, { ok: true });
        }
      }

      // ---- flows ----
      if (path === '/api/flows' && method === 'GET') {
        const botId = url.searchParams.get('botId');
        const flows = [...srv.flows.values()].filter((f) => !botId || f.botId === botId);
        return json(200, { flows });
      }
      if (path === '/api/flows' && method === 'POST') {
        if (!srv.bots.has(body.botId)) return json(400, { error: 'unknown_bot' });
        const id = uid('flow');
        const flow: FlowPublic = {
          id,
          botId: body.botId,
          name: body.name,
          status: 'draft',
          graph: body.graph ?? { nodes: [], edges: [] },
          settings: defaultFlowSettings(),
          version: 1,
          updatedAt: new Date().toISOString(),
        };
        srv.flows.set(id, flow);
        return json(201, { flow });
      }

      // ---- import / export + template gallery (P3-T7) ----
      // Static routes BEFORE the parametric flowMatch so they aren't shadowed.
      if (path === '/api/flow-templates' && method === 'GET') {
        return json(200, { templates: FLOW_TEMPLATES.map(flowTemplateInfo) });
      }
      if (path === '/api/flows/import' && method === 'POST') {
        if (!srv.bots.has(body.botId)) return json(400, { error: 'unknown_bot' });
        const env = FlowExportSchema.safeParse(body.export);
        if (!env.success) return json(400, { error: 'invalid_export', issues: env.error.issues });
        const id = uid('flow');
        const flow: FlowPublic = {
          id,
          botId: body.botId,
          name: body.name ?? env.data.name,
          status: 'draft',
          graph: env.data.graph,
          settings: { executionPolicy: env.data.settings.executionPolicy, errorHandlerFlowId: null },
          version: 1,
          updatedAt: new Date().toISOString(),
        };
        srv.flows.set(id, flow);
        return json(201, { flow });
      }
      if (path === '/api/flows/import-template' && method === 'POST') {
        if (!srv.bots.has(body.botId)) return json(400, { error: 'unknown_bot' });
        const template = findFlowTemplate(body.templateId);
        if (!template) return json(404, { error: 'unknown_template' });
        const id = uid('flow');
        const flow: FlowPublic = {
          id,
          botId: body.botId,
          name: body.name ?? template.export.name,
          status: 'draft',
          graph: template.export.graph,
          settings: { executionPolicy: template.export.settings.executionPolicy, errorHandlerFlowId: null },
          version: 1,
          updatedAt: new Date().toISOString(),
        };
        srv.flows.set(id, flow);
        return json(201, { flow });
      }
      {
        const exportMatch = path.match(/^\/api\/flows\/([^/]+)\/export$/);
        if (exportMatch && method === 'GET') {
          const flow = srv.flows.get(exportMatch[1]!);
          if (!flow) return json(404, { error: 'not_found' });
          const exported = toFlowExport({ name: flow.name, graph: flow.graph, settings: flow.settings });
          return json(200, { export: exported });
        }
      }

      // ---- flow lifecycle: versions + rollback (P2-T4) ----
      const versionsMatch = path.match(/^\/api\/flows\/([^/]+)\/versions$/);
      if (versionsMatch && method === 'GET') {
        const flow = srv.flows.get(versionsMatch[1]!);
        if (!flow) return json(404, { error: 'not_found' });
        const versions = [...(srv.flowVersions.get(flow.id) ?? [])]
          .sort((a, b) => b.version - a.version)
          .map((v) => ({
            version: v.version,
            createdAt: v.createdAt,
            nodeCount: v.graph.nodes.length,
            edgeCount: v.graph.edges.length,
          }));
        return json(200, { current: flow.version, versions });
      }
      const rollbackMatch = path.match(/^\/api\/flows\/([^/]+)\/rollback$/);
      if (rollbackMatch && method === 'POST') {
        const flow = srv.flows.get(rollbackMatch[1]!);
        if (!flow) return json(404, { error: 'not_found' });
        const snaps = srv.flowVersions.get(flow.id) ?? [];
        const snap = snaps.find((v) => v.version === body?.version);
        if (!snap) return json(404, { error: 'version_not_found' });
        // rollback is itself undoable: snapshot the outgoing graph too
        snaps.push({ version: flow.version, graph: flow.graph, createdAt: new Date().toISOString() });
        srv.flowVersions.set(flow.id, snaps);
        flow.graph = snap.graph;
        flow.version += 1;
        flow.updatedAt = new Date().toISOString();
        return json(200, { flow });
      }

      const flowMatch = path.match(/^\/api\/flows\/([^/]+)(\/(activate|deactivate))?$/);
      if (flowMatch) {
        const flow = srv.flows.get(flowMatch[1]!);
        if (!flow) return json(404, { error: 'not_found' });
        const action = flowMatch[3];
        if (action === 'activate') {
          // same shared validator + schema map semantics as the real endpoint
          const nodeProblems = validateFlowForActivation(flow.graph, PARAM_SCHEMAS);
          if (nodeProblems.length > 0) {
            return json(422, {
              error: 'not_activatable',
              problems: problemStrings(nodeProblems),
              nodeProblems,
            });
          }
          flow.status = 'active';
          return json(200, { ok: true, status: 'active' });
        }
        if (action === 'deactivate') {
          flow.status = 'draft';
          return json(200, { ok: true, status: 'draft' });
        }
        if (method === 'GET') return json(200, { flow });
        if (method === 'PATCH') {
          if (body.graph !== undefined) {
            const parsed = FlowGraphSchema.safeParse(body.graph);
            if (!parsed.success) return json(400, { error: 'invalid_graph' });
            // real server snapshots the OUTGOING graph into flow_versions + bumps
            const snaps = srv.flowVersions.get(flow.id) ?? [];
            snaps.push({ version: flow.version, graph: flow.graph, createdAt: new Date().toISOString() });
            srv.flowVersions.set(flow.id, snaps);
            flow.graph = parsed.data;
            flow.version += 1;
          }
          if (body.name !== undefined) flow.name = body.name;
          if (body.settings !== undefined) flow.settings = body.settings;
          flow.updatedAt = new Date().toISOString();
          return json(200, { flow });
        }
        if (method === 'DELETE') {
          srv.flows.delete(flow.id);
          return json(200, { ok: true });
        }
      }

      // ---- users (Users page, P3-T5) ----
      if (path === '/api/users' && method === 'GET') {
        const botId = url.searchParams.get('botId');
        if (!botId) return json(400, { error: 'botId_required' });
        const users = [...srv.users.values()]
          .filter((u) => u.botId === botId)
          .sort((a, b) => (a.lastSeen < b.lastSeen ? 1 : -1));
        return json(200, { users });
      }
      {
        const m = /^\/api\/users\/([^/]+)$/.exec(path);
        if (m) {
          const id = decodeURIComponent(m[1]!);
          const user = srv.users.get(id);
          if (!user) return json(404, { error: 'not_found' });
          if (method === 'GET') return json(200, { user });
          if (method === 'PATCH') {
            const parsed = UpdateUserBodySchema.safeParse(body);
            if (!parsed.success) return json(400, { error: 'invalid_body', issues: parsed.error.issues });
            if (parsed.data.profile !== undefined) user.profile = parsed.data.profile;
            if (parsed.data.tags !== undefined) user.tags = parsed.data.tags;
            user.displayName = userDisplayName(user);
            return json(200, { user });
          }
        }
      }

      // ---- collections (Data section, P3.5-T3) ----
      if (path === '/api/collections' && method === 'GET') {
        const botId = url.searchParams.get('botId');
        if (!botId) return json(400, { error: 'botId_required' });
        const collections = [...srv.collections.values()].filter((c) => c.botId === botId);
        return json(200, { collections });
      }
      if (path === '/api/collections' && method === 'POST') {
        const botId = url.searchParams.get('botId');
        if (!botId) return json(400, { error: 'botId_required' });
        if (!srv.bots.has(botId)) return json(400, { error: 'unknown_bot' });
        const parsed = CreateCollectionBodySchema.safeParse(body);
        if (!parsed.success) return json(400, { error: 'invalid_body', issues: parsed.error.issues });
        // slug unique per bot (mirrors store.define)
        const taken = [...srv.collections.values()].some(
          (c) => c.botId === botId && c.slug === parsed.data.slug,
        );
        if (taken) return json(409, { error: 'slug_taken' });
        const id = uid('col');
        const ts = new Date().toISOString();
        const col: CollectionPublic = {
          id,
          botId,
          slug: parsed.data.slug,
          name: parsed.data.name,
          icon: parsed.data.icon ?? null,
          schema: parsed.data.schema,
          display: parsed.data.display ?? {},
          version: 1,
          createdAt: ts,
          updatedAt: ts,
        };
        srv.collections.set(id, col);
        return json(201, { collection: col });
      }
      {
        const m = /^\/api\/collections\/([^/]+)$/.exec(path);
        if (m) {
          const id = decodeURIComponent(m[1]!);
          const col = srv.collections.get(id);
          if (!col) return json(404, { error: 'not_found' });
          if (method === 'GET') return json(200, { collection: col });
          if (method === 'PATCH') {
            const parsed = UpdateCollectionBodySchema.safeParse(body);
            if (!parsed.success) return json(400, { error: 'invalid_body', issues: parsed.error.issues });
            if (parsed.data.name !== undefined) col.name = parsed.data.name;
            if (parsed.data.icon !== undefined) col.icon = parsed.data.icon;
            if (parsed.data.schema !== undefined) col.schema = parsed.data.schema;
            if (parsed.data.display !== undefined) col.display = parsed.data.display;
            col.version += 1;
            col.updatedAt = new Date().toISOString();
            return json(200, { collection: col });
          }
          if (method === 'DELETE') {
            srv.collections.delete(id);
            for (const [rid, r] of srv.records) if (r.collectionId === id) srv.records.delete(rid);
            return json(200, { ok: true });
          }
        }
      }

      // ---- records (P3.5-T3) ----
      {
        // /api/records/:collectionId/count
        const m = /^\/api\/records\/([^/]+)\/count$/.exec(path);
        if (m && method === 'GET') {
          const cid = decodeURIComponent(m[1]!);
          if (!srv.collections.has(cid)) return json(404, { error: 'unknown_collection' });
          const count = [...srv.records.values()].filter((r) => r.collectionId === cid).length;
          return json(200, { count });
        }
      }
      {
        // /api/records/:collectionId/query (POST)
        const m = /^\/api\/records\/([^/]+)\/query$/.exec(path);
        if (m && method === 'POST') {
          const cid = decodeURIComponent(m[1]!);
          if (!srv.collections.has(cid)) return json(404, { error: 'unknown_collection' });
          const parsed = QueryRecordsBodySchema.safeParse(body ?? {});
          if (!parsed.success) return json(400, { error: 'invalid_filter', issues: parsed.error.issues });
          const all = [...srv.records.values()].filter((r) => r.collectionId === cid);
          const matched = applyRecordFilter(all, parsed.data);
          const offset = parsed.data.offset ?? 0;
          const limit = parsed.data.limit ?? matched.length;
          const pageRows = matched.slice(offset, offset + limit);
          return json(200, { records: pageRows, total: matched.length });
        }
      }
      {
        // /api/records/:collectionId/:id
        const m = /^\/api\/records\/([^/]+)\/([^/]+)$/.exec(path);
        if (m) {
          const cid = decodeURIComponent(m[1]!);
          const rid = decodeURIComponent(m[2]!);
          const col = srv.collections.get(cid);
          if (!col) return json(404, { error: 'unknown_collection' });
          const rec = srv.records.get(rid);
          if (!rec || rec.collectionId !== cid) return json(404, { error: 'not_found' });
          if (method === 'GET') return json(200, { record: rec });
          if (method === 'PATCH') {
            const parsed = UpdateRecordBodySchema.safeParse(body);
            if (!parsed.success) return json(400, { error: 'invalid_body', issues: parsed.error.issues });
            try {
              const merged =
                parsed.data.mode === 'replace'
                  ? parsed.data.data
                  : { ...rec.data, ...parsed.data.data };
              rec.data = validateRecord(col.schema, merged, { partial: parsed.data.mode === 'merge' });
              rec.updatedAt = new Date().toISOString();
              return json(200, { record: rec });
            } catch (e) {
              if (e instanceof RecordValidationError) {
                return json(422, { error: 'validation_failed', fields: e.errors });
              }
              throw e;
            }
          }
          if (method === 'DELETE') {
            srv.records.delete(rid);
            return json(200, { ok: true });
          }
        }
      }
      {
        // /api/records/:collectionId  (GET list / POST create)
        const m = /^\/api\/records\/([^/]+)$/.exec(path);
        if (m) {
          const cid = decodeURIComponent(m[1]!);
          const col = srv.collections.get(cid);
          if (!col) return json(404, { error: 'unknown_collection' });
          if (method === 'GET') {
            const all = [...srv.records.values()].filter((r) => r.collectionId === cid);
            return json(200, { records: all, total: all.length });
          }
          if (method === 'POST') {
            const parsed = CreateRecordBodySchema.safeParse(body);
            if (!parsed.success) return json(400, { error: 'invalid_body', issues: parsed.error.issues });
            try {
              const data = validateRecord(col.schema, parsed.data.data);
              const id = uid('rec');
              const ts = new Date().toISOString();
              const rec: RecordPublic = {
                id,
                collectionId: cid,
                data,
                createdAt: ts,
                updatedAt: ts,
                createdBy: 'admin',
              };
              srv.records.set(id, rec);
              return json(201, { record: rec });
            } catch (e) {
              if (e instanceof RecordValidationError) {
                return json(422, { error: 'validation_failed', fields: e.errors });
              }
              throw e;
            }
          }
        }
      }

      // ---- files (image/file uploads, P3.5-T4) ----
      if (path === '/api/files' && method === 'POST') {
        const botId = url.searchParams.get('botId');
        if (!botId) return json(400, { error: 'botId_required' });
        if (typeof body?.data !== 'string' || body.data === '') {
          return json(400, { error: 'invalid_body' });
        }
        const id = uid('file');
        const file: FilePublic & { bytes: string } = {
          id,
          botId,
          kind: 'local',
          mime: typeof body.mime === 'string' ? body.mime : null,
          size: body.data.length,
          createdAt: new Date().toISOString(),
          url: `/api/files/${id}`,
          bytes: body.data,
        };
        srv.files.set(id, file);
        const { bytes: _bytes, ...pub } = file;
        return json(201, { file: pub });
      }
      {
        const m = /^\/api\/files\/([^/]+)\/meta$/.exec(path);
        if (m && method === 'GET') {
          const f = srv.files.get(decodeURIComponent(m[1]!));
          if (!f) return json(404, { error: 'not_found' });
          const { bytes: _bytes, ...pub } = f;
          return json(200, { file: pub });
        }
      }
      {
        const m = /^\/api\/files\/([^/]+)$/.exec(path);
        if (m && method === 'DELETE') {
          if (!srv.files.delete(decodeURIComponent(m[1]!))) return json(404, { error: 'not_found' });
          return json(200, { ok: true });
        }
      }

      return json(404, { error: 'not_found' });
    },
  };
  return srv;
}
