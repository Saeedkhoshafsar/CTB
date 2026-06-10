import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SESSION_COOKIE, buildApp } from '../src/app';
import { loadEnv } from '../src/lib/env';

function makeApp(extraEnv: Record<string, string> = {}): FastifyInstance {
  const env = loadEnv({
    CTB_SECRET: 'devsecret0123456',
    CTB_ADMIN_USER: 'admin',
    CTB_ADMIN_PASS: 'hunter2hunter2',
    NODE_ENV: 'test',
    ...extraEnv,
  } as NodeJS.ProcessEnv);
  return buildApp({ env, logger: false, editorDistDir: '/nonexistent' });
}

describe('server app (P0-T4)', () => {
  let app: FastifyInstance;

  beforeEach(() => {
    app = makeApp();
  });
  afterEach(async () => {
    await app.close();
  });

  it('GET /healthz → {ok:true}', async () => {
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });

  it('protected route 401 without session', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/auth/me' });
    expect(res.statusCode).toBe(401);
  });

  it('login → cookie → protected route 200; logout → 401 again', async () => {
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'admin', password: 'hunter2hunter2' },
    });
    expect(login.statusCode).toBe(200);
    const cookie = login.cookies.find((c) => c.name === SESSION_COOKIE);
    expect(cookie).toBeDefined();
    expect(cookie?.httpOnly).toBe(true);

    const me = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      cookies: { [SESSION_COOKIE]: cookie!.value },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toEqual({ user: { username: 'admin' } });

    const logout = await app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      cookies: { [SESSION_COOKIE]: cookie!.value },
    });
    expect(logout.statusCode).toBe(200);
    const cleared = logout.cookies.find((c) => c.name === SESSION_COOKIE);
    expect(cleared?.value).toBe('');
  });

  it('rejects wrong credentials with 401', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'admin', password: 'wrong' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('rejects malformed login body with 400', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { nope: 1 } });
    expect(res.statusCode).toBe(400);
  });

  it('503 when CTB_ADMIN_PASS is not configured', async () => {
    const noPass = buildApp({
      env: loadEnv({ CTB_SECRET: 'devsecret0123456', NODE_ENV: 'test' } as NodeJS.ProcessEnv),
      logger: false,
      editorDistDir: '/nonexistent',
    });
    const res = await noPass.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'admin', password: 'x' },
    });
    expect(res.statusCode).toBe(503);
    await noPass.close();
  });

  it('guards arbitrary /api/* routes (401 without session)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/flows' });
    expect(res.statusCode).toBe(401);
  });

  it('forged cookie is rejected', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      cookies: { [SESSION_COOKIE]: 'forged.token' },
    });
    expect(res.statusCode).toBe(401);
  });
});
