/**
 * Phase E / PE-T2 — Call Session Service + the loopback connector.
 *
 * These tests pin the long-lived host runtime behind `ctx.call` (PLAN2 §E.1):
 *   - connect/leave is idempotent and drives the pluggable connector;
 *   - "behaviour = config" — the SAME service serves a 1:1 `support` call AND a
 *     `lineup` Q&A queue (sequential + random), with no node fork;
 *   - HARD CAPS (host-wide + per-bot concurrency) fail `connect` loudly;
 *   - inbound utterances are tracked, queue listeners in lineup, and fan out to
 *     the PE-T3 utterance sink;
 *   - the fail-closed credential resolver is honoured (a bad credential throws);
 *   - speak decodes audio/fileId/pcm and a missing file store / empty speak throw.
 *
 * The loopback connector carries no native dep, so the whole service is exercised
 * deterministically without MTProto (invariant I3).
 */
import type { CredentialData } from '@ctb/shared';
import { describe, expect, it, vi } from 'vitest';
import { LoopbackVoiceConnector } from '../src/engine/loopback-connector';
import {
  resolveVoiceConnection,
  VoiceConnectionError,
  type ResolvedVoiceConnection,
} from '../src/engine/voice-connector';
import {
  CallSessionService,
  makeVoiceCredentialResolver,
  type CallCaps,
} from '../src/triggers/call-session';

const SESSION = '1BVtsOXYZsecretsessionstring0123456789';

function userbotCred(): CredentialData {
  return {
    type: 'voiceConnection',
    kind: 'userbot',
    apiId: 1234567,
    apiHash: 'abcdef0123456789abcdef0123456789',
    session: SESSION,
  } as CredentialData;
}

/** A resolver that returns a valid connection for `good`, throws otherwise. */
function fixedResolver(): (id: string) => ResolvedVoiceConnection {
  return makeVoiceCredentialResolver((id) => (id === 'good' ? userbotCred() : null));
}

function makeService(opts?: {
  connector?: LoopbackVoiceConnector;
  caps?: Partial<CallCaps>;
  readFile?: (id: string) => Promise<{ bytes: Uint8Array; mime: string | null }>;
}): { svc: CallSessionService; connector: LoopbackVoiceConnector } {
  const connector = opts?.connector ?? new LoopbackVoiceConnector();
  const svc = new CallSessionService({
    connector,
    resolveCredential: fixedResolver(),
    ...(opts?.readFile ? { readFile: opts.readFile } : {}),
    ...(opts?.caps ? { caps: opts.caps } : {}),
  });
  return { svc, connector };
}

const USER_TARGET = { kind: 'user' as const, id: 42 };
const CHANNEL_TARGET = { kind: 'channel' as const, id: -100123 };

describe('CallSessionService — connect/leave (PE-T2)', () => {
  it('connects via the connector and reports status', async () => {
    const { svc, connector } = makeService();
    const cap = svc.capabilityFor('bot1', 'flow1');

    await cap.connect({ credentialId: 'good', target: USER_TARGET, mode: 'support' });

    expect(svc.callCount).toBe(1);
    expect(connector.isConnected({ kind: 'user', id: 42 })).toBe(true);
    const st = await cap.status({ target: USER_TARGET });
    expect(st).toMatchObject({ connected: true, mode: 'support', currentTurn: null, queue: [] });
  });

  it('connect is idempotent per target', async () => {
    const { svc } = makeService();
    const cap = svc.capabilityFor('bot1', 'flow1');
    await cap.connect({ credentialId: 'good', target: USER_TARGET, mode: 'support' });
    await cap.connect({ credentialId: 'good', target: USER_TARGET, mode: 'support' });
    expect(svc.callCount).toBe(1);
  });

  it('leave tears down the call and is idempotent', async () => {
    const { svc, connector } = makeService();
    const cap = svc.capabilityFor('bot1', 'flow1');
    await cap.connect({ credentialId: 'good', target: USER_TARGET, mode: 'support' });
    await cap.leave({ target: USER_TARGET });
    expect(svc.callCount).toBe(0);
    expect(connector.isConnected({ kind: 'user', id: 42 })).toBe(false);
    await cap.leave({ target: USER_TARGET }); // no throw
    const st = await cap.status({ target: USER_TARGET });
    expect(st.connected).toBe(false);
  });

  it('fail-closed: a bad credential id throws (never connects)', async () => {
    const { svc, connector } = makeService();
    const cap = svc.capabilityFor('bot1', 'flow1');
    await expect(
      cap.connect({ credentialId: 'missing', target: USER_TARGET, mode: 'support' }),
    ).rejects.toThrow(VoiceConnectionError);
    expect(svc.callCount).toBe(0);
    expect(connector.callCount).toBe(0);
  });

  it('stop() leaves every live call', async () => {
    const { svc, connector } = makeService();
    const cap = svc.capabilityFor('bot1', 'flow1');
    await cap.connect({ credentialId: 'good', target: USER_TARGET, mode: 'support' });
    await cap.connect({ credentialId: 'good', target: CHANNEL_TARGET, mode: 'lineup' });
    expect(svc.callCount).toBe(2);
    svc.stop();
    expect(svc.callCount).toBe(0);
  });
});

