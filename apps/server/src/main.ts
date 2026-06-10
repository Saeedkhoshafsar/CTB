/**
 * @ctb/server entrypoint — boots Fastify (P0-T4).
 * Validates env, opens DB + runs migrations, then listens.
 */
import { buildApp } from './app';
import { openDb } from './db/index';
import { runMigrations } from './db/migrate';
import { loadEnv } from './lib/env';

async function main(): Promise<void> {
  const env = loadEnv();

  // DB up + migrated before accepting traffic (invariant I4: durability first).
  const { db, sqlite } = openDb(env.CTB_DB_PATH);
  runMigrations(db);

  const app = buildApp({ env });
  app.log.info({ dbPath: env.CTB_DB_PATH }, 'database migrated');

  const close = async (signal: string): Promise<void> => {
    app.log.info({ signal }, 'shutting down');
    await app.close();
    sqlite.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void close('SIGINT'));
  process.on('SIGTERM', () => void close('SIGTERM'));

  await app.listen({ port: env.CTB_PORT, host: env.CTB_HOST });
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
