/**
 * Call Session Service — the host side of Phase E live voice (PE-T2, PLAN2 §E.1).
 *
 * This is the long-lived runtime that owns every realtime Telegram call, a
 * SIBLING to the Scheduler (both are host services that drive flows but live
 * outside `core`). Flows stay stateless and event-driven: a node never holds a
 * media socket (invariant I4) — it calls ONE typed capability (`ctx.call`,
 * {@link CallCapability}) and this service holds the connection, the inbound
 * audio sink, and the turn state for the call's whole lifetime.
 *
 * "Behaviour = config" (PLAN2 §E.1): the SAME service serves BOTH user voice
 * scenarios with NO new node types —
 *   - a CHANNEL/GROUP live broadcast with a Q&A line-up (`mode:'lineup'`,
 *     `order` sequential/random — listeners queue for the mic, the flow grants
 *     turns one at a time), and
 *   - a 1:1 Direct → voice call an AI answers in real time (`mode:'support'`,
 *     `target.kind:'user'` — everyone may speak, the flow replies to each).
 * `target` and `mode` are SETTINGS, not forks.
 *
 * "One interface, many adapters" (§E.1): the realtime media engine is a pluggable
 * {@link VoiceConnector} chosen ONLY by the referenced `voiceConnection`
 * credential, never by node type. The native MTProto/WebRTC dependency stays
 * isolated behind that interface in `apps/server`, so `core`/`nodes` never import
 * it (invariant I3). The default {@link LoopbackVoiceConnector} carries no native
 * dep, so the whole service is testable and a host runs without MTProto installed.
 *
 * HARD CAPS are config with safe defaults (§E.1): max concurrent calls, max call
 * duration, and a per-bot concurrent-call budget. Exceeding a cap fails the
 * `connect` loudly (a node surfaces it) rather than silently overloading the host.
 */
import type {
  CallCapability,
  CallMode,
  CallParticipant,
  CallSpeakRequest,
  CallStatus,
  CallTargetRef,
  CallTurnOrder,
  CredentialData,
  NodeCtx,
} from '@ctb/shared';
import {
  resolveVoiceConnection,
  VoiceConnectionError,
  type CallTarget,
  type CallUtterance,
  type PcmFrame,
  type ResolvedVoiceConnection,
  type VoiceConnector,
} from '../engine/voice-connector';

/** Hard caps for live calls (PLAN2 §E.1) — all `number` so a host can tune them. */
export interface CallCaps {
  /** Max concurrent live calls across the whole host. */
  maxConcurrentCalls: number;
  /** Max concurrent live calls for any single bot. */
  maxCallsPerBot: number;
  /** Max wall-clock seconds a single call may stay connected (0 = no cap). */
  maxCallSeconds: number;
}

/** Safe default hard caps (PLAN2 §E.1). Override per host via {@link CallSessionDeps.caps}. */
export const DEFAULT_CALL_CAPS: CallCaps = {
  maxConcurrentCalls: 25,
  maxCallsPerBot: 5,
  maxCallSeconds: 60 * 60,
};

/** PCM the connector plays/echoes; the loopback default uses 16 kHz mono by convention. */
const DEFAULT_SPEAK_SAMPLE_RATE = 16_000;

export interface CallSessionDeps {
  /** The media adapter (loopback default; userbot MTProto engine later). */
  connector: VoiceConnector;
  /**
   * Resolve a `voiceConnection` credential id to its decrypted, validated form
   * (fail-closed). Injected so this service never touches the DB/crypto itself —
   * the composition root (wire.ts) owns the key (invariants I3/I6/I7).
   */
  resolveCredential: (credentialId: string) => ResolvedVoiceConnection;
  /** Read a CTB file id to raw bytes (+ mime) so `speak({fileId})` can play a stored file. */
  readFile?: (fileId: string) => Promise<{ bytes: Uint8Array; mime: string | null }>;
  /** Hard caps (safe defaults applied per-field when omitted). */
  caps?: Partial<CallCaps>;
  log?: (level: 'debug' | 'info' | 'warn' | 'error', message: string, data?: unknown) => void;
  /** Test seam — wall clock. */
  clock?: () => number;
}

