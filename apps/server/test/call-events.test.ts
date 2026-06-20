/**
 * Phase E / PE-T3 — the host Call-event bus (`trigger.callEvent`).
 *
 * The live-voice sibling of the record-write event bus. These tests pin:
 *   - the PURE `matchCallEvent` (target kind + id string-unify + events list);
 *   - `dispatch` fires ONE run per matching active flow via `router.fireCallEvent`
 *     (chatless — a voice flow answers over ctx.call), one entry per flow;
 *   - `utteranceFinal` persists the segmented PCM to a CTB file id ONCE and the
 *     item carries audioFileId/audioMime/audioSampleRate (I6 — node never sees bytes);
 *   - lifecycle events (callJoined / turnOpened / callLeft) build items with
 *     currentTurn/queue and carry `mode` for the flow to branch on;
 *   - non-matching target/event → no fire; a disabled/invalid trigger is skipped;
 *   - `start()`/`stop()` wire to a REAL CallSessionService + LoopbackVoiceConnector
 *     so connect/emitUtterance/grantTurn/leave drive the bus end to end;
 *   - `emit` never throws — a router failure is swallowed (the live call survives).
 */
import type { CredentialData, FlowGraph, FlowItem } from '@ctb/shared';
import { FlowGraphSchema, defaultFlowSettings } from '@ctb/shared';
import { describe, expect, it } from 'vitest';
import { CallEventBus, matchCallEvent, type CallEvent } from '../src/triggers/call-events';
import { LoopbackVoiceConnector } from '../src/engine/loopback-connector';
import { CallSessionService, makeVoiceCredentialResolver } from '../src/triggers/call-session';
import type { SqliteFileStore } from '../src/collections/file-store';
import type { SqliteFlowSource } from '../src/engine/flow-source';
import type { UpdateRouter } from '../src/engine/router';
import type { ResolvedVoiceConnection } from '../src/engine/voice-connector';

// ── fixtures ──────────────────────────────────────────────────────────────────

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

function fixedResolver(): (id: string) => ResolvedVoiceConnection {
  return makeVoiceCredentialResolver((id) => (id === 'good' ? userbotCred() : null));
}

/** A flow with one `trigger.callEvent` node configured for the given target/events. */
function callFlow(
  id: string,
  params: Record<string, unknown>,
  opts?: { disabled?: boolean; nodeType?: string },
): { id: string; name: string; graph: FlowGraph; settings: ReturnType<typeof defaultFlowSettings> } {
  const graph = FlowGraphSchema.parse({
    nodes: [
      {
        id: 'trig',
        type: opts?.nodeType ?? 'trigger.callEvent',
        params,
        position: { x: 0, y: 0 },
        disabled: opts?.disabled ?? false,
      },
    ],
    edges: [],
  });
  return { id, name: id, graph, settings: defaultFlowSettings() };
}

/** A fake flow source that returns a fixed list for the bot. */
function fakeFlowSource(
  flows: ReturnType<typeof callFlow>[],
): { src: SqliteFlowSource; calls: string[] } {
  const calls: string[] = [];
  const src = {
    async activeFlows(botId: string) {
      calls.push(botId);
      return flows;
    },
  } as unknown as SqliteFlowSource;
  return { src, calls };
}

/** A fake router that records every fireCallEvent it gets. */
function fakeRouter(opts?: { throwOnce?: boolean }): {
  router: UpdateRouter;
  fired: Array<{ flowId: string; entryNodeId: string; botId: string; item: FlowItem }>;
} {
  const fired: Array<{ flowId: string; entryNodeId: string; botId: string; item: FlowItem }> = [];
  let didThrow = false;
  const router = {
    async fireCallEvent(input: { flow: { id: string }; entryNodeId: string; botId: string; item: FlowItem }) {
      if (opts?.throwOnce && !didThrow) {
        didThrow = true;
        throw new Error('boom');
      }
      fired.push({
        flowId: input.flow.id,
        entryNodeId: input.entryNodeId,
        botId: input.botId,
        item: input.item,
      });
    },
  } as unknown as UpdateRouter;
  return { router, fired };
}

