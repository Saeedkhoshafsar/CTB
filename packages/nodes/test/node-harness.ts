/**
 * Contract-test harness for node implementations: a fake NodeCtx with a
 * recording Telegram sender + in-memory vars, and a params helper that
 * routes raw params through the node's own Zod schema (exactly what the
 * registry does at runtime — so tests validate the schema too).
 */
import { runInSandbox } from '@ctb/sandbox';
import type { AiChatRequest, CollectionRecord, CtbUser, FlowItem, NodeCtx, NodeDef } from '@ctb/shared';

export interface SentMessage {
  opts: Record<string, unknown>;
  messageId: number;
}

export interface HttpCall {
  method: string;
  url: string;
  headers?: Record<string, string> | undefined;
  body?: string | Record<string, unknown> | undefined;
  timeoutMs?: number | undefined;
}

export interface FakeCtx extends NodeCtx {
  sent: SentMessage[];
  edited: Record<string, unknown>[];
  varsBag: Record<string, unknown>;
  /** In-memory kv backing: keys are `${scope}:${key}`. */
  kvBag: Map<string, unknown>;
  httpCalls: HttpCall[];
  logs: { level: string; message: string }[];
  /** flow.executeSubFlow (P3-T1): recorded sub-flow calls. */
  subflowCalls: { flowId: string; items: FlowItem[] }[];
  /** P3-T3 tg capabilities: recorded payloads by Bot-API method. */
  editedCaption: Record<string, unknown>[];
  editedReplyMarkup: Record<string, unknown>[];
  deleted: Record<string, unknown>[];
  answeredCallbacks: Record<string, unknown>[];
  chatActions: Record<string, unknown>[];
  /** data.userProfile (P3-T5): in-memory user store keyed by tgUserId. */
  usersBag: Map<number, CtbUser>;
  /** data.collection (P3.5-T5): in-memory records keyed by `${slug}` → id → record. */
  collectionsBag: Map<string, Map<string, CollectionRecord>>;
  /** data.collection: recorded write events (for suppress_events assertions). */
  recordEvents: { event: 'created' | 'updated' | 'deleted'; slug: string; recordId: string }[];
  /** ai.llmChat (P5-T1): recorded LLM chat requests. */
  aiCalls: AiChatRequest[];
}

