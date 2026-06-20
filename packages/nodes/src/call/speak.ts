/**
 * call.speak — play audio into a live call (NODES.md §Live voice, PE-T4).
 *
 * The AI's voice "reply": it plays audio into the call via `ctx.call.speak`. The
 * `source` setting picks where the audio comes from:
 *   - `file` — a CTB file id (e.g. `ai.textToSpeech` output `{{ $json.speech.fileId }}`);
 *              the HOST reads the bytes from the file store (the node never touches
 *              raw audio — invariant I6).
 *   - `pcm`  — a base64 16-bit-mono PCM blob + its sample rate (advanced).
 *
 * Runs ONCE per node run (the call is shared state). Fails loud when no Call
 * Session Service is wired (`ctx.call === null`, I6), the chosen source is empty,
 * or the connector errors.
 */
import {
  CallSpeakParamsSchema,
  fail,
  out,
  type CallSpeakParams,
  type CallSpeakRequest,
  type NodeDef,
} from '@ctb/shared';

export const callSpeak: NodeDef<CallSpeakParams> = {
  type: 'call.speak',
  category: 'flow',
  meta: {
    labelKey: 'nodes.call.speak.label',
    descriptionKey: 'nodeDesc.call.speak',
    icon: 'megaphone',
  },
  ports: { inputs: ['main'], outputs: ['main'] },
  paramsSchema: CallSpeakParamsSchema,
  async execute(ctx, params, items) {
    if (!ctx.call) {
      return fail('call.speak: live-voice is not available in this context (no Call Session Service)');
    }

    const req: CallSpeakRequest = { target: { kind: params.targetKind, id: params.targetId } };
    if (params.source === 'file') {
      if (!params.fileId) return fail('call.speak: source is "file" but no fileId was given');
      req.fileId = params.fileId;
    } else {
      if (!params.pcmBase64) return fail('call.speak: source is "pcm" but no pcmBase64 was given');
      let samples: Uint8Array;
      try {
        samples = Uint8Array.from(Buffer.from(params.pcmBase64, 'base64'));
      } catch {
        return fail('call.speak: pcmBase64 is not valid base64');
      }
      if (samples.byteLength === 0) return fail('call.speak: pcmBase64 decoded to empty audio');
      req.pcm = { samples, sampleRate: params.pcmSampleRate };
    }

    try {
      await ctx.call.speak(req);
    } catch (err) {
      return fail(`call.speak: ${err instanceof Error ? err.message : String(err)}`);
    }
    return out({ main: items.length > 0 ? items : [{ json: {} }] });
  },
};