/** A finalized utterance, tagged with the call it came from (for PE-T3's trigger). */
export interface TaggedUtterance {
  botId: string;
  flowId: string;
  target: CallTargetRef;
  mode: CallMode;
  utterance: CallUtterance;
}

/** The non-utterance call events PE-T3's `trigger.callEvent` fires on. */
export type CallLifecycleKind = 'callJoined' | 'turnOpened' | 'callLeft';

/** A lifecycle event tagged with the call it came from (for PE-T3's trigger). */
export interface CallLifecycleEvent {
  kind: CallLifecycleKind;
  botId: string;
  flowId: string;
  target: CallTargetRef;
  mode: CallMode;
  /** turnOpened: the user just granted the mic. */
  currentTurn?: number | string | null;
  /** lineup: the waiting line at the moment of the event. */
  queue?: (number | string)[];
}

/** One live call the service is holding. */
interface CallSession {
  botId: string;
  flowId: string;
  target: CallTarget;
  mode: CallMode;
  order: CallTurnOrder;
  maxTurnSeconds: number;
  connectedAt: number;
  /** Participants the service has seen speak (lineup queue is built from these). */
  participants: Map<number | string, CallParticipant>;
  /** lineup waiting line, in order. */
  queue: (number | string)[];
  /** lineup: who currently holds the mic (null = nobody). */
  currentTurn: number | string | null;
  /** Unsubscribe from the connector's utterance stream. */
  offUtterance: () => void;
  /** Auto-leave timer when `maxCallSeconds` is set. */
  durationTimer?: ReturnType<typeof setTimeout>;
  /** Auto-advance timer when a turn has `maxTurnSeconds`. */
  turnTimer?: ReturnType<typeof setTimeout>;
}

/** Map the node-facing {@link CallTargetRef} to the connector's {@link CallTarget}. */
function toConnectorTarget(t: CallTargetRef): CallTarget {
  return { kind: t.kind, id: t.id };
}

/** Stable per-target session key (bot + target). Same target across bots = distinct calls. */
function sessionKey(botId: string, t: CallTargetRef): string {
  return `${botId}\u0000${t.kind}:${t.id}`;
}

export class CallSessionService {
  private readonly sessions = new Map<string, CallSession>();
  private readonly caps: CallCaps;
  private readonly clock: () => number;
  /** Listeners for finalized utterances (PE-T3's `trigger.callEvent` subscribes here). */
  private readonly utteranceListeners = new Set<(u: TaggedUtterance) => void>();
  /** Listeners for non-utterance call events — callJoined/turnOpened/callLeft (PE-T3). */
  private readonly lifecycleListeners = new Set<(e: CallLifecycleEvent) => void>();

  constructor(private readonly deps: CallSessionDeps) {
    this.caps = { ...DEFAULT_CALL_CAPS, ...deps.caps };
    this.clock = deps.clock ?? (() => Date.now());
  }

  /** Stop every live call and clear state. Idempotent — call at host shutdown. */
  stop(): void {
    for (const s of this.sessions.values()) {
      this.teardown(s);
      void this.deps.connector.leave(s.target).catch(() => {});
    }
    this.sessions.clear();
  }

  /** Number of live calls across the host (tests / introspection / caps). */
  get callCount(): number {
    return this.sessions.size;
  }

  /** Live calls for one bot (per-bot cap check). */
  callsForBot(botId: string): number {
    let n = 0;
    for (const s of this.sessions.values()) if (s.botId === botId) n += 1;
    return n;
  }

  /**
   * Subscribe to finalized inbound utterances across all calls — the seam
   * PE-T3's `trigger.callEvent` uses to start a flow per utterance. Returns an
   * unsubscribe fn.
   */
  onUtterance(cb: (u: TaggedUtterance) => void): () => void {
    this.utteranceListeners.add(cb);
    return () => this.utteranceListeners.delete(cb);
  }

