/**
 * Phase-1 demo seeder (PLAN P1-T8).
 *
 * Usage:
 *   CTB_SECRET=… CTB_DB_PATH=… CTB_BOT_TOKEN=<real token> \
 *     npx tsx apps/server/scripts/demo-flow.ts
 *
 * Creates (idempotently, keyed by name):
 *   - a polling-mode bot from CTB_BOT_TOKEN (status=active so the server
 *     auto-starts it on boot)
 *   - the shared sample flow (ask name → ask age validated → IF → greet),
 *     status=active — the same fixture every e2e test runs against.
 *
 * Then: `npm run dev:server`, message the bot /start, kill the server
 * mid-conversation, restart, answer — the flow resumes (the Phase-1 demo).
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FlowGraphSchema } from '@ctb/shared';
import { eq } from 'drizzle-orm';
import { openDb, schema } from '../src/db/index';
import { runMigrations } from '../src/db/migrate';
import { encrypt, deriveKey } from '../src/lib/crypto';
import { loadEnv } from '../src/lib/env';

const BOT_NAME = 'CTB Demo Bot';
const FLOW_NAME = 'خوش‌آمدگویی (Phase-1 demo)';

const FIXTURE = join(
  dirname(fileURLToPath(import.meta.url)),
  '..', '..', '..', 'packages', 'shared', 'test', 'fixtures', 'sample-flow.json',
);

function main(): void {
  const env = loadEnv();
  const token = process.env.CTB_BOT_TOKEN;
  if (!token || !/^\d+:[\w-]{20,}$/.test(token)) {
    console.error('CTB_BOT_TOKEN env must be set to a real Telegram bot token');
    process.exit(1);
  }

  const graph = FlowGraphSchema.parse(JSON.parse(readFileSync(FIXTURE, 'utf8')));
  const { db, sqlite } = openDb(env.CTB_DB_PATH);
  runMigrations(db);
  const key = deriveKey(env.CTB_SECRET);
  const now = new Date().toISOString();

  // ── bot (idempotent by name) ──
  let bot = db.select().from(schema.bots).where(eq(schema.bots.name, BOT_NAME)).get();
  if (bot) {
    db.update(schema.bots)
      .set({ tokenEnc: encrypt(token, key), mode: 'polling', status: 'active', updatedAt: now })
      .where(eq(schema.bots.id, bot.id))
      .run();
    console.log(`updated bot ${bot.id} (${BOT_NAME})`);
  } else {
    bot = {
      id: randomUUID(),
      name: BOT_NAME,
      tokenEnc: encrypt(token, key),
      mode: 'polling' as const,
      status: 'active' as const,
      settings: {},
      createdAt: now,
      updatedAt: now,
    };
    db.insert(schema.bots).values(bot).run();
    console.log(`created bot ${bot.id} (${BOT_NAME})`);
  }

  // ── flow (idempotent by name+bot) ──
  const existing = db.select().from(schema.flows).where(eq(schema.flows.botId, bot.id)).all();
  const flow = existing.find((f) => f.name === FLOW_NAME);
  if (flow) {
    db.update(schema.flows)
      .set({ graph, status: 'active', version: flow.version + 1, updatedAt: now })
      .where(eq(schema.flows.id, flow.id))
      .run();
    console.log(`updated flow ${flow.id} → v${flow.version + 1}`);
  } else {
    const id = randomUUID();
    db.insert(schema.flows)
      .values({ id, botId: bot.id, name: FLOW_NAME, status: 'active', graph, version: 1, updatedAt: now })
      .run();
    console.log(`created flow ${id} (${FLOW_NAME})`);
  }

  sqlite.close();
  console.log('\nseeded. now: npm run dev:server → message the bot /start');
}

main();
