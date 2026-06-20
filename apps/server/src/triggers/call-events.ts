/**
 * Call-event bus (Phase E / PE-T3) — the host side of the `trigger.callEvent`
 * node. The live-voice sibling of the record-write event bus (`record-events.ts`).
 *
 * The Call Session Service (PE-T2) owns the realtime call and emits two streams:
 *   - inbound utterances (`onUtterance`)  → the `utteranceFinal` event, and
 *   - lifecycle events (`onLifecycle`)    → `callJoined` / `turnOpened` / `callLeft`.
 *
 * This bus subscribes to both, and for each event:
 *   1. scans the bot's ACTIVE flows for `trigger.callEvent` nodes whose `target`
 *      (kind + id) matches the call AND whose `events` list includes this kind,
 *   2. (for `utteranceFinal`) persists the segmented PCM as a CTB file id so the
 *      flow's `ai.speechToText` (PB-T7) can transcribe it — a node never touches
 *      raw audio bytes (invariant I6),
 *   3. starts each matching flow via `router.fireCallEvent` (no implicit chat —
 *      a voice flow answers over `ctx.call`, not a chat message; NODES.md).
 *
 * The matcher half is PURE (`matchCallEvent`) so it unit-tests without a
 * service/store/executor; the bus wires it to the real flow source + router +
 * file store. Never throws — a trigger-dispatch failure must not break the live
 * call or the next event.
 */
import {
  CallEventTriggerParamsSchema,
  type CallEventTriggerParams,
  type FlowItem,
} from '@ctb/shared';
import type { SqliteFileStore } from '../collections/file-store';
import type { SqliteFlowSource } from '../engine/flow-source';
import type { UpdateRouter } from './../engine/router';
import type {
  CallLifecycleEvent,
  CallSessionService,
  TaggedUtterance,
} from './call-session';

const TRIGGER_TYPE = 'trigger.callEvent';

/** The event kinds a `trigger.callEvent` can fire on. */
export type CallEventKind = CallEventTriggerParams['events'][number];

/** A normalized call event the bus dispatches (utterance OR lifecycle). */
export interface CallEvent {
  kind: CallEventKind;
  botId: string;
  /** The call target — `kind` (chat/channel/user) + its id (as a string for compare). */
  target: { kind: 'chat' | 'channel' | 'user'; id: string };
  mode: 'support' | 'lineup';
  /** utteranceFinal: the speaker + the segmented audio. */
  speakerId?: number | string;
  audio?: { pcm: Uint8Array; sampleRate: number };
  /** turnOpened: who holds the mic. */
  currentTurn?: number | string | null;
  /** lineup: the waiting line. */
  queue?: (number | string)[];
}

/**
 * PURE: does a `trigger.callEvent`'s params match this event? Checks the target
 * (kind + id, id compared as a string so `123` and `"123"` unify) and that the
 * trigger's `events` list includes this event kind. Mode is NOT a match key — a
 * trigger watches a call regardless of how the host is moderating it; `mode` is
 * carried into the item for the flow to branch on.
 */
export function matchCallEvent(
  params: CallEventTriggerParams,
  ev: { target: { kind: string; id: string }; kind: CallEventKind },
): boolean {
  if (params.targetKind !== ev.target.kind) return false;
  if (String(params.targetId) !== ev.target.id) return false;
  if (!params.events.includes(ev.kind)) return false;
  return true;
}

export interface CallEventBusDeps {
  service: CallSessionService;
  flowSource: SqliteFlowSource;
  router: UpdateRouter;
  fileStore: SqliteFileStore;
  log?: (level: 'debug' | 'info' | 'warn' | 'error', message: string, data?: unknown) => void;
}

export class CallEventBus {
  private offUtterance: (() => void) | null = null;
  private offLifecycle: (() => void) | null = null;

  constructor(private readonly deps: CallEventBusDeps) {}

  /** Subscribe to the Call Session Service's streams. Idempotent. */
  start(): void {
    if (this.offUtterance || this.offLifecycle) return;
    this.offUtterance = this.deps.service.onUtterance((u) => {
      void this.onUtterance(u);
    });
    this.offLifecycle = this.deps.service.onLifecycle((e) => {
      void this.onLifecycle(e);
    });
  }