  /**
   * Subscribe to the non-utterance call events — `callJoined` / `turnOpened` /
   * `callLeft` — across all calls. The PE-T3 CallEventBus uses this to start a
   * flow on those events. Returns an unsubscribe fn.
   */
  onLifecycle(cb: (e: CallLifecycleEvent) => void): () => void {
    this.lifecycleListeners.add(cb);
    return () => this.lifecycleListeners.delete(cb);
  }

  /**
   * Build the per-run `ctx.call` capability bound to a bot+flow. The executor
   * factory (wire.ts) calls this; every method below proxies to the live session
   * for the requested target. A run can connect/speak/grant across targets it
   * names — the service enforces caps + holds the durable state (invariant I4).
   */
  capabilityFor(botId: string, flowId: string): NonNullable<NodeCtx['call']> {
    const self = this;
    const cap: CallCapability = {
      async connect(req) {
        await self.connect(botId, flowId, req);
      },
      async speak(req) {
        await self.speak(botId, req);
      },
      async grantTurn(req) {
        return self.grantTurn(botId, req);
      },
      async endTurn(req) {
        self.endTurn(botId, req.target);
      },
      async mute(req) {
        await self.mute(botId, req);
      },
      async leave(req) {
        await self.leave(botId, req.target);
      },
      async status(req) {
        return self.status(botId, req.target);
      },
    };
    return cap;
  }

  // ── operations ───────────────────────────────────────────────────────────────

  private async connect(
    botId: string,
    flowId: string,
    req: {
      credentialId: string;
      target: CallTargetRef;
      mode: CallMode;
      order?: CallTurnOrder;
      maxTurnSeconds?: number;
    },
  ): Promise<void> {
    const key = sessionKey(botId, req.target);
    if (this.sessions.has(key)) return; // idempotent — already in this call

    // Caps are checked BEFORE we resolve the credential or dial, so an
    // over-budget host fails fast without touching secrets or the network.
    if (this.sessions.size >= this.caps.maxConcurrentCalls) {
      throw new VoiceConnectionError(
        `host call limit reached (${this.caps.maxConcurrentCalls} concurrent calls)`,
      );
    }
    if (this.callsForBot(botId) >= this.caps.maxCallsPerBot) {
      throw new VoiceConnectionError(
        `bot call limit reached (${this.caps.maxCallsPerBot} concurrent calls per bot)`,
      );
    }

    const conn = this.deps.resolveCredential(req.credentialId); // fail-closed
    const target = toConnectorTarget(req.target);
    await this.deps.connector.connect(conn, target);

    const session: CallSession = {
      botId,
      flowId,
      target,
      mode: req.mode,
      order: req.order ?? 'sequential',
      maxTurnSeconds: Math.max(0, req.maxTurnSeconds ?? 0),
      connectedAt: this.clock(),
      participants: new Map(),
      queue: [],
      currentTurn: null,
      offUtterance: () => {},
    };

    // Wire the inbound utterance sink: track the speaker, enqueue them for a
    // turn in lineup mode, and fan the tagged utterance to PE-T3 subscribers.
    session.offUtterance = this.deps.connector.onUtterance(target, (u) => {
      this.onConnectorUtterance(session, u);
    });

    // Hard duration cap → auto-leave (a runaway call can't pin the host forever).
    if (this.caps.maxCallSeconds > 0) {
      const timer = setTimeout(() => {
        this.log('warn', `call ${key} hit max duration (${this.caps.maxCallSeconds}s) — leaving`);
        void this.leave(botId, req.target).catch(() => {});
      }, this.caps.maxCallSeconds * 1000);
      if (typeof timer === 'object' && 'unref' in timer) timer.unref();
      session.durationTimer = timer;
    }

    this.sessions.set(key, session);
    this.log('info', `call connected ${key} mode=${req.mode}${req.mode === 'lineup' ? ` order=${session.order}` : ''}`);
    this.emitLifecycle(session, 'callJoined');
  }

