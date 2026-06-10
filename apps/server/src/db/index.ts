/** SQLite connection + Drizzle instance. WAL mode, FK enforcement on. */
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema';

export type Db = BetterSQLite3Database<typeof schema>;

export function openDb(dbPath: string): { db: Db; sqlite: Database.Database } {
  const isMemory = dbPath === ':memory:';
  const finalPath = isMemory ? dbPath : resolve(dbPath);
  if (!isMemory) mkdirSync(dirname(finalPath), { recursive: true });
  const sqlite = new Database(finalPath);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  const db = drizzle(sqlite, { schema });
  return { db, sqlite };
}

export { schema };
