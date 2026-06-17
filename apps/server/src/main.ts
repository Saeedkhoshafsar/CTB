/**
 * @ctb/server entrypoint — boots Fastify + the conversational engine (P1-T8).
 * Validates env, opens DB + migrations, wires gateway→router→executor,
 * re-starts bots that were active before the last shutdown (I4: a restart
 * must never strand waiting conversations), then listens.
 */
import { destroyDefaultSandboxPool } from '@ctb/sandbox';
import { eq } from 'drizzle-orm';
import { buildApp } from './app';
import { openDb, schema } from './db/index';
import { runMigrations } from './db/migrate';
import { wireEngine } from './engine/wire';
import { decrypt, deriveKey } from './lib/crypto';
import { loadEnv } from './lib/env';

async function main(): Promise<void> {
  const env = loadEnv();

  // DB up + migrated before accepting traffic (invariant I4: durability first).
  const { db, sqlite } = openDb(env.CTB_DB_PATH);
  runMigrations(db);

  const engine = wireEngine({
    db,
    sqlite,
    ctbSecret: env.CTB_SECRET,
    dataDir: env.CTB_DATA_DIR,
    codeHttpAllowList: (env.CTB_CODE_HTTP_ALLOWLIST ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s !== ''),
    log: (level, message, data) => {
      // eslint-disable-next-line no-console
      if (level === 'error' || level === 'warn') console.error(`[engine:${level}]`, message, data ?? '');
    },
  });

  const app = buildApp({ env, db, sqlite, engine });
  app.log.info({ dbPath: env.CTB_DB_PATH }, 'database migrated');

  // Re-arm bots that were active before the last shutdown.
  const key = deriveKey(env.CTB_SECRET);
  const activeBots = db.select().from(schema.bots).where(eq(schema.bots.status, 'active')).all();
  for (const bot of activeBots) {
    try {
      const token = decrypt(bot.tokenEnc, key);
      engine.gateway.registerBot(bot.id, token);
      if (bot.mode === 'webhook' && env.CTB_PUBLIC_URL) {
        await engine.gateway.enableWebhook(bot.id, env.CTB_PUBLIC_URL);
      } else {
        await engine.gateway.startPolling(bot.id);
      }
      app.log.info({ botId: bot.id, mode: bot.mode }, 'bot restarted');
    } catch (err) {
      app.log.error({ botId: bot.id, err }, 'failed to restart bot');
      db.update(schema.bots)
        .set({ status: 'error', updatedAt: new Date().toISOString() })
        .where(eq(schema.bots.id, bot.id))
        .run();
    }
  }

  // Durable-wait timeouts keep firing across restarts.
  engine.router.startTimeoutScanner();
  // Cron schedules (schedule.trigger) re-arm from the active flows in the DB.
  engine.scheduler.start();

  const close = async (signal: string): Promise<void> => {
    app.log.info({ signal }, 'shutting down');
    engine.router.stopTimeoutScanner();
    engine.scheduler.stop();
    await engine.gateway.stopAll();
    await app.close();
    await destroyDefaultSandboxPool(); // Code-node workers
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
