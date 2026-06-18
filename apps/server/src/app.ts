/**
 * Fastify app factory — separated from main.ts so tests can build the app
 * without binding a port (fastify.inject()).
 *
 * P0-T4 scope: /healthz, admin auth (login/logout/me via signed cookie),
 * auth guard for /api/*, static serving of the editor build when present.
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import fastifyCookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { z } from 'zod';
import type BetterSqlite3 from 'better-sqlite3';
import { registerApiTokensApi } from './api/api-tokens';
import { registerInstanceWebhooksApi } from './api/instance-webhooks';
import { registerBotsApi, type BotsApiDeps } from './api/bots';
import { registerCollectionsApi } from './api/collections';
import { registerCredentialsApi } from './api/credentials';
import { registerExecutionsApi } from './api/executions';
import { registerFlowsApi } from './api/flows';
import { registerNodeTypesApi } from './api/node-types';
import { registerRecordsApi } from './api/records';
import { registerUsersApi } from './api/users';
import { registerV1Api } from './api/v1';
import { SqliteCollectionStore } from './collections/store';
import { SqliteFileStore } from './collections/file-store';
import type { Db } from './db/index';
import type { Engine } from './engine/wire';
import type { Env } from './lib/env';
import { deriveKey } from './lib/crypto';
import { createSessionToken, safeEqual, verifySessionToken, type SessionRole } from './lib/session';
import { registerWebhookRoute } from './telegram/gateway';
import { registerWebhookTriggerRoute } from './triggers/webhook';

export const SESSION_COOKIE = 'ctb_session';

const LoginBodySchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

export interface BuildAppOptions {
  env: Env;
  /** Override editor dist dir (tests). Default: ../../editor/dist relative to this file. */
  editorDistDir?: string;
  /** Fastify logger options; false disables (tests). */
  logger?: boolean | object;
  /**
   * Engine integration (P1-T8): when db+engine are provided, the bots/flows
   * APIs and the Telegram webhook route are mounted. Tests that only exercise
   * auth/static may omit them — the app still boots.
   */
  db?: Db;
  engine?: Engine;
  /**
   * Raw better-sqlite3 handle (P3.5-T2) — the Collections store needs it for
   * the `json_extract` filter queries and the computed-index DDL that Drizzle
   * can't express. When omitted, the Collections/records APIs are not mounted.
   */
  sqlite?: BetterSqlite3.Database;
  /** Extra bot-registration opts per bot (botInfo/fake transport in tests). */
  botRegisterOpts?: BotsApiDeps['registerOpts'];
}

function defaultEditorDist(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'editor', 'dist');
}

