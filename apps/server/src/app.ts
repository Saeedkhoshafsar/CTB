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
import { registerBotsApi, type BotsApiDeps } from './api/bots';
import { registerExecutionsApi } from './api/executions';
import { registerFlowsApi } from './api/flows';
import { registerNodeTypesApi } from './api/node-types';
import type { Db } from './db/index';
import type { Engine } from './engine/wire';
import type { Env } from './lib/env';
import { deriveKey } from './lib/crypto';
import { createSessionToken, safeEqual, verifySessionToken } from './lib/session';
import { registerWebhookRoute } from './telegram/gateway';

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
    const userOk = safeEqual(username, env.CTB_ADMIN_USER);
    const passOk = safeEqual(password, env.CTB_ADMIN_PASS);
    if (!userOk || !passOk) {
      return reply.code(401).send({ error: 'invalid_credentials' });
    }
    const token = createSessionToken(username, env.CTB_SECRET);
    return reply
      .setCookie(SESSION_COOKIE, token, {
        path: '/',
        httpOnly: true,
        sameSite: 'lax',
        secure: secureCookie,
        maxAge: 7 * 24 * 60 * 60,
      })
      .send({ ok: true, user: { username } });
  });

  app.post('/api/auth/logout', async (_req, reply) => {
    return reply.clearCookie(SESSION_COOKIE, { path: '/' }).send({ ok: true });
  });

  const requireAuth = async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const raw = req.cookies[SESSION_COOKIE];
    const session = raw ? verifySessionToken(raw, env.CTB_SECRET) : null;
    if (!session) {
      await reply.code(401).send({ error: 'unauthorized' });
      return;
    }
    (req as FastifyRequest & { session: { sub: string } }).session = { sub: session.sub };
  };

  app.get('/api/auth/me', { preHandler: requireAuth }, async (req) => {
    const { session } = req as FastifyRequest & { session: { sub: string } };
    return { user: { username: session.sub } };
  });

  // Auth guard for everything under /api/ except the auth routes themselves.
  app.addHook('preHandler', async (req, reply) => {
    if (!req.url.startsWith('/api/')) return;
    if (req.url.startsWith('/api/auth/')) return;
    await requireAuth(req, reply);
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
    registerFlowsApi(app, { db: opts.db, registry: opts.engine.registry });
    registerExecutionsApi(app, { db: opts.db });
    registerNodeTypesApi(app, opts.engine.registry);
    registerWebhookRoute(app, opts.engine.gateway);
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