  private async speak(botId: string, req: CallSpeakRequest): Promise<void> {
    const session = this.require(botId, req.target);
    const frame = await this.toPcm(req);
    await this.deps.connector.speak(session.target, frame);
  }

  private async grantTurn(
    botId: string,
    req: { target: CallTargetRef; userId?: number | string },
  ): Promise<number | string | null> {
    const session = this.require(botId, req.target);
    if (session.mode !== 'lineup') {
      // support mode has no queue — everyone may already speak; nothing to grant.
      return null;
    }
    // Close any open turn first (grant implies advance).
    this.clearTurnTimer(session);

    let next: number | string | null = null;
    if (req.userId !== undefined) {
      // Explicit grant — pull them out of the queue if present. Compare by string
      // so a numeric queue entry and a string `userId` (e.g. coerced from a
      // `{{ $json.speakerId }}` expression) unify, like matchCallEvent does.
      next = req.userId;
      const wanted = String(req.userId);
      session.queue = session.queue.filter((u) => String(u) !== wanted);
    } else if (session.queue.length > 0) {
      if (session.order === 'random') {
        const i = Math.floor(Math.random() * session.queue.length);
        next = session.queue.splice(i, 1)[0] ?? null;
      } else {
        next = session.queue.shift() ?? null;
      }
    }

    session.currentTurn = next;
    if (next !== null) {
      // Open the mic: mark the granted speaker as holding it (others stay muted
      // in lineup). The connector-level (un)mute lands with the userbot adapter.
      this.markSpeaking(session, next, true);
      this.emitLifecycle(session, 'turnOpened');
      // Auto-advance after maxTurnSeconds (0 = host holds it open until endTurn).
      if (session.maxTurnSeconds > 0) {
        const timer = setTimeout(() => {
          this.log('info', `turn auto-advanced (${session.maxTurnSeconds}s) on ${sessionKey(botId, req.target)}`);
          this.endTurn(botId, req.target);
        }, session.maxTurnSeconds * 1000);
        if (typeof timer === 'object' && 'unref' in timer) timer.unref();
        session.turnTimer = timer;
      }
    }
    return next;
  }

  private endTurn(botId: string, target: CallTargetRef): void {
    const session = this.require(botId, target);
    this.clearTurnTimer(session);
    if (session.currentTurn !== null) {
      this.markSpeaking(session, session.currentTurn, false);
      session.currentTurn = null;
    }
  }

  private async mute(
    botId: string,
    req: { target: CallTargetRef; userId: number | string; muted: boolean },
  ): Promise<void> {
    const session = this.require(botId, req.target);
    this.markSpeaking(session, req.userId, !req.muted);
  }

  private async leave(botId: string, target: CallTargetRef): Promise<void> {
    const key = sessionKey(botId, target);
    const session = this.sessions.get(key);
    if (!session) return; // idempotent
    this.teardown(session);
    this.sessions.delete(key);
    await this.deps.connector.leave(session.target);
    this.log('info', `call left ${key}`);
    // Fire AFTER teardown/delete so a listener sees the call already gone.
    this.emitLifecycle(session, 'callLeft');
  }

  private status(botId: string, target: CallTargetRef): CallStatus {
    const key = sessionKey(botId, target);
    const session = this.sessions.get(key);
    if (!session) {
      return { connected: false, mode: 'support', participants: [], currentTurn: null, queue: [] };
    }
    return {
      connected: true,
      mode: session.mode,
      participants: [...session.participants.values()],
      currentTurn: session.currentTurn,
      queue: [...session.queue],
    };
  }

  // ── internals ────────────────────────────────────────────────────────────────

