/**
 * ai.textToSpeech — Text to Speech (NODES.md §AI nodes, PLAN2 PB-T7). Synthesizes
 * speech from text. A plain DATA node (main in/out — NOT a provider).
 *
 * It asks the HOST to synthesize via `ctx.ai.speech` — the host decrypts the
 * openAiApi credential (base_url + key) and POSTs the OpenAI-compatible
 * `/audio/speech` request; the node only ever passes a `credentialId` (invariant
 * I7). The returned audio bytes are STORED via `ctx.files.write`, and the result
 * `{ fileId, mime, size, url }` lands on EVERY output item under
 * `$json.<save_as>` (default `speech`). Feed `fileId` to `tg.sendMedia`
 * (`source:'file'`) to send it as a voice/audio message — `format:'opus'` suits
 * Telegram voice notes; `mp3` is universally playable.
 *
 * Runs ONCE per node run (not per item): a TTS call is expensive execution-
 * external work, and `text` is resolved against the FIRST item by the executor so
 * it reads like `{{ $json.ai.reply }}`. Fails loud (never silent) when the AI
 * service / speech capability is absent, the file store is missing, the provider
 * errors, or it returns empty audio.
 */
import {
  AiTextToSpeechParamsSchema,
  fail,
  out,
  type AiSpeechRequest,
  type AiTextToSpeechParams,
  type FlowItem,
  type NodeDef,
} from '@ctb/shared';

export const aiTextToSpeech: NodeDef<AiTextToSpeechParams> = {
  type: 'ai.textToSpeech',
  category: 'ai',
  meta: {
    labelKey: 'nodes.ai.textToSpeech.label',
    descriptionKey: 'nodes.ai.textToSpeech.desc',
    icon: 'sparkles',
  },
  ports: { inputs: ['main'], outputs: ['main'] },
  paramsSchema: AiTextToSpeechParamsSchema,
  async execute(ctx, params, items) {
    if (!ctx.ai || typeof ctx.ai.speech !== 'function') {
      return fail('ai.textToSpeech: text-to-speech is not available in this context');
    }
    if (!ctx.files) {
      return fail('ai.textToSpeech: file store is not available in this context');
    }

    // 1) Synthesize (host-side; the credential is resolved there — I7).
    const req: AiSpeechRequest = {
      credentialId: params.credentialId,
      model: params.model,
      input: params.text,
      voice: params.voice,
      format: params.format,
      ...(params.speed !== undefined ? { speed: params.speed } : {}),
    };

    let audio: Uint8Array;
    let mime: string;
    try {
      const result = await ctx.ai.speech(req);
      audio = result.audio;
      mime = result.mime;
    } catch (err) {
      return fail(`ai.textToSpeech: ${err instanceof Error ? err.message : String(err)}`);
    }

    if (!audio || audio.byteLength === 0) {
      return fail('ai.textToSpeech: the provider returned empty audio');
    }

    // 2) Store the bytes → a CTB file id `tg.sendMedia` (`source:'file'`) can send.
    let stored: { id: string; mime: string | null; size: number | null; url: string };
    try {
      stored = await ctx.files.write(audio, mime);
    } catch (err) {
      return fail(`ai.textToSpeech: ${err instanceof Error ? err.message : String(err)}`);
    }

    const value = { fileId: stored.id, mime: stored.mime, size: stored.size, url: stored.url };

    // 3) Merge onto every output item under save_as (default `speech`).
    const input: FlowItem[] = items.length > 0 ? items : [{ json: {} }];
    return out({
      main: input.map((item) => {
        const next: FlowItem = { json: { ...item.json, [params.save_as]: value } };
        if (item.binary !== undefined) next.binary = item.binary;
        return next;
      }),
    });
  },
};