export function makeCtx(
  overrides: {
    chatId?: number | null;
    tg?: null;
    now?: Date;
    /** Scripted http responses, consumed in order (last one repeats). */
    httpResponses?: { status: number; headers?: Record<string, string>; body: unknown }[];
    /**
     * flow.executeSubFlow (P3-T1): the injected sub-flow runner. Pass `null`
     * to simulate an instance with no sub-flow support (ctx.subflow === null);
     * omit to get a default that echoes the input items back.
     */
    subflowRun?: ((flowId: string, items: FlowItem[]) => Promise<{ items: FlowItem[] }>) | null;
    /** P3-T2: the executing node's graph id (flow.loop scopes $vars by it). */
    nodeId?: string;
    /**
     * P3-T2: items grouped by the input port they arrived on (flow.merge reads
     * this to tell its two branches apart). Empty by default.
     */
    inputsByPort?: Record<string, FlowItem[]>;
    /**
     * P3-T4: scripted credential resolver. A map of credentialId → auth headers
     * (or null = "not found"). Pass `null` to simulate ctx.credentials === null
     * (no credential store, e.g. a bare unit context). Omit → resolver present
     * but every lookup returns null.
     */
    credentialHeaders?: Record<string, Record<string, string> | null> | null;
    /**
     * P3-T5: the execution's own tg user id (data.userProfile defaults to it).
     * Defaults to the chatId when it's a positive id; pass `null` to simulate a
     * run with no user (e.g. a sub-flow). Pass `users: null` to drop ctx.users.
     */
    selfUserId?: number | null;
    /** Pass `null` to simulate an instance with no user store (ctx.users === null). */
    users?: null;
    /** Seed the in-memory user store before the run. */
    seedUsers?: CtbUser[];
    /** Pass `null` to simulate an instance with no collection store (ctx.collections === null). */
    collections?: null;
    /**
     * P5-T1: scripted LLM responses for ctx.ai.chat, consumed in order (last
     * repeats). Pass `null` to simulate an instance with no AI service
     * (ctx.ai === null). Omit → a default echo reply.
     */
    aiResponses?: { reply: string; usage?: Record<string, number>; model?: string }[] | null;
    /** Seed the in-memory collection store: slug → array of record docs (id auto-assigned if absent). */
    seedCollections?: Record<string, { id?: string; data: Record<string, unknown> }[]>;
    /** Slugs that exist (so unknown-slug throws like the real store). Defaults to seeded slugs. */
    knownCollections?: string[];
  } = {},
): FakeCtx {
  const sent: SentMessage[] = [];
  const edited: Record<string, unknown>[] = [];
  const editedCaption: Record<string, unknown>[] = [];
  const editedReplyMarkup: Record<string, unknown>[] = [];
  const deleted: Record<string, unknown>[] = [];
  const answeredCallbacks: Record<string, unknown>[] = [];
  const chatActions: Record<string, unknown>[] = [];
  const varsBag: Record<string, unknown> = {};
  const kvBag = new Map<string, unknown>();
  const httpCalls: HttpCall[] = [];
  const logs: { level: string; message: string }[] = [];
  const subflowCalls: { flowId: string; items: FlowItem[] }[] = [];
  const usersBag = new Map<number, CtbUser>();
  const collectionsBag = new Map<string, Map<string, CollectionRecord>>();
  const recordEvents: { event: 'created' | 'updated' | 'deleted'; slug: string; recordId: string }[] = [];
  const aiCalls: AiChatRequest[] = [];
  let aiIdx = 0;
  let nextRecordId = 1;
  const knownSlugs = new Set<string>(
    overrides.knownCollections ?? Object.keys(overrides.seedCollections ?? {}),
  );
  for (const [slug, recs] of Object.entries(overrides.seedCollections ?? {})) {
    knownSlugs.add(slug);
    const map = new Map<string, CollectionRecord>();
    for (const r of recs) {
      const id = r.id ?? `rec${nextRecordId++}`;
      map.set(id, { id, data: { ...r.data }, createdAt: '2026-06-11T10:00:00.000Z', updatedAt: '2026-06-11T10:00:00.000Z' });
    }
    collectionsBag.set(slug, map);
  }
  let nextMessageId = 100;
  let httpIdx = 0;
  const now = overrides.now ?? new Date('2026-06-11T10:00:00.000Z');
  const nowIso = now.toISOString();
  for (const u of overrides.seedUsers ?? []) usersBag.set(u.tgUserId, { ...u });
  const selfUserId =
    overrides.selfUserId !== undefined
      ? overrides.selfUserId
      : typeof (overrides.chatId === undefined ? 777 : overrides.chatId) === 'number' &&
          (overrides.chatId === undefined ? 777 : overrides.chatId)! > 0
        ? (overrides.chatId === undefined ? 777 : (overrides.chatId as number))
        : null;
  /** Resolve target id (explicit arg → fallback to the execution's own user). */
  const resolveUid = (uid?: number): number => {
    const id = uid ?? selfUserId;
    if (id === null || id === undefined) throw new Error('data.userProfile: no target user');
    return id;
  };
  const upsertUser = (uid: number): CtbUser => {
    let u = usersBag.get(uid);
    if (!u) {
      u = { tgUserId: uid, profile: {}, tags: [], firstSeen: nowIso, lastSeen: nowIso };
      usersBag.set(uid, u);
    }
    return u;
  };

  const ctx: FakeCtx = {
    executionId: 'exec1',
    flowId: 'flow1',
    botId: 'bot1',
    chatId: overrides.chatId === undefined ? 777 : overrides.chatId,
    nodeId: overrides.nodeId ?? 'node1',
    inputsByPort: overrides.inputsByPort ?? {},
    sent,
    edited,
    varsBag,
    kvBag,
    httpCalls,
    logs,
    subflowCalls,
    usersBag,
    collectionsBag,
    recordEvents,
    aiCalls,
    async eval(template) {
      return template; // nodes receive pre-resolved params; ctx.eval rarely used in wave 1
    },
    vars: {
      get: (k) => varsBag[k],
      set: (k, v) => {
        varsBag[k] = v;
      },
      all: () => ({ ...varsBag }),
    },
    kv: {
      get: async (scope, key) => kvBag.get(`${scope}:${key}`),
      set: async (scope, key, value) => {
        kvBag.set(`${scope}:${key}`, value);
      },
      delete: async (scope, key) => {
        kvBag.delete(`${scope}:${key}`);
      },
    },
    http: {
      async request(opts) {
        httpCalls.push(opts);
        const scripted = overrides.httpResponses;
        if (!scripted || scripted.length === 0) return { status: 200, headers: {}, body: null };
        const r = scripted[Math.min(httpIdx++, scripted.length - 1)]!;
        return { status: r.status, headers: r.headers ?? {}, body: r.body };
      },
    },
    credentials:
      overrides.credentialHeaders === null
        ? null
        : {
            async authHeaders(credentialId) {
              return overrides.credentialHeaders?.[credentialId] ?? null;
            },
          },
    editedCaption,
    editedReplyMarkup,
    deleted,
    answeredCallbacks,
    chatActions,
    tg:
      overrides.tg === null
        ? null
        : {
            async sendMessage(opts) {
              const messageId = nextMessageId++;
              sent.push({ opts, messageId });
              return { messageId };
            },
            async editMessageText(opts) {
              edited.push(opts);
            },
            async editMessageCaption(opts) {
              editedCaption.push(opts);
            },
            async editMessageReplyMarkup(opts) {
              editedReplyMarkup.push(opts);
            },
            async deleteMessage(opts) {
              deleted.push(opts);
            },
            async answerCallbackQuery(opts) {
              answeredCallbacks.push(opts);
            },
            async sendChatAction(opts) {
              chatActions.push(opts);
            },
          },
    log: (level, message) => logs.push({ level, message }),
    now: () => now,
    // data.code (P2-T7): REAL sandbox pool + harness-backed capability proxies,
    // so contract tests exercise true isolation, timeouts and console capture.
    code: {
      run: async (source, items, opts) => {
        const scope: Record<string, unknown> = {
          $items: items,
          $json: items[0]?.json ?? {},
          $vars: { ...varsBag },
        };
        return runInSandbox(source, scope, {
          mode: 'script',
          ...(opts?.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
          capabilities: {
            $http: {
              request: async (...args: unknown[]) => {
                const req = (args[0] ?? {}) as { method?: string; url?: string };
                return ctx.http.request({ method: req.method ?? 'GET', url: req.url ?? '', ...(args[0] as object) });
              },
              get: async (...args: unknown[]) =>
                ctx.http.request({ method: 'GET', url: String(args[0]) }),
            },
            $kv: {
              get: async (...args: unknown[]) => kvBag.get(`user:${String(args[0])}`),
              set: async (...args: unknown[]) => {
                kvBag.set(`user:${String(args[0])}`, args[1]);
              },
              delete: async (...args: unknown[]) => {
                kvBag.delete(`user:${String(args[0])}`);
              },
            },
          },
        });
      },
    },
    // flow.executeSubFlow (P3-T1): records calls; `subflowRun: null` simulates
    // an instance without sub-flow support; default echoes input items back.
    subflow:
      overrides.subflowRun === null
        ? null
        : {
            run: async (flowId, items) => {
              subflowCalls.push({ flowId, items });
              return overrides.subflowRun
                ? overrides.subflowRun(flowId, items)
                : { items };
            },
          },
    // data.userProfile (P3-T5): in-memory user store; `users: null` drops it.
    users:
      overrides.users === null
        ? null
        : {
            async get(tgUserId) {
              const u = usersBag.get(resolveUid(tgUserId));
              return u ? { ...u } : null;
            },
            async setProfile(fields, opts) {
              const u = upsertUser(resolveUid(opts?.tgUserId));
              u.profile = opts?.mode === 'replace' ? { ...fields } : { ...u.profile, ...fields };
              u.lastSeen = nowIso;
              return { ...u };
            },
            async addTags(tags, tgUserId) {
              const u = upsertUser(resolveUid(tgUserId));
              u.tags = [...new Set([...u.tags, ...tags])];
              u.lastSeen = nowIso;
              return { ...u };
            },
            async removeTags(tags, tgUserId) {
              const u = upsertUser(resolveUid(tgUserId));
              const drop = new Set(tags);
              u.tags = u.tags.filter((t) => !drop.has(t));
              u.lastSeen = nowIso;
              return { ...u };
            },
          },
    // data.collection (P3.5-T5): in-memory collection store; `collections: null`
    // drops it. Slugs must be "known" (seeded or in knownCollections) or ops
    // throw — mirroring the real store's CollectionNotFoundError.
    collections:
      overrides.collections === null
        ? null
        : {
            async find(slug, filter) {
              const map = requireCollection(slug);
              let recs = [...map.values()].filter((r) => matchesWhere(r.data, filter.where ?? []));
              recs = sortRecords(recs, filter.sort ?? []);
              const total = recs.length;
              const offset = filter.offset ?? 0;
              const end = filter.limit !== undefined ? offset + filter.limit : undefined;
              return { records: recs.slice(offset, end).map(cloneRec), total };
            },
            async get(slug, recordId) {
              const map = requireCollection(slug);
              const r = map.get(recordId);
              return r ? cloneRec(r) : null;
            },
            async count(slug, filter) {
              const map = requireCollection(slug);
              return [...map.values()].filter((r) => matchesWhere(r.data, filter.where ?? [])).length;
            },
            async insert(slug, data, opts) {
              const map = requireCollection(slug);
              const id = `rec${nextRecordId++}`;
              const rec: CollectionRecord = { id, data: { ...data }, createdAt: nowIso, updatedAt: nowIso };
              map.set(id, rec);
              if (!opts?.suppressEvents) recordEvents.push({ event: 'created', slug, recordId: id });
              return cloneRec(rec);
            },
            async update(slug, recordId, patch, opts) {
              const map = requireCollection(slug);
              const cur = map.get(recordId);
              if (!cur) throw new Error(`record not found: ${recordId}`);
              const data = opts?.mode === 'replace' ? { ...patch } : { ...cur.data, ...patch };
              const rec: CollectionRecord = { ...cur, data, updatedAt: nowIso };
              map.set(recordId, rec);
              if (!opts?.suppressEvents) recordEvents.push({ event: 'updated', slug, recordId });
              return cloneRec(rec);
            },
            async delete(slug, target, opts) {
              const map = requireCollection(slug);
              let ids: string[];
              if (target.recordId !== undefined) {
                ids = map.has(target.recordId) ? [target.recordId] : [];
              } else {
                ids = [...map.values()]
                  .filter((r) => matchesWhere(r.data, target.filter?.where ?? []))
                  .map((r) => r.id);
                if (ids.length > 1 && !opts?.confirmMany) {
                  throw new Error(`refusing to delete ${ids.length} records without confirmMany`);
                }
              }
              for (const id of ids) {
                map.delete(id);
                if (!opts?.suppressEvents) recordEvents.push({ event: 'deleted', slug, recordId: id });
              }
              return ids.length;
            },
          },
    // ai.llmChat (P5-T1): records requests; `aiResponses: null` simulates an
    // instance with no AI service (ctx.ai === null); omit → a default echo.
    ai:
      overrides.aiResponses === null
        ? null
        : {
            async chat(req) {
              aiCalls.push(req);
              const scripted = overrides.aiResponses;
              if (!scripted || scripted.length === 0) {
                const last = req.messages[req.messages.length - 1];
                return { reply: `echo: ${last?.content ?? ''}`, usage: {} };
              }
              const r = scripted[Math.min(aiIdx++, scripted.length - 1)]!;
              return { reply: r.reply, usage: r.usage ?? {}, ...(r.model ? { model: r.model } : {}) };
            },
          },
  };

  function requireCollection(slug: string): Map<string, CollectionRecord> {
    if (!knownSlugs.has(slug)) throw new Error(`collection not found: ${slug}`);
    let map = collectionsBag.get(slug);
    if (!map) {
      map = new Map();
      collectionsBag.set(slug, map);
    }
    return map;
  }

  return ctx;
}

/** Deep-ish clone a record so callers can't mutate the store. */
function cloneRec(r: CollectionRecord): CollectionRecord {
  return { ...r, data: structuredClone(r.data) };
}

/** Evaluate AND-combined where rows against a record's data (mirrors store ops). */
function matchesWhere(
  data: Record<string, unknown>,
  where: { field: string; op: string; value?: unknown }[],
): boolean {
  return where.every((row) => {
    const actual = readPath(data, row.field);
    switch (row.op) {
      case 'eq':
        return actual === row.value;
      case 'ne':
        return actual !== row.value;
      case 'gt':
        return Number(actual) > Number(row.value);
      case 'gte':
        return Number(actual) >= Number(row.value);
      case 'lt':
        return Number(actual) < Number(row.value);
      case 'lte':
        return Number(actual) <= Number(row.value);
      case 'contains':
        return String(actual ?? '').includes(String(row.value ?? ''));
      case 'in':
        return Array.isArray(row.value) ? row.value.includes(actual) : false;
      case 'exists':
        return row.value === false ? actual === undefined || actual === null : actual !== undefined && actual !== null;
      default:
        return false;
    }
  });
}

function sortRecords(recs: CollectionRecord[], sort: { field: string; dir?: 'asc' | 'desc' }[]): CollectionRecord[] {
  if (sort.length === 0) return recs;
  return [...recs].sort((a, b) => {
    for (const s of sort) {
      const av = readPath(a.data, s.field);
      const bv = readPath(b.data, s.field);
      if (av === bv) continue;
      const cmp = (av as number) < (bv as number) ? -1 : 1;
      return s.dir === 'desc' ? -cmp : cmp;
    }
    return 0;
  });
}

/** Read a dotted path from a record's data. */
function readPath(data: Record<string, unknown>, path: string): unknown {
  let cur: unknown = data;
  for (const part of path.split('.')) {
    if (typeof cur !== 'object' || cur === null) return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

/** Parse raw params through the node's schema — like NodeRegistry.parseParams. */
export function params<P>(def: NodeDef<P>, raw: unknown): P {
  const parsed = def.paramsSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`invalid params for ${def.type}: ${parsed.error.message}`);
  }
  return parsed.data;
}

export const item = (json: Record<string, unknown>): FlowItem => ({ json });