  /** Inbound utterance from the connector: track speaker, enqueue (lineup), fan out. */
  private onConnectorUtterance(session: CallSession, u: CallUtterance): void {
    const speaker = u.speakerId;
    if (!session.participants.has(speaker)) {
      session.participants.set(speaker, { userId: speaker, speaking: false });
    }
    // In lineup mode a fresh speaker who doesn't hold the mic queues for a turn.
    if (
      session.mode === 'lineup' &&
      session.currentTurn !== speaker &&
      !session.queue.includes(speaker)
    ) {
      session.queue.push(speaker);
    }
    const tagged: TaggedUtterance = {
      botId: session.botId,
      flowId: session.flowId,
      target: { kind: session.target.kind, id: session.target.id },
      mode: session.mode,
      utterance: u,
    };
    for (const cb of [...this.utteranceListeners]) {
      try {
        cb(tagged);
      } catch (err) {
        this.log('error', `call utterance listener failed: ${err instanceof Error ? err.message : err}`);
      }
    }
  }

  /** Fan a non-utterance call event to the lifecycle subscribers (PE-T3). */
  private emitLifecycle(session: CallSession, kind: CallLifecycleKind): void {
    const event: CallLifecycleEvent = {
      kind,
      botId: session.botId,
      flowId: session.flowId,
      target: { kind: session.target.kind, id: session.target.id },
      mode: session.mode,
      currentTurn: session.currentTurn,
      queue: [...session.queue],
    };
    for (const cb of [...this.lifecycleListeners]) {
      try {
        cb(event);
      } catch (err) {
        this.log('error', `call lifecycle listener failed: ${err instanceof Error ? err.message : err}`);
      }
    }
  }

  /** Decode a {@link CallSpeakRequest} to a single PCM frame for the connector. */
  private async toPcm(req: CallSpeakRequest): Promise<PcmFrame> {
    if (req.pcm) {
      return { pcm: req.pcm.samples, sampleRate: req.pcm.sampleRate };
    }
    if (req.audio) {
      // The connector decodes container bytes → PCM; the loopback just carries them.
      return { pcm: req.audio, sampleRate: DEFAULT_SPEAK_SAMPLE_RATE };
    }
    if (req.fileId) {
      if (!this.deps.readFile) {
        throw new VoiceConnectionError('cannot play fileId: no file store wired into the call service');
      }
      const { bytes } = await this.deps.readFile(req.fileId);
      return { pcm: bytes, sampleRate: DEFAULT_SPEAK_SAMPLE_RATE };
    }
    throw new VoiceConnectionError('speak requires one of audio, fileId, or pcm');
  }

  private markSpeaking(session: CallSession, userId: number | string, speaking: boolean): void {
    const p = session.participants.get(userId);
    if (p) p.speaking = speaking;
    else session.participants.set(userId, { userId, speaking });
  }

  private clearTurnTimer(session: CallSession): void {
    if (session.turnTimer) {
      clearTimeout(session.turnTimer);
      delete session.turnTimer;
    }
  }

  /** Cancel timers + detach the utterance sink (no callbacks after teardown). */
  private teardown(session: CallSession): void {
    this.clearTurnTimer(session);
    if (session.durationTimer) {
      clearTimeout(session.durationTimer);
      delete session.durationTimer;
    }
    try {
      session.offUtterance();
    } catch {
      /* ignore */
    }
  }

  private require(botId: string, target: CallTargetRef): CallSession {
    const session = this.sessions.get(sessionKey(botId, target));
    if (!session) {
      throw new VoiceConnectionError(`not connected to ${target.kind}:${target.id} — call connect first`);
    }
    return session;
  }

  private log(level: 'debug' | 'info' | 'warn' | 'error', message: string, data?: unknown): void {
    this.deps.log?.(level, message, data);
  }
}

/**
 * Build the credential resolver the service needs from a raw decrypt fn — keeps
 * the DB/crypto in wire.ts and the fail-closed validation in voice-connector.ts.
 * The decrypted secret stays host-side (invariants I6/I7).
 */
export function makeVoiceCredentialResolver(
  decryptCredential: (credentialId: string) => CredentialData | null,
): (credentialId: string) => ResolvedVoiceConnection {
  return (credentialId) => {
    const data = decryptCredential(credentialId);
    if (!data) {
      throw new VoiceConnectionError(`voice credential "${credentialId}" not found or undecryptable`);
    }
    return resolveVoiceConnection(credentialId, data);
  };
}