/** A fake file store that records putLocal and hands back deterministic ids. */
function fakeFileStore(): {
  store: SqliteFileStore;
  puts: Array<{ botId: string; bytes: Buffer; mime: string | null }>;
} {
  const puts: Array<{ botId: string; bytes: Buffer; mime: string | null }> = [];
  let n = 0;
  const store = {
    putLocal(botId: string, bytes: Buffer, mime: string | null) {
      puts.push({ botId, bytes, mime });
      n += 1;
      return { id: `file-${n}`, botId, mime, size: bytes.length } as never;
    },
  } as unknown as SqliteFileStore;
  return { store, puts };
}

function makeBus(opts: {
  flows: ReturnType<typeof callFlow>[];
  service?: CallSessionService;
  routerThrowOnce?: boolean;
}): {
  bus: CallEventBus;
  fired: ReturnType<typeof fakeRouter>['fired'];
  puts: ReturnType<typeof fakeFileStore>['puts'];
  flowCalls: string[];
  service: CallSessionService;
} {
  const { src, calls } = fakeFlowSource(opts.flows);
  const { router, fired } = fakeRouter({ throwOnce: opts.routerThrowOnce ?? false });
  const { store, puts } = fakeFileStore();
  const service =
    opts.service ??
    new CallSessionService({
      connector: new LoopbackVoiceConnector(),
      resolveCredential: fixedResolver(),
    });
  const bus = new CallEventBus({ service, flowSource: src, router, fileStore: store });
  return { bus, fired, puts, flowCalls: calls, service };
}

// ── pure matcher ────────────────────────────────────────────────────────────────

describe('matchCallEvent (pure)', () => {
  const base = {
    connection: 'good',
    targetKind: 'user' as const,
    targetId: '42',
    events: ['utteranceFinal' as const],
    mode: 'support' as const,
    order: 'sequential' as const,
    maxTurnSeconds: 0,
    autoAdvance: false,
  };

  it('matches when target kind + id + event all line up', () => {
    expect(matchCallEvent(base, { target: { kind: 'user', id: '42' }, kind: 'utteranceFinal' })).toBe(
      true,
    );
  });

  it('unifies a numeric id and a string id (123 === "123")', () => {
    expect(
      matchCallEvent({ ...base, targetId: '123' }, { target: { kind: 'user', id: '123' }, kind: 'utteranceFinal' }),
    ).toBe(true);
  });

  it('rejects a different target kind', () => {
    expect(
      matchCallEvent(base, { target: { kind: 'channel', id: '42' }, kind: 'utteranceFinal' }),
    ).toBe(false);
  });

  it('rejects a different target id', () => {
    expect(
      matchCallEvent(base, { target: { kind: 'user', id: '99' }, kind: 'utteranceFinal' }),
    ).toBe(false);
  });

  it('rejects an event kind not in the trigger list', () => {
    expect(matchCallEvent(base, { target: { kind: 'user', id: '42' }, kind: 'callJoined' })).toBe(
      false,
    );
  });

  it('does NOT use mode as a match key (a trigger watches any moderation mode)', () => {
    // The trigger config has no bearing here — only target+events match; mode is
    // carried into the item, not matched on.
    expect(
      matchCallEvent({ ...base, mode: 'lineup' }, { target: { kind: 'user', id: '42' }, kind: 'utteranceFinal' }),
    ).toBe(true);
  });
});

// ── dispatch / emit ──────────────────────────────────────────────────────────────

