/**
 * P3-T4 — credentials REST API + resolver tests over a real in-memory SQLite DB
 * and a fully wired engine (fake Telegram transport — no network).
 *
 * Covers: CRUD, secret encryption + masking (I7 — the plaintext NEVER appears
 * in any response), type-immutability on update, and the host-side resolver
 * that turns a stored credential into the auth headers the HTTP Request node
 * injects (the node never sees the decrypted secret).
 */
import { credentialAuthHeaders, credentialHint } from '@ctb/shared';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SESSION_COOKIE, buildApp } from '../src/app';
import { openDb, type Db } from '../src/db/index';
import { credentials as credentialsTable } from '../src/db/schema';
import { runMigrations } from '../src/db/migrate';
import { wireEngine, type Engine } from '../src/engine/wire';
import { decrypt, deriveKey } from '../src/lib/crypto';
import { loadEnv } from '../src/lib/env';

const SECRET = 'devsecret0123456';

interface World {
  app: FastifyInstance;
  db: Db;
  engine: Engine;
  cookie: { [k: string]: string };
}

async function makeWorld(): Promise<World> {
  const env = loadEnv({
    CTB_SECRET: SECRET, CTB_ADMIN_PASS: 'hunter2hunter2', NODE_ENV: 'test',
  } as NodeJS.ProcessEnv);
  const { db } = openDb(':memory:');
  runMigrations(db);
  const engine = wireEngine({ db, ctbSecret: SECRET });
  const app = buildApp({ env, db, engine, logger: false, editorDistDir: '/nonexistent' });
  const login = await app.inject({
    method: 'POST', url: '/api/auth/login',
    payload: { username: 'admin', password: 'hunter2hunter2' },
  });
  const cookie = { [SESSION_COOKIE]: login.cookies.find((c) => c.name === SESSION_COOKIE)!.value };
  return { app, db, engine, cookie };
}

