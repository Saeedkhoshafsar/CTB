/**
 * ai.speechToText — Speech to Text (NODES.md §AI nodes, PLAN2 PB-T7). Transcribes
 * a voice/audio file to text. A plain DATA node (main in/out — NOT a provider).
 *
 * It first LOCATES the audio bytes:
 *   - source `telegram` (default): `audio_source` is a Telegram `file_id` (a
 *     voice/audio/document the user sent, e.g. `{{ $json.message.voice.file_id }}`)
 *     that the host downloads via `ctx.tg.getFile` — the node never touches the
 *     bot token or the network (invariants I3/I6).
 *   - source `file`: `audio_source` is a CTB file id read via `ctx.files.read`.
 *
 * It then asks the HOST to transcribe via `ctx.ai.transcribe` — the host
 * decrypts the openAiApi credential (base_url + key) and POSTs the OpenAI-
 * compatible `/audio/transcriptions` request; the node only ever passes a
 * `credentialId` (invariant I7). The result `{ text, language?, duration? }`
 * lands on EVERY output item under `$json.<save_as>` (default `transcript`).
 *
 * Runs ONCE per node run (not per item): a transcription is expensive execution-
 * external work, and `audio_source` is resolved against the FIRST item by the
 * executor so it reads like an expression. Fails loud (never silent) when the AI
 * service / transcribe capability is absent, the download fails, the file is
 * empty, or the provider errors.
 */
import {
  AiSpeechToTextParamsSchema,
  fail,
  out,
  type AiSpeechToTextParams,
  type AiTranscribeRequest,
  type FlowItem,
  type NodeDef,
} from '@ctb/shared';

export const aiSpeechToText: NodeDef<AiSpeechToTextParams> = {
  type: 'ai.speechToText',
  category: 'ai',
  meta: {
    labelKey: 'nodes.ai.speechToText.label',
    descriptionKey: 'nodes.ai.speechToText.desc',
    icon: 'sparkles',
  },
  ports: { inputs: ['main'], outputs: ['main'] },
  paramsSchema: AiSpeechToTextParamsSchema,
  async execute(ctx, params, items) {
    if (!ctx.ai || typeof ctx.ai.transcribe !== 'function') {
      return fail('ai.speechToText: speech-to-text is not available in this context');
    }

    // 1) Locate the audio bytes + a filename/mime hint for the upload.
    let audio: Uint8Array;
    let filename: string;
    let mime: string | undefined;
    try {
      if (params.source === 'file') {
        if (!ctx.files) {
          return fail('ai.speechToText: file store is not available in this context');
        }
        const file = await ctx.files.read(params.audio_source);
        audio = file.bytes;
        mime = file.mime ?? undefined;
        filename = filenameFromMime(mime);
      } else {
        if (!ctx.tg || typeof ctx.tg.getFile !== 'function') {
          return fail('ai.speechToText: Telegram file download is not available in this context');
        }
        const file = await ctx.tg.getFile(params.audio_source);
        audio = file.bytes;
        mime = file.mime ?? undefined;
        filename = basename(file.filePath) || filenameFromMime(mime);
      }
    } catch (err) {
      return fail(`ai.speechToText: ${err instanceof Error ? err.message : String(err)}`);
    }

    if (!audio || audio.byteLength === 0) {
      return fail('ai.speechToText: the audio file is empty');
    }

    // 2) Transcribe (host-side; the credential is resolved there — I7).
    const req: AiTranscribeRequest = {
      credentialId: params.credentialId,
      model: params.model,
      audio,
      filename,
      ...(mime ? { mime } : {}),
      ...(params.language && params.language.trim() !== '' ? { language: params.language } : {}),
      ...(params.prompt && params.prompt.trim() !== '' ? { prompt: params.prompt } : {}),
    };

    let result: { text: string; language?: string; duration?: number };
    try {
      result = await ctx.ai.transcribe(req);
    } catch (err) {
      return fail(`ai.speechToText: ${err instanceof Error ? err.message : String(err)}`);
    }

    const value = {
      text: result.text,
      ...(result.language !== undefined ? { language: result.language } : {}),
      ...(result.duration !== undefined ? { duration: result.duration } : {}),
    };

    // 3) Merge onto every output item under save_as (default `transcript`).
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

/** Last path segment of a Telegram `file_path` (e.g. `voice/file_3.oga` → `file_3.oga`). */
function basename(p: string): string {
  if (!p) return '';
  const parts = p.split('/');
  return parts[parts.length - 1] ?? '';
}

/** A filename whose extension matches the MIME so the provider sniffs the format. */
function filenameFromMime(mime: string | undefined): string {
  const ext = mime ? MIME_EXT[mime.split(';')[0]!.trim().toLowerCase()] : undefined;
  return `audio.${ext ?? 'mp3'}`;
}

/** Minimal audio MIME → extension map (the common Telegram + OpenAI formats). */
const MIME_EXT: Record<string, string> = {
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/mp4': 'm4a',
  'audio/m4a': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/ogg': 'ogg',
  'audio/opus': 'ogg',
  'audio/oga': 'oga',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/webm': 'webm',
  'audio/flac': 'flac',
};
