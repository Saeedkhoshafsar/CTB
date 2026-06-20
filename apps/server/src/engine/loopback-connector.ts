/**
 * Loopback voice connector (Phase E / PE-T2) — the DEFAULT, dependency-free
 * media adapter behind the Call Session Service.
 *
 * Phase E ships "one interface, many adapters" (PLAN2 §E.1): the real userbot
 * adapter (a `pytgcalls`/`ntgcalls` engine over MTProto) is a native dependency
 * that MUST stay isolated in `apps/server` behind {@link VoiceConnector} so
 * `core`/`nodes` never import it (invariant I3). This loopback adapter is the
 * other end of that seam — a pure in-memory connector that:
 *
 *   - "joins" a call by simply marking the target connected (no socket),
 *   - echoes every `speak` PCM frame back out as an inbound utterance after a
 *     short, configurable delay (so a flow's "speak → hear my own audio" path
 *     and the VAD/utterance plumbing can be exercised end to end), and
 *   - lets a TEST drive arbitrary inbound utterances via {@link emitUtterance}.
 *
 * It carries NO secrets and opens NO connections, so it is the safe default the
 * host wires when no native engine is installed — the Call Session Service is
 * fully testable without MTProto, and swapping in the userbot adapter is a
 * one-line change at the composition root (zero node/flow change — I2/I3).
 */
import type {
  CallTarget,
  CallUtterance,
  PcmFrame,
  ResolvedVoiceConnection,
  VoiceConnector,
  VoiceConnectorHealth,
  VoiceConnectorKind,
} from './voice-connector';

/** A stable string key for a {@link CallTarget} (kind + id). */
export function targetKey(t: CallTarget): string {
  return `${t.kind}:${t.id}`;
}

export interface LoopbackConnectorOptions {
  /**
   * ms to wait before echoing a `speak` frame back as an inbound utterance
   * (simulates network + the remote speaking). 0 disables the echo entirely —
   * the connector then only emits utterances a test injects. Default: 0
   * (off — most tests drive utterances explicitly and don't want echo noise).
   */
  echoDelayMs?: number;
  /** The synthetic speaker id used for echoed utterances. Default: 0 (the "self" leg). */
  echoSpeakerId?: number | string;
  /** Test seam — wall clock for `endedAt`. Default: Date.now. */
  clock?: () => number;
}

/** One joined target's loopback state. */
interface LoopbackCall {
  target: CallTarget;
  /** Utterance subscribers (the Call Session Service's VAD sink). */
  listeners: Set<(u: CallUtterance) => void>;
  /** Echo timers in flight, so `leave` can cancel them (no post-leave emits). */
  timers: Set<ReturnType<typeof setTimeout>>;
}

/**
 * The default in-memory {@link VoiceConnector}. Reports healthy for any resolved
 * credential (it never logs in), tracks joined targets, and fans `speak` audio
 * back to utterance listeners. Deterministic and side-effect-free — ideal for
 * the Call Session Service's tests and for a host without a native voice engine.
 */
export class LoopbackVoiceConnector implements VoiceConnector {
  readonly kind: VoiceConnectorKind = 'userbot';
  private readonly calls = new Map<string, LoopbackCall>();
  private readonly echoDelayMs: number;
  private readonly echoSpeakerId: number | string;
  private readonly clock: () => number;

  constructor(opts: LoopbackConnectorOptions = {}) {
    this.echoDelayMs = opts.echoDelayMs ?? 0;
    this.echoSpeakerId = opts.echoSpeakerId ?? 0;
    this.clock = opts.clock ?? (() => Date.now());
  }

  // ── VoiceConnector ─────────────────────────────────────────────────────────

  async checkHealth(_conn: ResolvedVoiceConnection): Promise<VoiceConnectorHealth> {
    // The loopback never logs in — it's structurally healthy for any credential.
    return { ok: true, kind: this.kind, account: 'loopback' };
  }

  async connect(_conn: ResolvedVoiceConnection, target: CallTarget): Promise<void> {
    const key = targetKey(target);
    if (this.calls.has(key)) return; // idempotent join
    this.calls.set(key, { target, listeners: new Set(), timers: new Set() });
  }

  async speak(target: CallTarget, audio: PcmFrame): Promise<void> {
    const call = this.require(target);
    if (this.echoDelayMs <= 0) return; // echo disabled
    const timer = setTimeout(() => {
      call.timers.delete(timer);
      // Re-check the call is still live (leave may have raced the timer).
      if (!this.calls.has(targetKey(target))) return;
      this.fan(call, {
        speakerId: this.echoSpeakerId,
        audio,
        endedAt: this.clock(),
      });
    }, this.echoDelayMs);
    // Don't keep the event loop alive for an echo (host is long-lived anyway).
    if (typeof timer === 'object' && 'unref' in timer) timer.unref();
    call.timers.add(timer);
  }

  onUtterance(target: CallTarget, cb: (u: CallUtterance) => void): () => void {
    const call = this.require(target);
    call.listeners.add(cb);
    return () => call.listeners.delete(cb);
  }

  async leave(target: CallTarget): Promise<void> {
    const key = targetKey(target);
    const call = this.calls.get(key);
    if (!call) return; // idempotent leave
    for (const t of call.timers) clearTimeout(t);
    call.timers.clear();
    call.listeners.clear();
    this.calls.delete(key);
  }

  // ── test / introspection helpers ─────────────────────────────────────────────

  /** True once `connect(target)` has joined and before `leave(target)`. */
  isConnected(target: CallTarget): boolean {
    return this.calls.has(targetKey(target));
  }

  /** Number of currently-joined targets (tests). */
  get callCount(): number {
    return this.calls.size;
  }

  /**
   * Inject a finalized inbound utterance for a joined target — the seam tests
   * use to simulate a listener speaking (drives the Call Session Service's VAD
   * sink → `trigger.callEvent` utteranceFinal in PE-T3). Throws if not joined.
   */
  emitUtterance(target: CallTarget, u: Omit<CallUtterance, 'endedAt'> & { endedAt?: number }): void {
    const call = this.require(target);
    this.fan(call, { ...u, endedAt: u.endedAt ?? this.clock() });
  }

  // ── internals ────────────────────────────────────────────────────────────────

  private fan(call: LoopbackCall, u: CallUtterance): void {
    // Snapshot so a listener that unsubscribes mid-fan doesn't break iteration.
    for (const cb of [...call.listeners]) {
      try {
        cb(u);
      } catch {
        // A bad subscriber must not break the connector or other listeners.
      }
    }
  }

  private require(target: CallTarget): LoopbackCall {
    const call = this.calls.get(targetKey(target));
    if (!call) {
      throw new Error(`loopback connector: not connected to ${targetKey(target)}`);
    }
    return call;
  }
}
