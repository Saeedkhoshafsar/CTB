/**
 * PB-T7 — Speech nodes (NODES.md §AI nodes, PLAN2 PB-T7).
 *
 *   - ai.speechToText — downloads an audio file (Telegram file_id via
 *     ctx.tg.getFile, or a stored CTB file via ctx.files.read) and transcribes
 *     it via ctx.ai.transcribe (OpenAI-compatible /audio/transcriptions).
 *   - ai.textToSpeech — synthesizes speech via ctx.ai.speech (/audio/speech),
 *     stores the bytes via ctx.files.write, and surfaces a CTB file id that
 *     tg.sendMedia (source:'file') can send.
 *
 * These tests cover (a) registration + the data-node contract, (b) the happy
 * path through the mocked capabilities, (c) the credential/model/args plumbing,
 * (d) save_as + multi-item fan-out, and (e) fail-loud behaviour when a required
 * capability is absent or errors.
 */
import { NodeRegistry } from '@ctb/core';
import { describe, expect, it } from 'vitest';
import { aiSpeechToText, aiTextToSpeech, registerBuiltinNodes } from '../src/index';
import { AiSpeechToTextParamsSchema, AiTextToSpeechParamsSchema } from '@ctb/shared';
import { item, makeCtx, params } from './node-harness';

describe('PB-T7 speech nodes — registration & contract', () => {
  it('registers ai.speechToText and ai.textToSpeech as data nodes', () => {
    const reg = registerBuiltinNodes(new NodeRegistry());
    const stt = reg.get('ai.speechToText');
    const tts = reg.get('ai.textToSpeech');
    expect(stt).toBeDefined();
    expect(tts).toBeDefined();
    // Plain data nodes: main in/out, no provider role.
    expect(stt!.category).toBe('ai');
    expect(stt!.ports).toEqual({ inputs: ['main'], outputs: ['main'] });
    expect(stt!.role).toBeUndefined();
    expect(tts!.ports).toEqual({ inputs: ['main'], outputs: ['main'] });
    expect(tts!.role).toBeUndefined();
  });

  it('exposes label/desc keys the editor i18n resolves', () => {
    expect(aiSpeechToText.meta.labelKey).toBe('nodes.ai.speechToText.label');
    expect(aiSpeechToText.meta.descriptionKey).toBe('nodes.ai.speechToText.desc');
    expect(aiTextToSpeech.meta.labelKey).toBe('nodes.ai.textToSpeech.label');
    expect(aiTextToSpeech.meta.descriptionKey).toBe('nodes.ai.textToSpeech.desc');
  });

  it('applies schema defaults', () => {
    const stt = AiSpeechToTextParamsSchema.parse({ credentialId: 'c', audio_source: 'f' });
    expect(stt.model).toBe('whisper-1');
    expect(stt.source).toBe('telegram');
    expect(stt.save_as).toBe('transcript');
    const tts = AiTextToSpeechParamsSchema.parse({ credentialId: 'c', text: 'hi' });
    expect(tts.model).toBe('tts-1');
    expect(tts.voice).toBe('alloy');
    expect(tts.format).toBe('mp3');
    expect(tts.save_as).toBe('speech');
  });
});