  /** Unsubscribe. Idempotent — call at host shutdown / when tearing down. */
  stop(): void {
    this.offUtterance?.();
    this.offLifecycle?.();
    this.offUtterance = null;
    this.offLifecycle = null;
  }

  // ── stream handlers ──────────────────────────────────────────────────────────

  private async onUtterance(u: TaggedUtterance): Promise<void> {
    const event: CallEvent = {
      kind: 'utteranceFinal',
      botId: u.botId,
      target: { kind: u.target.kind, id: String(u.target.id) },
      mode: u.mode,
      speakerId: u.utterance.speakerId,
      audio: { pcm: u.utterance.audio.pcm, sampleRate: u.utterance.audio.sampleRate },
    };
    await this.emit(event);
  }

  private async onLifecycle(e: CallLifecycleEvent): Promise<void> {
    const event: CallEvent = {
      kind: e.kind,
      botId: e.botId,
      target: { kind: e.target.kind, id: String(e.target.id) },
      mode: e.mode,
      ...(e.currentTurn !== undefined ? { currentTurn: e.currentTurn } : {}),
      ...(e.queue !== undefined ? { queue: e.queue } : {}),
    };
    await this.emit(event);
  }

  /**
   * Fire matching `trigger.callEvent` flows for one event. Never throws — a
   * dispatch failure must not break the live call. Returns the number of flows
   * started (for tests).
   */
  async emit(event: CallEvent): Promise<number> {
    try {
      return await this.dispatch(event);
    } catch (err) {
      this.deps.log?.('warn', `callEvent dispatch failed: ${err instanceof Error ? err.message : err}`);
      return 0;
    }
  }

  private async dispatch(event: CallEvent): Promise<number> {
    const flows = await this.deps.flowSource.activeFlows(event.botId);
    // For utteranceFinal we persist the audio ONCE (lazily) the first time a
    // trigger matches, then reuse the file id across every matching flow.
    let audioFileId: string | null = null;

    let started = 0;
    for (const flow of flows) {
      for (const node of flow.graph.nodes) {
        if (node.type !== TRIGGER_TYPE || node.disabled) continue;
        const parsed = CallEventTriggerParamsSchema.safeParse(node.params);
        if (!parsed.success) continue;
        const params = parsed.data;
        if (!matchCallEvent(params, { target: event.target, kind: event.kind })) continue;

        if (event.kind === 'utteranceFinal' && event.audio && audioFileId === null) {
          audioFileId = this.persistAudio(event);
        }
        const item = this.buildItem(event, audioFileId);
        await this.deps.router.fireCallEvent({
          flow,
          entryNodeId: node.id,
          botId: event.botId,
          item,
        });
        started += 1;
        // One entry per flow per event (the first matching trigger node wins).
        break;
      }
    }
    return started;
  }

  /** Store the utterance PCM as a CTB file id so `ai.speechToText` can read it (I6). */
  private persistAudio(event: CallEvent): string | null {
    if (!event.audio) return null;
    try {
      const pub = this.deps.fileStore.putLocal(
        event.botId,
        Buffer.from(event.audio.pcm),
        'audio/l16', // 16-bit linear PCM; the flow knows the sample rate from $json
      );
      return pub.id;
    } catch (err) {
      this.deps.log?.('warn', `callEvent audio persist failed: ${err instanceof Error ? err.message : err}`);
      return null;
    }
  }

  private buildItem(event: CallEvent, audioFileId: string | null): FlowItem {
    const json: Record<string, unknown> = {
      event: event.kind,
      target: { kind: event.target.kind, id: event.target.id },
      mode: event.mode,
    };
    if (event.speakerId !== undefined) json.speakerId = event.speakerId;
    if (audioFileId) {
      json.audioFileId = audioFileId;
      json.audioMime = 'audio/l16';
      if (event.audio) json.audioSampleRate = event.audio.sampleRate;
    }
    if (event.currentTurn !== undefined) json.currentTurn = event.currentTurn;
    if (event.queue !== undefined) json.queue = event.queue;
    return { json };
  }
}
