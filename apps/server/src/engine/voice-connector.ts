/**
 * Voice connector contract + fail-closed resolution (Phase E / PE-T1).
 *
 * Live Telegram calls cannot ride the Bot API — the audio leg always travels
 * over **MTProto via a user session** (PLAN2 §E.0). This module is the seam
 * between the encrypted `voiceConnection` credential (PE-T1) and the host's
 * Call Session Service (PE-T2): it
 *
 *   1. decrypts + validates a `voiceConnection` credential into a normalized
 *      {@link ResolvedVoiceConnection} (fail-closed — an incomplete/wrong-type
 *      credential throws a clear, never-leaking error), and
 *   2. defines the {@link VoiceConnector} adapter interface that PE-T2's media
 *      engine implements behind ONE `ctx.call` capability.
 *
 * Crucially (Phase E §E.1, "one interface, many adapters"): the JS-native vs
 * Python-sidecar media engine is an INTERNAL, swappable choice never exposed to
 * a flow — a flow author only ever references a credential id. The connector
 * `kind` (`userbot` shipped first; `companion`/`external` forward-shaped) is a
 * credential SETTING, so adding a connector is a new adapter + a `kind` value,
 * with zero node/flow change (invariant I2 applied to voice; I3 — the native
 * MTProto/WebRTC dep stays isolated in `apps/server` behind this interface).
 *
 * PE-T1 ships NO audio: only the verified, swappable connector surface and the
 * health-check the panel uses to confirm a session before a call is attempted.
 */
import {
  VoiceConnectionSchema,
  type CredentialData,
  type VoiceConnection,
} from '@ctb/shared';

/** Connector kinds — mirrors the credential `kind` enum (PE-T1). */
export type VoiceConnectorKind = VoiceConnection['kind'];

/**
 * A `voiceConnection` credential decrypted + validated into the shape a
 * connector adapter needs. The secret session/hash live here host-side only
 * (invariants I6/I7) — they never reach node code, which sees a `credentialId`.
 */
export interface ResolvedVoiceConnection {
  credentialId: string;
  kind: VoiceConnectorKind;
  /** MTProto app id (userbot/companion). */
  apiId?: number;
  /** MTProto app hash (userbot/companion). */
  apiHash?: string;
  /** MTProto USER session string (userbot/companion). NEVER logged. */
  session?: string;
  /** External bridge base URL (external kind). */
  bridgeUrl?: string;
  /** External bridge bearer token (external kind). NEVER logged. */
  bridgeToken?: string;
}

/**
 * A live call target — group/channel/user. `target` is a SETTING (PLAN2 §E.2),
 * so the same connector handles a group voice chat AND a 1:1 call. `kind`
 * disambiguates the id space; the connector adapter maps it to MTProto.
 */
export interface CallTarget {
  kind: 'chat' | 'channel' | 'user';
  /** Telegram numeric id (chat/channel/user) the connector dials. */
  id: number | string;
}

/** One PCM audio frame streamed in/out of a live call (16-bit mono by convention). */
export interface PcmFrame {
  /** Raw little-endian 16-bit PCM samples. */
  pcm: Uint8Array;
  /** Sample rate in Hz (e.g. 48000 for WebRTC Opus, 16000 for Whisper). */
  sampleRate: number;
}

/**
 * A finalized utterance the VAD segmented out of the inbound stream — the unit
 * that drives `trigger.callEvent`'s `utteranceFinal` event (PE-T3). The audio is
 * handed off as raw PCM so the flow's `ai.speechToText` (PB-T7) transcribes it.
 */
export interface CallUtterance {
  /** Telegram user id of the speaker. */
  speakerId: number | string;
  /** The segmented PCM (mono). */
  audio: PcmFrame;
  /** Wall-clock ms when the utterance ended. */
  endedAt: number;
}

/** Health probe result — what the panel shows after "test connection" (PE-T1). */
export interface VoiceConnectorHealth {
  ok: boolean;
  /** Connector kind probed. */
  kind: VoiceConnectorKind;
  /** Telegram account display name / username when a login succeeded. */
  account?: string;
  /** Human-readable reason when `ok` is false (never leaks the session). */
  error?: string;
}

/**
 * The single adapter interface every media engine implements (PE-T2). PE-T1
 * only declares it; the userbot adapter (likely a Python `pytgcalls` sidecar,
 * §E.3) lands in PE-T2. `core`/`nodes` never import this — it lives behind the
 * `ctx.call` capability (I3).
 */
