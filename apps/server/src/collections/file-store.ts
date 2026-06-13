/**
 * SqliteFileStore (P3.5-T2) — local-disk file storage backing the `files`
 * table. Collections' `image`/`file` fields store a file id; this store owns
 * the bytes on disk under `${dataDir}/files` and the metadata row.
 *
 * v1 is deliberately minimal (ARCHITECTURE §13.7): local disk OR a reused
 * Telegram `file_id`. No CDN, no thumbnails. The id is a random uuid; the
 * on-disk name is `<id>` (extension-less — the mime is the source of truth).
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FilePublic } from '@ctb/shared';
import { eq } from 'drizzle-orm';
import type { Db } from '../db/index';
import { files } from '../db/schema';

type FileRow = typeof files.$inferSelect;

export class FileNotFoundError extends Error {
  constructor(id: string) {
    super(`file not found: ${id}`);
    this.name = 'FileNotFoundError';
  }
}

export function fileToPublic(row: FileRow): FilePublic {
  return {
    id: row.id,
    botId: row.botId,
    kind: row.kind,
    mime: row.mime ?? null,
    size: row.size ?? null,
    createdAt: row.createdAt,
    url: `/api/files/${row.id}`,
  };
}

export class SqliteFileStore {
  private readonly dir: string;

  constructor(
    private readonly db: Db,
    dataDir: string,
    private readonly clock: () => Date = () => new Date(),
  ) {
    this.dir = join(dataDir, 'files');
  }

  /** Store raw bytes on disk + a metadata row; returns its public projection. */
  putLocal(botId: string, bytes: Buffer, mime: string | null): FilePublic {
    mkdirSync(this.dir, { recursive: true });
    const id = randomUUID();
    writeFileSync(join(this.dir, id), bytes);
    const row: FileRow = {
      id,
      botId,
      kind: 'local',
      pathOrFileId: id,
      mime,
      size: bytes.length,
      createdAt: this.clock().toISOString(),
    };
    this.db.insert(files).values(row).run();
    return fileToPublic(row);
  }

  /** Register a reused Telegram file_id (no disk write). */
  putTelegram(botId: string, fileId: string, mime: string | null): FilePublic {
    const row: FileRow = {
      id: randomUUID(),
      botId,
      kind: 'tg_file_id',
      pathOrFileId: fileId,
      mime,
      size: null,
      createdAt: this.clock().toISOString(),
    };
    this.db.insert(files).values(row).run();
    return fileToPublic(row);
  }

  get(id: string): FileRow | null {
    return this.db.select().from(files).where(eq(files.id, id)).get() ?? null;
  }

  /** Read a local file's bytes. Throws if missing or a non-local (tg) ref. */
  readLocal(id: string): { bytes: Buffer; mime: string | null } {
    const row = this.get(id);
    if (!row || row.kind !== 'local') throw new FileNotFoundError(id);
    const bytes = readFileSync(join(this.dir, row.pathOrFileId));
    return { bytes, mime: row.mime ?? null };
  }

  delete(id: string): boolean {
    const row = this.get(id);
    if (!row) return false;
    if (row.kind === 'local') {
      try {
        rmSync(join(this.dir, row.pathOrFileId), { force: true });
      } catch {
        /* best-effort */
      }
    }
    this.db.delete(files).where(eq(files.id, id)).run();
    return true;
  }
}
