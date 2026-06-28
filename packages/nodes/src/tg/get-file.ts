/**
 * tg.getFile — Get a File (NODES.md §Telegram, PLAN2 PA-T2).
 *
 * The RECEIVE half of the media pair (tg.sendMedia being SEND): given a Telegram
 * `file_id` (captured by the trigger from a photo/voice/document/video message),
 * DOWNLOAD its bytes and OPTIONALLY store them in the file-store so downstream
 * nodes (tg.sendMedia `source:'file'`, future ai.speechToText) can use them.
 *
 * The node never touches the token, the network, or the disk (invariants
 * I3/I6): it asks ctx.tg.getFile for the bytes (the HOST calls the Bot-API
 * `getFile`, then downloads from Telegram's file endpoint with the bot token),
 * and — when `store` is on — hands the bytes to ctx.files.write (the host
 * stamps the run's bot and writes them under the file-store). Runs ONCE per node
 * run (one download), merging a result object onto each item under `save_as`:
 *   { file_id, stored_file_id?, path, url, mime, size }
 *
 * `file_id` defaults to a `$json` lookup so the node drops in right after a
 * media trigger with no config — it tries `$json.file_id`, then the common
 * nested shapes a normalizer emits. An explicit param always wins.
 */
import {
  fail,
  out,
  TgGetFileParamsSchema,
  type FlowItem,
  type NodeDef,
  type TgGetFileParams,
} from '@ctb/shared';
import { tgNoBotError } from './helpers';

/** Pull a non-empty string at `key` from a json-ish object, else undefined. */
function strAt(obj: unknown, key: string): string | undefined {
  if (obj === null || typeof obj !== 'object') return undefined;
  const v = (obj as Record<string, unknown>)[key];
  return typeof v === 'string' && v !== '' ? v : undefined;
}

/**
 * Resolve a file_id from an incoming item when the param is blank. Tries
 * `$json.file_id`, then the common nested shapes a trigger/normalizer emits
 * (`reply.file_id`, `photo.file_id`, `voice.file_id`, `document.file_id`,
 * `audio.file_id`, `video.file_id`).
 */
function fileIdFromItem(json: Record<string, unknown>): string | undefined {
  const direct = strAt(json, 'file_id');
  if (direct) return direct;
  for (const k of ['reply', 'photo', 'voice', 'document', 'audio', 'video']) {
    const nested = strAt(json[k], 'file_id');
    if (nested) return nested;
  }
  return undefined;
}

export const tgGetFile: NodeDef<TgGetFileParams> = {
  type: 'tg.getFile',
  category: 'telegram',
  meta: { labelKey: 'nodes.tg.getFile.label', descriptionKey: 'nodes.tg.getFile.desc', icon: 'download' },
  ports: { inputs: ['main'], outputs: ['main'] },
  paramsSchema: TgGetFileParamsSchema,
  async execute(ctx, params, items) {
    if (!ctx.tg) return fail(tgNoBotError('دریافت فایل / get a file'));
    if (!ctx.tg.getFile) {
      return fail('tg.getFile is not available on this instance (host did not inject getFile)');
    }

    // Resolve the file_id: explicit param wins, else look it up on the first item.
    let fileId = params.file_id.trim();
    if (fileId === '') {
      const first = items[0]?.json ?? {};
      fileId = fileIdFromItem(first) ?? '';
    }
    if (fileId === '') {
      return fail('tg.getFile: no file_id — param is empty and none found on the incoming item');
    }

    let bytes: Uint8Array;
    let filePath: string;
    let downloadedMime: string | null;
    let size: number | null;
    try {
      ({ bytes, filePath, size, mime: downloadedMime } = await ctx.tg.getFile(fileId));
    } catch (err) {
      return fail(`tg.getFile: download failed — ${(err as Error).message}`);
    }

    // Build the result merged onto each item. `path`/`url` are the Telegram-side
    // temporary path; `stored_file_id` (+ the file-store url) appear only when
    // `store` is on and a file store is wired.
    const result: Record<string, unknown> = {
      file_id: fileId,
      path: filePath,
      url: `https://api.telegram.org/file/${filePath}`,
      mime: downloadedMime,
      size,
    };

    if (params.store) {
      if (!ctx.files) {
        return fail('tg.getFile: store is on but no file store is wired on this instance');
      }
      try {
        const stored = await ctx.files.write(bytes, downloadedMime);
        result.stored_file_id = stored.id;
        result.url = stored.url;
        if (stored.mime !== null) result.mime = stored.mime;
        if (stored.size !== null) result.size = stored.size;
      } catch (err) {
        return fail(`tg.getFile: store failed — ${(err as Error).message}`);
      }
    }

    const inputs: FlowItem[] = items.length > 0 ? items : [{ json: {} }];
    const outputs: FlowItem[] = inputs.map((it) => ({
      ...it,
      json: { ...it.json, [params.save_as]: result },
    }));
    return out({ main: outputs });
  },
};
