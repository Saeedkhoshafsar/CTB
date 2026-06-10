/**
 * Apply Drizzle migrations. Used both as a CLI (npm run db:migrate)
 * and programmatically by the server boot & tests.
 */
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { openDb, type Db } from './index';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'drizzle');

export function runMigrations(db: Db, migrationsFolder: string = MIGRATIONS_DIR): void {
  migrate(db, { migrationsFolder });
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const { loadEnv } = await import('../lib/env');
  const env = loadEnv();
  const { db, sqlite } = openDb(env.CTB_DB_PATH);
  runMigrations(db);
  const tables = sqlite
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '__drizzle%' ORDER BY name`)
    .all() as { name: string }[];
  console.log(`migrated ${env.CTB_DB_PATH} — tables: ${tables.map((t) => t.name).join(', ')}`);
  sqlite.close();
}