describe('PB-T7 ai.speechToText', () => {
  it('downloads a Telegram file_id and transcribes it', async () => {
    const ctx = makeCtx({
      getFileResult: { bytes: new Uint8Array([9, 9, 9]), filePath: 'voice/file_3.oga', mime: 'audio/ogg' },
      transcribeResult: { text: 'hello world', language: 'en', duration: 1.5 },
    });
    const res = await aiSpeechToText.execute(
      ctx,
      params(aiSpeechToText, { credentialId: 'cred1', model: 'whisper-1', audio_source: 'FILE_ID_1' }),
      [item({ chat: 1 })],
    );
    if (res.kind !== 'items') throw new Error('expected items');

    // Downloaded the Telegram file, then transcribed exactly once.
    expect(ctx.getFileCalls).toEqual(['FILE_ID_1']);
    expect(ctx.transcribeCalls.length).toBe(1);
    const call = ctx.transcribeCalls[0]!;
    expect(call.credentialId).toBe('cred1');
    expect(call.model).toBe('whisper-1');
    expect(call.audio).toEqual(new Uint8Array([9, 9, 9]));
    expect(call.filename).toBe('file_3.oga'); // basename of the Telegram file_path
    expect(call.mime).toBe('audio/ogg');

    const out = res.outputs.main![0]!.json as {
      chat: number;
      transcript: { text: string; language?: string; duration?: number };
    };
    expect(out.chat).toBe(1); // original field preserved
    expect(out.transcript).toEqual({ text: 'hello world', language: 'en', duration: 1.5 });
  });

  it('reads a stored CTB file when source = file', async () => {
    const ctx = makeCtx({
      seedFiles: { stored1: { bytes: new Uint8Array([7, 7]), mime: 'audio/mpeg' } },
      transcribeResult: { text: 'from store' },
    });
    const res = await aiSpeechToText.execute(
      ctx,
      params(aiSpeechToText, { credentialId: 'c', audio_source: 'stored1', source: 'file' }),
      [item({})],
    );
    if (res.kind !== 'items') throw new Error('expected items');
    expect(ctx.getFileCalls).toEqual([]); // not a Telegram download
    expect(ctx.transcribeCalls[0]!.audio).toEqual(new Uint8Array([7, 7]));
    expect(ctx.transcribeCalls[0]!.filename).toBe('audio.mp3'); // derived from mime
    const out = res.outputs.main![0]!.json as { transcript: { text: string } };
    expect(out.transcript.text).toBe('from store');
  });

  it('forwards language and prompt hints when set', async () => {
    const ctx = makeCtx({ transcribeResult: { text: 'سلام' } });
    await aiSpeechToText.execute(
      ctx,
      params(aiSpeechToText, {
        credentialId: 'c',
        audio_source: 'FID',
        language: 'fa',
        prompt: 'یک گفتگو',
      }),
      [item({})],
    );
    const call = ctx.transcribeCalls[0]!;
    expect(call.language).toBe('fa');
    expect(call.prompt).toBe('یک گفتگو');
  });

  it('omits blank language/prompt', async () => {
    const ctx = makeCtx({ transcribeResult: { text: 'x' } });
    await aiSpeechToText.execute(
      ctx,
      params(aiSpeechToText, { credentialId: 'c', audio_source: 'FID' }),
      [item({})],
    );
    const call = ctx.transcribeCalls[0]!;
    expect(call.language).toBeUndefined();
    expect(call.prompt).toBeUndefined();
  });

  it('writes the result onto every output item under a custom save_as', async () => {
    const ctx = makeCtx({ transcribeResult: { text: 'shared' } });
    const res = await aiSpeechToText.execute(
      ctx,
      params(aiSpeechToText, { credentialId: 'c', audio_source: 'FID', save_as: 'stt' }),
      [item({ id: 1 }), item({ id: 2 })],
    );
    if (res.kind !== 'items') throw new Error('expected items');
    // One transcription call regardless of item count.
    expect(ctx.transcribeCalls.length).toBe(1);
    for (const out of res.outputs.main!) {
      expect((out.json as { stt: { text: string } }).stt.text).toBe('shared');
    }
  });

  it('fails loud when ctx.ai is absent', async () => {
    const ctx = makeCtx({ aiResponses: null });
    const res = await aiSpeechToText.execute(
      ctx,
      params(aiSpeechToText, { credentialId: 'c', audio_source: 'FID' }),
      [item({})],
    );
    expect(res.kind).toBe('error');
    if (res.kind === 'error') expect(res.message).toMatch(/not available/);
  });

  it('fails loud when ctx.ai.transcribe is absent (older host)', async () => {
    const ctx = makeCtx({ dropTranscribe: true });
    const res = await aiSpeechToText.execute(
      ctx,
      params(aiSpeechToText, { credentialId: 'c', audio_source: 'FID' }),
      [item({})],
    );
    expect(res.kind).toBe('error');
  });

  it('fails loud when the Telegram download errors', async () => {
    const ctx = makeCtx({ getFileError: 'file expired' });
    const res = await aiSpeechToText.execute(
      ctx,
      params(aiSpeechToText, { credentialId: 'c', audio_source: 'FID' }),
      [item({})],
    );
    expect(res.kind).toBe('error');
    if (res.kind === 'error') expect(res.message).toMatch(/file expired/);
  });

  it('fails loud when the provider transcription errors', async () => {
    const ctx = makeCtx({ transcribeResult: { error: 'rate limited' } });
    const res = await aiSpeechToText.execute(
      ctx,
      params(aiSpeechToText, { credentialId: 'c', audio_source: 'FID' }),
      [item({})],
    );
    expect(res.kind).toBe('error');
    if (res.kind === 'error') expect(res.message).toMatch(/rate limited/);
  });

  it('fails loud on an empty audio file', async () => {
    const ctx = makeCtx({ getFileResult: { bytes: new Uint8Array([]) } });
    const res = await aiSpeechToText.execute(
      ctx,
      params(aiSpeechToText, { credentialId: 'c', audio_source: 'FID' }),
      [item({})],
    );
    expect(res.kind).toBe('error');
    if (res.kind === 'error') expect(res.message).toMatch(/empty/);
  });
});

