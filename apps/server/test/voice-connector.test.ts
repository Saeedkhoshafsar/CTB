/**
 * Phase E / PE-T1 — voice-connection resolution + fail-closed health.
 *
 * These tests pin the ONE place that decides "is this voice connector usable?"
 * (`resolveVoiceConnection`) and the panel's leak-free "test connection" path
 * (`validateVoiceConnection`). PE-T1 ships NO media engine, so the contract here
 * is: a well-formed credential resolves into a normalized connector; an
 * incomplete/wrong-type one throws a CLEAR, secret-free error (fail-closed); and
 * the health probe never lets a secret escape — a thrown error becomes
 * `{ok:false, error}`, and when no adapter is wired it honestly reports
 * "valid, login not yet attempted".
 */
import type { CredentialData } from '@ctb/shared';
import { describe, expect, it, vi } from 'vitest';
import {
  resolveVoiceConnection,
  validateVoiceConnection,
  VoiceConnectionError,
  type VoiceConnector,
  type VoiceConnectorHealth,
} from '../src/engine/voice-connector';

const SESSION = '1BVtsOXYZsecretsessionstring0123456789';

function userbot(over: Partial<CredentialData> = {}): CredentialData {
  return {
    type: 'voiceConnection',
    kind: 'userbot',
    apiId: 1234567,
    apiHash: 'abcdef0123456789abcdef0123456789',
    session: SESSION,
    ...over,
  } as CredentialData;
}

describe('resolveVoiceConnection (PE-T1, fail-closed)', () => {
  it('normalizes a complete userbot credential', () => {
    const r = resolveVoiceConnection('cred1', userbot());
    expect(r).toEqual({
      credentialId: 'cred1',
      kind: 'userbot',
      apiId: 1234567,
      apiHash: 'abcdef0123456789abcdef0123456789',
      session: SESSION,
    });
  });

  it('treats companion exactly like userbot (MTProto login fields)', () => {
    const r = resolveVoiceConnection('cred2', userbot({ kind: 'companion' } as Partial<CredentialData>));
    expect(r.kind).toBe('companion');
    expect(r.session).toBe(SESSION);
    expect(r.apiId).toBe(1234567);
  });

  it('resolves an external bridge (url required, token optional)', () => {
    const r = resolveVoiceConnection('cred3', {
      type: 'voiceConnection',
      kind: 'external',
      bridgeUrl: 'https://bridge.example.com',
      bridgeToken: 'btok',
    } as CredentialData);
    expect(r).toEqual({
      credentialId: 'cred3',
      kind: 'external',
      bridgeUrl: 'https://bridge.example.com',
      bridgeToken: 'btok',
    });
  });

  it('omits the optional external token when absent', () => {
    const r = resolveVoiceConnection('cred4', {
      type: 'voiceConnection',
      kind: 'external',
      bridgeUrl: 'https://bridge.example.com',
    } as CredentialData);
    expect(r.bridgeToken).toBeUndefined();
  });

  it('throws on a non-voiceConnection credential', () => {
    expect(() =>
      resolveVoiceConnection('credX', { type: 'httpBearerAuth', token: 't' } as CredentialData),
    ).toThrow(VoiceConnectionError);
    expect(() =>
      resolveVoiceConnection('credX', { type: 'httpBearerAuth', token: 't' } as CredentialData),
    ).toThrow(/is not a voice-connection credential/);
  });

  it('fails closed on a userbot missing api_id', () => {
    expect(() =>
      resolveVoiceConnection('c', userbot({ apiId: undefined } as Partial<CredentialData>)),
    ).toThrow(/missing api_id/);
  });

  it('fails closed on a userbot missing api_hash', () => {
    expect(() =>
      resolveVoiceConnection('c', userbot({ apiHash: undefined } as Partial<CredentialData>)),
    ).toThrow(/missing api_hash/);
  });

  it('fails closed on a userbot missing its session string', () => {
    expect(() =>
      resolveVoiceConnection('c', userbot({ session: undefined } as Partial<CredentialData>)),
    ).toThrow(/missing its session string/);
  });

  it('fails closed on an external connector missing a bridge URL', () => {
    expect(() =>
      resolveVoiceConnection('c', {
        type: 'voiceConnection',
        kind: 'external',
      } as CredentialData),
    ).toThrow(/missing a bridge URL/);
  });

  it('never leaks the session string in an error message', () => {
    try {
      resolveVoiceConnection('c', userbot({ apiHash: undefined } as Partial<CredentialData>));
      expect.fail('should have thrown');
    } catch (err) {
      expect((err as Error).message).not.toContain(SESSION);
    }
  });
});

describe('validateVoiceConnection (PE-T1 health probe)', () => {
  it('reports config-valid / login-not-attempted when NO adapter is wired (PE-T1)', async () => {
    const h = await validateVoiceConnection('c', userbot());
    expect(h.ok).toBe(true);
    expect(h.kind).toBe('userbot');
    expect(h.error).toMatch(/not wired yet/);
  });

  it('returns {ok:false} (not a throw) for an incomplete credential', async () => {
    const h = await validateVoiceConnection('c', userbot({ session: undefined } as Partial<CredentialData>));
    expect(h.ok).toBe(false);
    expect(h.kind).toBe('userbot');
    expect(h.error).toMatch(/missing its session string/);
  });

  it('reports the kind even when the credential is the wrong type', async () => {
    const h = await validateVoiceConnection('c', {
      type: 'voiceConnection',
      kind: 'external',
    } as CredentialData);
    expect(h.ok).toBe(false);
    expect(h.kind).toBe('external');
  });

  it('delegates to a wired adapter and surfaces its health verbatim', async () => {
    const ok: VoiceConnectorHealth = { ok: true, kind: 'userbot', account: '@operator' };
    const connector = {
      kind: 'userbot',
      checkHealth: vi.fn(async () => ok),
      connect: vi.fn(),
      speak: vi.fn(),
      onUtterance: vi.fn(),
      leave: vi.fn(),
    } as unknown as VoiceConnector;
    const h = await validateVoiceConnection('c', userbot(), connector);
    expect(h).toEqual(ok);
    expect(connector.checkHealth).toHaveBeenCalledOnce();
  });

  it('catches an adapter that throws → leak-free {ok:false}', async () => {
    const connector = {
      kind: 'userbot',
      checkHealth: vi.fn(async () => {
        throw new Error('login failed: PHONE_CODE_EXPIRED');
      }),
      connect: vi.fn(),
      speak: vi.fn(),
      onUtterance: vi.fn(),
      leave: vi.fn(),
    } as unknown as VoiceConnector;
    const h = await validateVoiceConnection('c', userbot(), connector);
    expect(h.ok).toBe(false);
    expect(h.kind).toBe('userbot');
    expect(h.error).toMatch(/login failed/);
  });
});