describe('CallEventBus — dispatch (PE-T3)', () => {
  it('fires one run per matching active flow (chatless) with the built item', async () => {
    const flows = [
      callFlow('f1', { connection: 'good', targetKind: 'user', targetId: '42' }),
      callFlow('f2', { connection: 'good', targetKind: 'user', targetId: '42' }),
    ];
    const { bus, fired } = makeBus({ flows });
    const ev: CallEvent = {
      kind: 'utteranceFinal',
      botId: 'bot1',
      target: { kind: 'user', id: '42' },
      mode: 'support',
      speakerId: 42,
      audio: { pcm: new Uint8Array([1, 2, 3]), sampleRate: 16000 },
    };
    const started = await bus.emit(ev);
    expect(started).toBe(2);
    expect(fired.map((f) => f.flowId)).toEqual(['f1', 'f2']);
    expect(fired[0]!.entryNodeId).toBe('trig');
    expect(fired[0]!.botId).toBe('bot1');
  });

  it('persists utterance audio ONCE and carries audioFileId/mime/sampleRate', async () => {
    const flows = [
      callFlow('f1', { connection: 'good', targetKind: 'user', targetId: '42' }),
      callFlow('f2', { connection: 'good', targetKind: 'user', targetId: '42' }),
    ];
    const { bus, fired, puts } = makeBus({ flows });
    await bus.emit({
      kind: 'utteranceFinal',
      botId: 'bot1',
      target: { kind: 'user', id: '42' },
      mode: 'support',
      speakerId: 7,
      audio: { pcm: new Uint8Array([9, 8, 7]), sampleRate: 16000 },
    });
    // one putLocal even though two flows matched
    expect(puts).toHaveLength(1);
    expect(puts[0]!.mime).toBe('audio/l16');
    expect([...puts[0]!.bytes]).toEqual([9, 8, 7]);
    for (const f of fired) {
      expect(f.item.json).toMatchObject({
        event: 'utteranceFinal',
        target: { kind: 'user', id: '42' },
        mode: 'support',
        speakerId: 7,
        audioFileId: 'file-1',
        audioMime: 'audio/l16',
        audioSampleRate: 16000,
      });
    }
  });

  it('does NOT persist audio for lifecycle events; carries currentTurn/queue', async () => {
    const flows = [
      callFlow('f1', {
        connection: 'good',
        targetKind: 'channel',
        targetId: '-100',
        events: ['turnOpened'],
        mode: 'lineup',
      }),
    ];
    const { bus, fired, puts } = makeBus({ flows });
    await bus.emit({
      kind: 'turnOpened',
      botId: 'bot1',
      target: { kind: 'channel', id: '-100' },
      mode: 'lineup',
      currentTurn: 11,
      queue: [22, 33],
    });
    expect(puts).toHaveLength(0);
    expect(fired).toHaveLength(1);
    expect(fired[0]!.item.json).toMatchObject({
      event: 'turnOpened',
      mode: 'lineup',
      currentTurn: 11,
      queue: [22, 33],
    });
    expect(fired[0]!.item.json).not.toHaveProperty('audioFileId');
  });

  it('does not fire a flow whose target or event does not match', async () => {
    const flows = [
      callFlow('other-target', { connection: 'good', targetKind: 'user', targetId: '99' }),
      callFlow('other-event', {
        connection: 'good',
        targetKind: 'user',
        targetId: '42',
        events: ['callLeft'],
      }),
    ];
    const { bus, fired } = makeBus({ flows });
    const started = await bus.emit({
      kind: 'utteranceFinal',
      botId: 'bot1',
      target: { kind: 'user', id: '42' },
      mode: 'support',
      speakerId: 1,
      audio: { pcm: new Uint8Array([0]), sampleRate: 16000 },
    });
    expect(started).toBe(0);
    expect(fired).toHaveLength(0);
  });

  it('skips a disabled trigger and an invalid-params trigger', async () => {
    const flows = [
      callFlow('disabled', { connection: 'good', targetKind: 'user', targetId: '42' }, { disabled: true }),
      // invalid: empty targetId fails the schema → safeParse drops it
      callFlow('invalid', { connection: 'good', targetKind: 'user', targetId: '' }),
      // a non-call trigger node never matches
      callFlow('not-a-call', { cron: '0 9 * * *' }, { nodeType: 'schedule.trigger' }),
    ];
    const { bus, fired } = makeBus({ flows });
    const started = await bus.emit({
      kind: 'utteranceFinal',
      botId: 'bot1',
      target: { kind: 'user', id: '42' },
      mode: 'support',
      speakerId: 1,
      audio: { pcm: new Uint8Array([0]), sampleRate: 16000 },
    });
    expect(started).toBe(0);
    expect(fired).toHaveLength(0);
  });

  it('emit never throws when the router fails (the live call survives)', async () => {
    const flows = [callFlow('f1', { connection: 'good', targetKind: 'user', targetId: '42' })];
    const { bus, fired } = makeBus({ flows, routerThrowOnce: true });
    const started = await bus.emit({
      kind: 'utteranceFinal',
      botId: 'bot1',
      target: { kind: 'user', id: '42' },
      mode: 'support',
      speakerId: 1,
      audio: { pcm: new Uint8Array([0]), sampleRate: 16000 },
    });
    // the single matching flow threw, so 0 were recorded, but emit resolved
    expect(started).toBe(0);
    expect(fired).toHaveLength(0);
  });
});