describe('PB-T7 ai.textToSpeech', () => {
  it('synthesizes speech, stores it, and surfaces a file id', async () => {
    const ctx = makeCtx({
      speechResult: { audio: new Uint8Array([5, 6, 7, 8]), mime: 'audio/mpeg' },
    });
    const res = await aiTextToSpeech.execute(
      ctx,
      params(aiTextToSpeech, { credentialId: 'cred1', model: 'tts-1', text: 'hello', voice: 'nova' }),
      [item({ topic: 'greeting' })],
    );
    if (res.kind !== 'items') throw new Error('expected items');

    // One synthesis call with the right plumbing.
    expect(ctx.speechCalls.length).toBe(1);
    const call = ctx.speechCalls[0]!;
    expect(call.credentialId).toBe('cred1');
    expect(call.model).toBe('tts-1');
    expect(call.input).toBe('hello');
    expect(call.voice).toBe('nova');
    expect(call.format).toBe('mp3');

    // Stored the bytes via ctx.files.write.
    expect(ctx.storedFiles.length).toBe(1);
    expect(ctx.storedFiles[0]!.bytes).toEqual(new Uint8Array([5, 6, 7, 8]));
    expect(ctx.storedFiles[0]!.mime).toBe('audio/mpeg');

    const out = res.outputs.main![0]!.json as {
      topic: string;
      speech: { fileId: string; mime: string | null; size: number | null; url: string };
    };
    expect(out.topic).toBe('greeting'); // original field preserved
    expect(out.speech.fileId).toBe(ctx.storedFiles[0]!.id);
    expect(out.speech.mime).toBe('audio/mpeg');
    expect(out.speech.size).toBe(4);
  });

  it('passes the chosen format and speed to the provider', async () => {
    const ctx = makeCtx();
    await aiTextToSpeech.execute(
      ctx,
      params(aiTextToSpeech, {
        credentialId: 'c',
        text: 'hi',
        format: 'opus',
        speed: 1.25,
      }),
      [item({})],
    );
    const call = ctx.speechCalls[0]!;
    expect(call.format).toBe('opus');
    expect(call.speed).toBe(1.25);
  });

  it('writes the result onto every item under a custom save_as', async () => {
    const ctx = makeCtx();
    const res = await aiTextToSpeech.execute(
      ctx,
      params(aiTextToSpeech, { credentialId: 'c', text: 'hi', save_as: 'voice' }),
      [item({ id: 1 }), item({ id: 2 })],
    );
    if (res.kind !== 'items') throw new Error('expected items');
    expect(ctx.speechCalls.length).toBe(1); // once per node run
    expect(ctx.storedFiles.length).toBe(1); // stored once, shared id
    const id = ctx.storedFiles[0]!.id;
    for (const out of res.outputs.main!) {
      expect((out.json as { voice: { fileId: string } }).voice.fileId).toBe(id);
    }
  });

  it('fails loud when ctx.ai.speech is absent (older host)', async () => {
    const ctx = makeCtx({ dropSpeech: true });
    const res = await aiTextToSpeech.execute(
      ctx,
      params(aiTextToSpeech, { credentialId: 'c', text: 'hi' }),
      [item({})],
    );
    expect(res.kind).toBe('error');
  });

  it('fails loud when the file store is absent', async () => {
    const ctx = makeCtx({ files: null });
    const res = await aiTextToSpeech.execute(
      ctx,
      params(aiTextToSpeech, { credentialId: 'c', text: 'hi' }),
      [item({})],
    );
    expect(res.kind).toBe('error');
    if (res.kind === 'error') expect(res.message).toMatch(/file store/);
  });

  it('fails loud when the provider synthesis errors', async () => {
    const ctx = makeCtx({ speechResult: { error: 'bad voice' } });
    const res = await aiTextToSpeech.execute(
      ctx,
      params(aiTextToSpeech, { credentialId: 'c', text: 'hi' }),
      [item({})],
    );
    expect(res.kind).toBe('error');
    if (res.kind === 'error') expect(res.message).toMatch(/bad voice/);
  });

  it('fails loud when the provider returns empty audio', async () => {
    const ctx = makeCtx({ speechResult: { audio: new Uint8Array([]), mime: 'audio/mpeg' } });
    const res = await aiTextToSpeech.execute(
      ctx,
      params(aiTextToSpeech, { credentialId: 'c', text: 'hi' }),
      [item({})],
    );
    expect(res.kind).toBe('error');
    if (res.kind === 'error') expect(res.message).toMatch(/empty/);
  });
});