describe('credentials API (P3-T4)', () => {
  let w: World;
  beforeEach(async () => { w = await makeWorld(); });
  afterEach(async () => { await w.engine.gateway.stopAll(); await w.app.close(); });

  it('requires auth (401 without cookie)', async () => {
    const res = await w.app.inject({ method: 'GET', url: '/api/credentials' });
    expect(res.statusCode).toBe(401);
  });

  it('create header-auth → secret encrypted at rest, masked in responses (I7)', async () => {
    const SECRET_VALUE = 'super-secret-api-key-value';
    const res = await w.app.inject({
      method: 'POST', url: '/api/credentials', cookies: w.cookie,
      payload: { name: 'My API', data: { type: 'httpHeaderAuth', headerName: 'X-API-Key', headerValue: SECRET_VALUE } },
    });
    expect(res.statusCode).toBe(201);
    const { credential } = res.json();
    expect(credential.name).toBe('My API');
    expect(credential.type).toBe('httpHeaderAuth');
    // The plaintext secret must NEVER leave the server (invariant I7).
    expect(JSON.stringify(res.json())).not.toContain(SECRET_VALUE);
    expect(credential.hint).toBe('X-API-Key: ••••alue');
    // But it IS stored encrypted and recoverable with the key.
    const row = w.db.select().from(credentialsTable).all()[0]!;
    expect(row.dataEnc).not.toContain(SECRET_VALUE);
    const data = JSON.parse(decrypt(row.dataEnc, deriveKey(SECRET)));
    expect(data.headerValue).toBe(SECRET_VALUE);
  });

  it('list / get never expose the secret', async () => {
    await w.app.inject({
      method: 'POST', url: '/api/credentials', cookies: w.cookie,
      payload: { name: 'B', data: { type: 'httpBearerAuth', token: 'tok_abcdefghij' } },
    });
    const list = await w.app.inject({ method: 'GET', url: '/api/credentials', cookies: w.cookie });
    expect(JSON.stringify(list.json())).not.toContain('tok_abcdefghij');
    expect(list.json().credentials[0].hint).toBe('Bearer ••••ghij');
  });

  it('update can rename + rotate secret, but NOT change type', async () => {
    const created = await w.app.inject({
      method: 'POST', url: '/api/credentials', cookies: w.cookie,
      payload: { name: 'X', data: { type: 'httpBearerAuth', token: 'old_token_value' } },
    });
    const id = created.json().credential.id;

    // rename + rotate (same type) → ok
    const ok = await w.app.inject({
      method: 'PATCH', url: `/api/credentials/${id}`, cookies: w.cookie,
      payload: { name: 'Renamed', data: { type: 'httpBearerAuth', token: 'new_token_value' } },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().credential.name).toBe('Renamed');
    expect(ok.json().credential.hint).toBe('Bearer ••••alue');

    // changing the type → rejected
    const bad = await w.app.inject({
      method: 'PATCH', url: `/api/credentials/${id}`, cookies: w.cookie,
      payload: { data: { type: 'httpBasicAuth', username: 'u', password: 'p' } },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toBe('type_immutable');
  });

  it('delete removes the credential', async () => {
    const created = await w.app.inject({
      method: 'POST', url: '/api/credentials', cookies: w.cookie,
      payload: { name: 'D', data: { type: 'httpHeaderAuth', headerName: 'H', headerValue: 'v' } },
    });
    const id = created.json().credential.id;
    const del = await w.app.inject({ method: 'DELETE', url: `/api/credentials/${id}`, cookies: w.cookie });
    expect(del.statusCode).toBe(200);
    const after = await w.app.inject({ method: 'GET', url: `/api/credentials/${id}`, cookies: w.cookie });
    expect(after.statusCode).toBe(404);
  });

  it('rejects an invalid body (400)', async () => {
    const res = await w.app.inject({
      method: 'POST', url: '/api/credentials', cookies: w.cookie,
      payload: { name: '', data: { type: 'httpBearerAuth', token: '' } },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('invalid_body');
  });

  // --- Phase E / PE-T1: voiceConnection credential + health route -----------

  it('create a voiceConnection (userbot) → session encrypted, never leaked (I7)', async () => {
    const SESSION = '1BVtsOXYZsecretsession0123456789';
    const res = await w.app.inject({
      method: 'POST', url: '/api/credentials', cookies: w.cookie,
      payload: {
        name: 'My userbot',
        data: {
          type: 'voiceConnection', kind: 'userbot',
          apiId: 1234567, apiHash: 'abcdef0123456789', session: SESSION,
        },
      },
    });
    expect(res.statusCode).toBe(201);
    const { credential } = res.json();
    expect(credential.type).toBe('voiceConnection');
    // The session string must NEVER leave the server (invariant I7).
    expect(JSON.stringify(res.json())).not.toContain(SESSION);
    expect(credential.hint).toBe('userbot · ••••6789');
    // ...but it IS stored encrypted and recoverable with the key.
    const row = w.db.select().from(credentialsTable).all()[0]!;
    expect(row.dataEnc).not.toContain(SESSION);
    const data = JSON.parse(decrypt(row.dataEnc, deriveKey(SECRET)));
    expect(data.session).toBe(SESSION);
  });

  it('voice-health: a well-formed userbot is structurally valid (no adapter yet, PE-T1)', async () => {
    const created = await w.app.inject({
      method: 'POST', url: '/api/credentials', cookies: w.cookie,
      payload: {
        name: 'vc', data: {
          type: 'voiceConnection', kind: 'userbot',
          apiId: 1234567, apiHash: 'h', session: 's3ss10n',
        },
      },
    });
    const id = created.json().credential.id;
    const health = await w.app.inject({
      method: 'POST', url: `/api/credentials/${id}/voice-health`, cookies: w.cookie,
    });
    expect(health.statusCode).toBe(200);
    expect(health.json().health.ok).toBe(true);
    expect(health.json().health.kind).toBe('userbot');
    expect(health.json().health.error).toMatch(/not wired yet/);
  });

  it('voice-health: an incomplete userbot fails closed {ok:false} (PE-T1)', async () => {
    // session blank/omitted → server stores it, the health probe fails closed.
    const created = await w.app.inject({
      method: 'POST', url: '/api/credentials', cookies: w.cookie,
      payload: {
        name: 'vc-bad', data: {
          type: 'voiceConnection', kind: 'userbot', apiId: 1234567, apiHash: 'h',
        },
      },
    });
    const id = created.json().credential.id;
    const health = await w.app.inject({
      method: 'POST', url: `/api/credentials/${id}/voice-health`, cookies: w.cookie,
    });
    expect(health.statusCode).toBe(200);
    expect(health.json().health.ok).toBe(false);
    expect(health.json().health.error).toMatch(/missing its session string/);
  });

  it('voice-health: 404 unknown id, 409 on a non-voice credential', async () => {
    const notFound = await w.app.inject({
      method: 'POST', url: '/api/credentials/nope/voice-health', cookies: w.cookie,
    });
    expect(notFound.statusCode).toBe(404);

    const created = await w.app.inject({
      method: 'POST', url: '/api/credentials', cookies: w.cookie,
      payload: { name: 'b', data: { type: 'httpBearerAuth', token: 'tok123456' } },
    });
    const id = created.json().credential.id;
    const wrong = await w.app.inject({
      method: 'POST', url: `/api/credentials/${id}/voice-health`, cookies: w.cookie,
    });
    expect(wrong.statusCode).toBe(409);
    expect(wrong.json().error).toBe('not_a_voice_connection');
  });

  it('voice-health requires auth (401 without cookie)', async () => {
    const res = await w.app.inject({
      method: 'POST', url: '/api/credentials/any/voice-health',
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('credential resolver → auth headers (P3-T4)', () => {
  it('header / bearer / basic each map to the right headers', () => {
    expect(credentialAuthHeaders({ type: 'httpHeaderAuth', headerName: 'X-API-Key', headerValue: 'k' }))
      .toEqual({ 'x-api-key': 'k' });
    expect(credentialAuthHeaders({ type: 'httpBearerAuth', token: 't' }))
      .toEqual({ authorization: 'Bearer t' });
    // base64("user:pass") = dXNlcjpwYXNz
    expect(credentialAuthHeaders({ type: 'httpBasicAuth', username: 'user', password: 'pass' }))
      .toEqual({ authorization: 'Basic dXNlcjpwYXNz' });
  });

  it('hint never reveals more than the last 4 chars', () => {
    expect(credentialHint({ type: 'httpBearerAuth', token: 'abcdefghij' })).toBe('Bearer ••••ghij');
    expect(credentialHint({ type: 'httpHeaderAuth', headerName: 'H', headerValue: 'xy' })).toBe('H: ••••');
  });

  it('voiceConnection hint shows the kind + a masked session, never the secret (PE-T1)', () => {
    expect(
      credentialHint({
        type: 'voiceConnection', kind: 'userbot',
        apiId: 1, apiHash: 'h', session: '1BVtsOsecret9876',
      }),
    ).toBe('userbot · ••••9876');
    expect(
      credentialHint({ type: 'voiceConnection', kind: 'external', bridgeUrl: 'https://b.example.com' }),
    ).toBe('external · https://b.example.com');
    // A connector that injects no HTTP headers (it's resolved into a media engine).
    expect(
      credentialAuthHeaders({
        type: 'voiceConnection', kind: 'userbot', apiId: 1, apiHash: 'h', session: 's',
      }),
    ).toEqual({});
  });
});