export interface VoiceConnector {
  readonly kind: VoiceConnectorKind;
  /** Probe the session/login WITHOUT joining a call (the panel's health check). */
  checkHealth(conn: ResolvedVoiceConnection): Promise<VoiceConnectorHealth>;
  /** Join/start a call to `target`. Resolves once media is flowing. */
  connect(conn: ResolvedVoiceConnection, target: CallTarget): Promise<void>;
  /** Stream PCM out (play TTS / a one-shot clip). */
  speak(target: CallTarget, audio: PcmFrame): Promise<void>;
  /** Subscribe to finalized inbound utterances (VAD-segmented). */
  onUtterance(target: CallTarget, cb: (u: CallUtterance) => void): () => void;
  /** Leave/end the call. */
  leave(target: CallTarget): Promise<void>;
}

/**
 * The error a fail-closed connector resolution throws. A distinct class so the
 * panel/health route can map it to a clean 4xx and callers can branch on it.
 * Its message is safe to surface — it NEVER includes session/hash material.
 */
export class VoiceConnectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VoiceConnectionError';
  }
}

/**
 * Validate + normalize a decrypted credential into a {@link ResolvedVoiceConnection},
 * FAILING CLOSED (PE-T1): a non-`voiceConnection` type, or a `kind` missing its
 * required fields, throws {@link VoiceConnectionError} with a clear, leak-free
 * message rather than returning a half-configured connector that would later
 * fail mid-call. This is the one place that decides "is this connector usable?".
 *
 * Field requirements per kind:
 *  - `userbot` / `companion`: `apiId` + `apiHash` + `session` (MTProto login).
 *  - `external`: `bridgeUrl` (a reachable 3rd-party bridge).
 */
export function resolveVoiceConnection(
  credentialId: string,
  data: CredentialData,
): ResolvedVoiceConnection {
  if (data.type !== 'voiceConnection') {
    throw new VoiceConnectionError(
      `credential "${credentialId}" is not a voice-connection credential`,
    );
  }
  // Re-parse through the schema so defaults (kind) are applied and the shape is
  // trusted even if the row predates a field — the single source of truth (I5).
  const parsed: VoiceConnection = VoiceConnectionSchema.parse(data);
  const { kind } = parsed;

  if (kind === 'userbot' || kind === 'companion') {
    if (parsed.apiId === undefined || parsed.apiId <= 0) {
      throw new VoiceConnectionError(
        `voice connection "${credentialId}" (${kind}) is missing api_id`,
      );
    }
    if (!parsed.apiHash) {
      throw new VoiceConnectionError(
        `voice connection "${credentialId}" (${kind}) is missing api_hash`,
      );
    }
    if (!parsed.session) {
      throw new VoiceConnectionError(
        `voice connection "${credentialId}" (${kind}) is missing its session string`,
      );
    }
    const resolved: ResolvedVoiceConnection = {
      credentialId,
      kind,
      apiId: parsed.apiId,
      apiHash: parsed.apiHash,
      session: parsed.session,
    };
    return resolved;
  }

  // external
  if (!parsed.bridgeUrl) {
    throw new VoiceConnectionError(
      `voice connection "${credentialId}" (external) is missing a bridge URL`,
    );
  }
  const resolved: ResolvedVoiceConnection = {
    credentialId,
    kind,
    bridgeUrl: parsed.bridgeUrl,
  };
  if (parsed.bridgeToken) resolved.bridgeToken = parsed.bridgeToken;
  return resolved;
}

/**
 * The panel's "test connection" path (PE-T1). It resolves the credential
 * fail-closed and, when an adapter for the connector kind is wired, probes the
 * session via {@link VoiceConnector.checkHealth}; otherwise it reports the
 * credential as STRUCTURALLY valid but with no live login yet (honest — PE-T1
 * ships no media engine; the real probe arrives with PE-T2's adapter). Either
 * way the result is leak-free: a thrown {@link VoiceConnectionError} becomes
 * `{ok:false, error}`, never an exception that could carry secret material.
 *
 * @param connector  optional adapter for this kind (wired in PE-T2). When
 *                   absent, health is "config valid, login not yet attempted".
 */
export async function validateVoiceConnection(
  credentialId: string,
  data: CredentialData,
  connector?: VoiceConnector,
): Promise<VoiceConnectorHealth> {
  let resolved: ResolvedVoiceConnection;
  try {
    resolved = resolveVoiceConnection(credentialId, data);
  } catch (err) {
    const kind =
      data.type === 'voiceConnection' ? data.kind : ('userbot' as VoiceConnectorKind);
    return {
      ok: false,
      kind,
      error: err instanceof Error ? err.message : 'invalid voice connection',
    };
  }

  if (!connector) {
    // PE-T1: no media engine yet. The credential is well-formed and ready for a
    // PE-T2 adapter — report that honestly rather than claiming a live login.
    return {
      ok: true,
      kind: resolved.kind,
      error: 'connector adapter not wired yet (PE-T2) — credential is valid',
    };
  }
  try {
    return await connector.checkHealth(resolved);
  } catch (err) {
    return {
      ok: false,
      kind: resolved.kind,
      error: err instanceof Error ? err.message : 'health check failed',
    };
  }
}