// ── start/stop wiring against a real service ─────────────────────────────────────

describe('CallEventBus — start/stop wiring (PE-T3 end-to-end)', () => {
  it('forwards a real inbound utterance to a matching flow', async () => {
    const flows = [callFlow('f1', { connection: 'good', targetKind: 'user', targetId: '42' })];
    const connector = new LoopbackVoiceConnector();
    const service = new CallSessionService({ connector, resolveCredential: fixedResolver() });
    const { bus, fired } = makeBus({ flows, service });
    bus.start();

    const cap = service.capabilityFor('bot1', 'f1');
    await cap.connect({ credentialId: 'good', target: { kind: 'user', id: 42 }, mode: 'support' });
    connector.emitUtterance(
      { kind: 'user', id: 42 },
      { speakerId: 42, audio: { pcm: new Uint8Array([1, 2]), sampleRate: 16000 }, endedAt: 1 },
    );
    // let the async dispatch flush
    await new Promise((r) => setTimeout(r, 0));

    expect(fired).toHaveLength(1);
    expect(fired[0]!.item.json).toMatchObject({ event: 'utteranceFinal', speakerId: 42 });
    bus.stop();
  });

  it('forwards lifecycle events (callJoined / turnOpened) and stop() unsubscribes', async () => {
    const flows = [
      callFlow('f1', {
        connection: 'good',
        targetKind: 'channel',
        targetId: '-100',
        events: ['callJoined', 'turnOpened'],
        mode: 'lineup',
      }),
    ];
    const connector = new LoopbackVoiceConnector();
    const service = new CallSessionService({ connector, resolveCredential: fixedResolver() });
    const { bus, fired } = makeBus({ flows, service });
    bus.start();

    const cap = service.capabilityFor('bot1', 'f1');
    await cap.connect({ credentialId: 'good', target: { kind: 'channel', id: -100 }, mode: 'lineup' });
    // a listener speaks → queued → grant a turn opens it
    connector.emitUtterance(
      { kind: 'channel', id: -100 },
      { speakerId: 11, audio: { pcm: new Uint8Array([0]), sampleRate: 16000 }, endedAt: 1 },
    );
    await cap.grantTurn({ target: { kind: 'channel', id: -100 } });
    await new Promise((r) => setTimeout(r, 0));

    const kinds = fired.map((f) => f.item.json.event);
    expect(kinds).toContain('callJoined');
    expect(kinds).toContain('turnOpened');

    // after stop() no further events flow
    bus.stop();
    const before = fired.length;
    await cap.leave({ target: { kind: 'channel', id: -100 } });
    await new Promise((r) => setTimeout(r, 0));
    expect(fired.length).toBe(before);
  });

  it('start() is idempotent (double-subscribe does not double-fire)', async () => {
    const flows = [callFlow('f1', { connection: 'good', targetKind: 'user', targetId: '42' })];
    const connector = new LoopbackVoiceConnector();
    const service = new CallSessionService({ connector, resolveCredential: fixedResolver() });
    const { bus, fired } = makeBus({ flows, service });
    bus.start();
    bus.start();

    const cap = service.capabilityFor('bot1', 'f1');
    await cap.connect({ credentialId: 'good', target: { kind: 'user', id: 42 }, mode: 'support' });
    connector.emitUtterance(
      { kind: 'user', id: 42 },
      { speakerId: 42, audio: { pcm: new Uint8Array([1]), sampleRate: 16000 }, endedAt: 1 },
    );
    await new Promise((r) => setTimeout(r, 0));
    expect(fired).toHaveLength(1);
    bus.stop();
  });
});