describe('CallSessionService — hard caps (PE-T2)', () => {
  it('rejects connect past the host-wide concurrent-call cap', async () => {
    const { svc } = makeService({ caps: { maxConcurrentCalls: 1, maxCallsPerBot: 99 } });
    const cap = svc.capabilityFor('bot1', 'flow1');
    await cap.connect({ credentialId: 'good', target: USER_TARGET, mode: 'support' });
    await expect(
      cap.connect({ credentialId: 'good', target: CHANNEL_TARGET, mode: 'support' }),
    ).rejects.toThrow(/host call limit/);
    expect(svc.callCount).toBe(1);
  });

  it('rejects connect past the per-bot cap but allows another bot', async () => {
    const { svc } = makeService({ caps: { maxCallsPerBot: 1, maxConcurrentCalls: 99 } });
    const bot1 = svc.capabilityFor('bot1', 'flow1');
    const bot2 = svc.capabilityFor('bot2', 'flow1');
    await bot1.connect({ credentialId: 'good', target: USER_TARGET, mode: 'support' });
    await expect(
      bot1.connect({ credentialId: 'good', target: CHANNEL_TARGET, mode: 'support' }),
    ).rejects.toThrow(/bot call limit/);
    // a different bot still has budget
    await bot2.connect({ credentialId: 'good', target: CHANNEL_TARGET, mode: 'support' });
    expect(svc.callsForBot('bot1')).toBe(1);
    expect(svc.callsForBot('bot2')).toBe(1);
  });

  it('auto-leaves a call that exceeds the max duration', async () => {
    vi.useFakeTimers();
    try {
      const { svc } = makeService({ caps: { maxCallSeconds: 5 } });
      const cap = svc.capabilityFor('bot1', 'flow1');
      await cap.connect({ credentialId: 'good', target: USER_TARGET, mode: 'support' });
      expect(svc.callCount).toBe(1);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(svc.callCount).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('CallSessionService — support mode (1:1 / open group)', () => {
  it('grantTurn is a no-op in support mode (everyone may speak)', async () => {
    const { svc } = makeService();
    const cap = svc.capabilityFor('bot1', 'flow1');
    await cap.connect({ credentialId: 'good', target: USER_TARGET, mode: 'support' });
    const granted = await cap.grantTurn({ target: USER_TARGET });
    expect(granted).toBeNull();
  });

  it('an inbound utterance fans out to the PE-T3 sink tagged with bot/flow/mode', async () => {
    const { svc, connector } = makeService();
    const seen: unknown[] = [];
    svc.onUtterance((u) => seen.push(u));
    const cap = svc.capabilityFor('bot7', 'flow9');
    await cap.connect({ credentialId: 'good', target: USER_TARGET, mode: 'support' });

    connector.emitUtterance(
      { kind: 'user', id: 42 },
      { speakerId: 42, audio: { pcm: new Uint8Array([1, 2, 3]), sampleRate: 16000 }, endedAt: 111 },
    );

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      botId: 'bot7',
      flowId: 'flow9',
      mode: 'support',
      target: { kind: 'user', id: 42 },
      utterance: { speakerId: 42, endedAt: 111 },
    });
  });
});

describe('CallSessionService — lineup mode (channel/group Q&A queue)', () => {
  it('queues speakers and grants turns sequentially', async () => {
    const { svc, connector } = makeService();
    const cap = svc.capabilityFor('bot1', 'flow1');
    await cap.connect({ credentialId: 'good', target: CHANNEL_TARGET, mode: 'lineup' });

    // Three listeners ask to speak (in order).
    for (const id of [11, 22, 33]) {
      connector.emitUtterance(
        { kind: 'channel', id: -100123 },
        { speakerId: id, audio: { pcm: new Uint8Array([0]), sampleRate: 16000 }, endedAt: id },
      );
    }
    let st = await cap.status({ target: CHANNEL_TARGET });
    expect(st.queue).toEqual([11, 22, 33]);

    const first = await cap.grantTurn({ target: CHANNEL_TARGET });
    expect(first).toBe(11);
    st = await cap.status({ target: CHANNEL_TARGET });
    expect(st.currentTurn).toBe(11);
    expect(st.queue).toEqual([22, 33]);

    await cap.endTurn({ target: CHANNEL_TARGET });
    st = await cap.status({ target: CHANNEL_TARGET });
    expect(st.currentTurn).toBeNull();

    const second = await cap.grantTurn({ target: CHANNEL_TARGET });
    expect(second).toBe(22);
  });

  it('grantTurn returns null when the queue is empty', async () => {
    const { svc } = makeService();
    const cap = svc.capabilityFor('bot1', 'flow1');
    await cap.connect({ credentialId: 'good', target: CHANNEL_TARGET, mode: 'lineup' });
    expect(await cap.grantTurn({ target: CHANNEL_TARGET })).toBeNull();
  });

  it('explicit grantTurn(userId) jumps the line and removes them from the queue', async () => {
    const { svc, connector } = makeService();
    const cap = svc.capabilityFor('bot1', 'flow1');
    await cap.connect({ credentialId: 'good', target: CHANNEL_TARGET, mode: 'lineup' });
    for (const id of [11, 22, 33]) {
      connector.emitUtterance(
        { kind: 'channel', id: -100123 },
        { speakerId: id, audio: { pcm: new Uint8Array([0]), sampleRate: 16000 }, endedAt: id },
      );
    }
    const granted = await cap.grantTurn({ target: CHANNEL_TARGET, userId: 33 });
    expect(granted).toBe(33);
    const st = await cap.status({ target: CHANNEL_TARGET });
    expect(st.currentTurn).toBe(33);
    expect(st.queue).toEqual([11, 22]);
  });

  it('random order grants someone in the queue (not necessarily first)', async () => {
    const { svc, connector } = makeService();
    const cap = svc.capabilityFor('bot1', 'flow1');
    await cap.connect({ credentialId: 'good', target: CHANNEL_TARGET, mode: 'lineup', order: 'random' });
    for (const id of [11, 22, 33]) {
      connector.emitUtterance(
        { kind: 'channel', id: -100123 },
        { speakerId: id, audio: { pcm: new Uint8Array([0]), sampleRate: 16000 }, endedAt: id },
      );
    }
    // Force the pick deterministically: Math.random → 0 selects index 0 here too,
    // but the contract we assert is "returns a queued user and dequeues it".
    const spy = vi.spyOn(Math, 'random').mockReturnValue(0.99);
    try {
      const granted = await cap.grantTurn({ target: CHANNEL_TARGET });
      expect([11, 22, 33]).toContain(granted);
      const st = await cap.status({ target: CHANNEL_TARGET });
      expect(st.queue).toHaveLength(2);
      expect(st.queue).not.toContain(granted);
    } finally {
      spy.mockRestore();
    }
  });

  it('auto-advances a turn after maxTurnSeconds', async () => {
    vi.useFakeTimers();
    try {
      const { svc, connector } = makeService();
      const cap = svc.capabilityFor('bot1', 'flow1');
      await cap.connect({
        credentialId: 'good',
        target: CHANNEL_TARGET,
        mode: 'lineup',
        maxTurnSeconds: 10,
      });
      connector.emitUtterance(
        { kind: 'channel', id: -100123 },
        { speakerId: 11, audio: { pcm: new Uint8Array([0]), sampleRate: 16000 }, endedAt: 1 },
      );
      await cap.grantTurn({ target: CHANNEL_TARGET });
      let st = await cap.status({ target: CHANNEL_TARGET });
      expect(st.currentTurn).toBe(11);
      await vi.advanceTimersByTimeAsync(10_000);
      st = await cap.status({ target: CHANNEL_TARGET });
      expect(st.currentTurn).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('CallSessionService — speak + mute (PE-T2)', () => {
  it('speak forwards raw pcm to the connector', async () => {
    const { svc, connector } = makeService();
    const spy = vi.spyOn(connector, 'speak');
    const cap = svc.capabilityFor('bot1', 'flow1');
    await cap.connect({ credentialId: 'good', target: USER_TARGET, mode: 'support' });
    await cap.speak({ target: USER_TARGET, pcm: { samples: new Uint8Array([9, 8, 7]), sampleRate: 48000 } });
    expect(spy).toHaveBeenCalledWith(
      { kind: 'user', id: 42 },
      { pcm: new Uint8Array([9, 8, 7]), sampleRate: 48000 },
    );
  });

  it('speak({audio}) carries TTS bytes at the default sample rate', async () => {
    const { svc, connector } = makeService();
    const spy = vi.spyOn(connector, 'speak');
    const cap = svc.capabilityFor('bot1', 'flow1');
    await cap.connect({ credentialId: 'good', target: USER_TARGET, mode: 'support' });
    await cap.speak({ target: USER_TARGET, audio: new Uint8Array([1, 2]) });
    expect(spy).toHaveBeenCalledWith({ kind: 'user', id: 42 }, { pcm: new Uint8Array([1, 2]), sampleRate: 16000 });
  });

  it('speak({fileId}) reads the file store', async () => {
    const readFile = vi.fn(async (_id: string) => ({ bytes: new Uint8Array([5, 5]), mime: 'audio/ogg' }));
    const { svc, connector } = makeService({ readFile });
    const spy = vi.spyOn(connector, 'speak');
    const cap = svc.capabilityFor('bot1', 'flow1');
    await cap.connect({ credentialId: 'good', target: USER_TARGET, mode: 'support' });
    await cap.speak({ target: USER_TARGET, fileId: 'file_1' });
    expect(readFile).toHaveBeenCalledWith('file_1');
    expect(spy).toHaveBeenCalledWith({ kind: 'user', id: 42 }, { pcm: new Uint8Array([5, 5]), sampleRate: 16000 });
  });

  it('speak({fileId}) without a file store throws', async () => {
    const { svc } = makeService();
    const cap = svc.capabilityFor('bot1', 'flow1');
    await cap.connect({ credentialId: 'good', target: USER_TARGET, mode: 'support' });
    await expect(cap.speak({ target: USER_TARGET, fileId: 'x' })).rejects.toThrow(/no file store/);
  });

  it('empty speak throws', async () => {
    const { svc } = makeService();
    const cap = svc.capabilityFor('bot1', 'flow1');
    await cap.connect({ credentialId: 'good', target: USER_TARGET, mode: 'support' });
    await expect(cap.speak({ target: USER_TARGET })).rejects.toThrow(/audio, fileId, or pcm/);
  });

  it('operations on a not-connected target throw a clear error', async () => {
    const { svc } = makeService();
    const cap = svc.capabilityFor('bot1', 'flow1');
    await expect(cap.speak({ target: USER_TARGET, audio: new Uint8Array([1]) })).rejects.toThrow(
      /not connected/,
    );
  });

  it('mute marks a participant not-speaking in status', async () => {
    const { svc, connector } = makeService();
    const cap = svc.capabilityFor('bot1', 'flow1');
    await cap.connect({ credentialId: 'good', target: CHANNEL_TARGET, mode: 'lineup' });
    connector.emitUtterance(
      { kind: 'channel', id: -100123 },
      { speakerId: 11, audio: { pcm: new Uint8Array([0]), sampleRate: 16000 }, endedAt: 1 },
    );
    await cap.grantTurn({ target: CHANNEL_TARGET }); // 11 now speaking
    await cap.mute({ target: CHANNEL_TARGET, userId: 11, muted: true });
    const st = await cap.status({ target: CHANNEL_TARGET });
    const p = st.participants.find((x) => x.userId === 11);
    expect(p?.speaking).toBe(false);
  });
});

describe('LoopbackVoiceConnector (PE-T2)', () => {
  it('echoes a speak frame back as an utterance when echo is enabled', async () => {
    vi.useFakeTimers();
    try {
      const connector = new LoopbackVoiceConnector({ echoDelayMs: 20, echoSpeakerId: 7, clock: () => 999 });
      const target = { kind: 'user' as const, id: 1 };
      const conn = resolveVoiceConnection('good', userbotCred());
      await connector.connect(conn, target);
      const heard: unknown[] = [];
      connector.onUtterance(target, (u) => heard.push(u));
      await connector.speak(target, { pcm: new Uint8Array([3, 3]), sampleRate: 16000 });
      await vi.advanceTimersByTimeAsync(20);
      expect(heard).toHaveLength(1);
      expect(heard[0]).toMatchObject({ speakerId: 7, endedAt: 999 });
    } finally {
      vi.useRealTimers();
    }
  });

  it('speak before connect throws; health is always ok', async () => {
    const connector = new LoopbackVoiceConnector();
    await expect(
      connector.speak({ kind: 'user', id: 1 }, { pcm: new Uint8Array(), sampleRate: 16000 }),
    ).rejects.toThrow(/not connected/);
    const conn = resolveVoiceConnection('good', userbotCred());
    expect(await connector.checkHealth(conn)).toMatchObject({ ok: true, kind: 'userbot' });
  });
});