export function buildApp(opts: BuildAppOptions): FastifyInstance {
  const { env } = opts;
  const app = Fastify({
    logger: opts.logger ?? {
      level: env.NODE_ENV === 'production' ? 'info' : 'debug',
      redact: ['req.headers.authorization', 'req.headers.cookie'],
    },
  });

  void app.register(fastifyCookie);

  // ---- health -------------------------------------------------------------
  app.get('/healthz', async () => ({ ok: true }));

  // ---- auth ---------------------------------------------------------------
  const secureCookie = env.NODE_ENV === 'production';

  app.post('/api/auth/login', async (req, reply) => {
    const parsed = LoginBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_body' });
    }
    const { username, password } = parsed.data;
    if (!env.CTB_ADMIN_PASS) {
      req.log.warn('login attempted but CTB_ADMIN_PASS is not configured');
      return reply.code(503).send({ error: 'admin_auth_not_configured' });
    }
    // Resolve the role from the matching account. Admin wins if both share a
    // username. Operator login only works when CTB_OPERATOR_PASS is configured.
    let role: SessionRole | null = null;
    if (safeEqual(username, env.CTB_ADMIN_USER) && safeEqual(password, env.CTB_ADMIN_PASS)) {
      role = 'admin';
    } else if (
      env.CTB_OPERATOR_PASS &&
      safeEqual(username, env.CTB_OPERATOR_USER) &&
      safeEqual(password, env.CTB_OPERATOR_PASS)
    ) {
      role = 'operator';
    }
    if (!role) {
      return reply.code(401).send({ error: 'invalid_credentials' });
    }
    const token = createSessionToken(username, env.CTB_SECRET, role);
    return reply
      .setCookie(SESSION_COOKIE, token, {
        path: '/',
        httpOnly: true,
        sameSite: 'lax',
        secure: secureCookie,
        maxAge: 7 * 24 * 60 * 60,
      })
      .send({ ok: true, user: { username, role } });
  });

  app.post('/api/auth/logout', async (_req, reply) => {
    return reply.clearCookie(SESSION_COOKIE, { path: '/' }).send({ ok: true });
  });

  type AuthedRequest = FastifyRequest & { session: { sub: string; role: SessionRole } };

  /** Returns true when authenticated; otherwise sends 401 and returns false. */
  const requireAuth = async (req: FastifyRequest, reply: FastifyReply): Promise<boolean> => {
    const raw = req.cookies[SESSION_COOKIE];
    const session = raw ? verifySessionToken(raw, env.CTB_SECRET) : null;
    if (!session) {
      await reply.code(401).send({ error: 'unauthorized' });
      return false;
    }
    (req as AuthedRequest).session = { sub: session.sub, role: session.role };
    return true;
  };

  app.get('/api/auth/me', { preHandler: requireAuth }, async (req) => {
    const { session } = req as AuthedRequest;
    return { user: { username: session.sub, role: session.role } };
  });

  /**
   * The Data section the operator role is allowed to reach (ARCHITECTURE §13.5):
   * record CRUD/query and file upload/download. Defining or editing the
   * collection SCHEMA stays admin-only — operators manage data, not structure.
   * Anything else under /api/ (bots, flows, executions, credentials, users, and
   * the collection-definition routes) is admin-only.
   */
  const operatorAllowed = (url: string): boolean => {
    const path = url.split('?')[0] ?? url;
    return path.startsWith('/api/records') || path.startsWith('/api/files');
  };

  // Auth guard for everything under /api/ except the auth routes themselves,
  // plus role enforcement for the operator. The public v1 API (/api/v1/*) is
  // EXEMPT — it has its own bearer-token auth (P4-T3, registerV1Api), so the
  // panel cookie guard must not touch it.
  app.addHook('preHandler', async (req, reply) => {
    if (!req.url.startsWith('/api/')) return;
    if (req.url.startsWith('/api/auth/')) return;
    if (req.url.startsWith('/api/v1/')) return;
    const ok = await requireAuth(req, reply);
    if (!ok) return; // 401 already sent
    const { session } = req as AuthedRequest;
    if (session.role === 'operator' && !operatorAllowed(req.url)) {
      await reply.code(403).send({ error: 'forbidden' });
    }
  });

  // ---- engine APIs (P1-T8) -------------------------------------------------
  if (opts.db && opts.engine) {
    const key = deriveKey(env.CTB_SECRET);
    registerBotsApi(app, {
      db: opts.db,
      key,
      gateway: opts.engine.gateway,
      publicUrl: env.CTB_PUBLIC_URL,
      ...(opts.botRegisterOpts ? { registerOpts: opts.botRegisterOpts } : {}),
    });
    registerFlowsApi(app, {
      db: opts.db,
      registry: opts.engine.registry,
      executor: opts.engine.executor,
      ctbSecret: env.CTB_SECRET,
      ...(env.CTB_PUBLIC_URL ? { publicUrl: env.CTB_PUBLIC_URL } : {}),
      // P4-T2: re-arm cron schedules whenever the active-flow set changes.
      onFlowsChanged: () => void opts.engine!.scheduler.reconcile(),
    });
    registerExecutionsApi(app, { db: opts.db });
    registerCredentialsApi(app, { db: opts.db, key });
    registerUsersApi(app, { userStore: opts.engine.userStore });
    registerNodeTypesApi(app, opts.engine.registry);
    // P4-T3: API-token management (admin-only, panel cookie auth).
    registerApiTokensApi(app, { db: opts.db });
    // P4-T4: outbound instance-webhook management (admin-only, panel cookie auth).
    registerInstanceWebhooksApi(app, { db: opts.db });
    registerWebhookRoute(app, opts.engine.gateway);
    // P4-T1: inbound Webhook Trigger route (public, outside /api/).
    registerWebhookTriggerRoute(app, {
      db: opts.db,
      executor: opts.engine.executor,
      store: opts.engine.store,
      ctbSecret: env.CTB_SECRET,
    });
    // P4-T3: public REST API v1 (bearer-token auth, its own preHandler).
    registerV1Api(app, {
      db: opts.db,
      flowSource: opts.engine.flowSource,
      executor: opts.engine.executor,
      registry: opts.engine.registry,
      gateway: opts.engine.gateway,
      userStore: opts.engine.userStore,
      // PC-T2: re-arm cron schedules when a v1 authoring write changes the
      // active-flow set / graphs, exactly like the panel's flows API.
      onFlowsChanged: () => void opts.engine!.scheduler.reconcile(),
    });

    // Collections layer (P3.5-T2 + P3.5-T5). Needs the raw sqlite handle for
    // json_extract queries + computed-index DDL. Definitions are admin-only;
    // records/files are reachable by the operator role too (guard above).
    // REUSE the engine's collection store + event bus when wired (P3.5-T5) so a
    // panel write and a `data.collection` write share one store + one bus — the
    // recordChanged trigger then fires for BOTH. Falls back to a fresh store.
    if (opts.sqlite) {
      const collectionStore =
        opts.engine?.collectionStore ?? new SqliteCollectionStore(opts.db, opts.sqlite);
      const fileStore = new SqliteFileStore(opts.db, env.CTB_DATA_DIR);
      registerCollectionsApi(app, { db: opts.db, store: collectionStore });
      registerRecordsApi(app, {
        store: collectionStore,
        fileStore,
        ...(opts.engine?.recordEventBus ? { recordEventBus: opts.engine.recordEventBus } : {}),
      });
    }
  }

  // ---- editor static ------------------------------------------------------
  const distDir = opts.editorDistDir ?? defaultEditorDist();
  if (existsSync(join(distDir, 'index.html'))) {
    void app.register(fastifyStatic, { root: distDir, prefix: '/' });
    // SPA fallback: non-API GETs → index.html
    app.setNotFoundHandler((req, reply) => {
      if (req.method === 'GET' && !req.url.startsWith('/api/')) {
        return reply.sendFile('index.html');
      }
      return reply.code(404).send({ error: 'not_found' });
    });
  }

  return app;
}
