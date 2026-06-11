/**
 * P1-T8 — 🎬 PHASE-1 DEMO as a scripted e2e test (PLAN acceptance).
 *
 * The FULL production wiring (wireEngine: SqliteExecutionStore + SqliteFlowSource
 * + exec_logs sink + per-bot TgSender over a FAKE transport) drives the demo:
 *
 *   /start → ask name (wait) → ask age (number, validated, 2 retries)
 *          → "سلام {{name}}، {{age}} ساله!"
 *
 * Headline: "kill the server" mid-conversation = throw away every in-memory
 * object, keep ONLY the SQLite file, re-wire from scratch, answer — the flow
 * resumes from the exact node (invariant I4). Updates enter through the real
 * gateway.dispatch (raw Telegram Update JSON), exactly like webhook/polling.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { destroyDefaultSandboxPool } from '@ctb/sandbox';
import { FlowGraphSchema } from '@ctb/shared';
import type { Update, UserFromGetMe } from 'grammy/types';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { openDb, schema, type Db } from '../src/db/index';
import { runMigrations } from '../src/db/migrate';
import { wireEngine, type Engine } from '../src/engine/wire';
import { encrypt, deriveKey } from '../src/lib/crypto';

const SECRET = 'devsecret0123456';
const TOKEN = '123456789:AAEexampletokenexampletokenexample';
const GRAPH = FlowGraphSchema.parse(
  JSON.parse(
    readFileSync(new URL('../../../packages/shared/test/fixtures/sample-flow.json', import.meta.url), 'utf8'),
  ),
);
const BOT_INFO: UserFromGetMe = {
  id: 42, is_bot: true, first_name: 'DemoBot', username: 'demo_bot',
  can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: false,
  can_connect_to_business: false, has_main_web_app: false, can_manage_bots: false,
  has_topics_enabled: false, allows_users_to_create_topics: false,
};

afterAll(async () => {
  await destroyDefaultSandboxPool();
});

interface Sent { method: string; payload: Record<string, unknown> }

/** Boot "a server": open the DB file, wire the engine, register the bot with a recording fake transport. */
function boot(dbPath: string): { engine: Engine; db: Db; sqlite: ReturnType<typeof openDb>['sqlite']; sent: Sent[] } {
  const { db, sqlite } = openDb(dbPath);
  runMigrations(db);
  const engine = wireEngine({ db, ctbSecret: SECRET });
  const sent: Sent[] = [];
  engine.gateway.registerBot('demo-bot', TOKEN, {
    botInfo: BOT_INFO,
    callApi: async (method, payload) => {
      sent.push({ method, payload });
      return { message_id: sent.length };
    },
  });
  return { engine, db, sqlite, sent };
}

function seed(db: Db): void {
  const now = new Date().toISOString();
  db.insert(schema.bots).values({
    id: 'demo-bot', name: 'Demo', tokenEnc: encrypt(TOKEN, deriveKey(SECRET)),
    mode: 'polling', status: 'active', settings: {}, createdAt: now, updatedAt: now,
  }).run();
  db.insert(schema.flows).values({
    id: 'demo-flow', botId: 'demo-bot', name: 'خوش‌آمد', status: 'active',
    graph: GRAPH, version: 1, updatedAt: now,
  }).run();
}

let updateId = 0;
function tgUpdate(text: string, chatId = 7): Update {
  updateId += 1;
  return {
    update_id: updateId,
    message: {
      message_id: updateId * 10,
      date: 0,
      from: { id: 900, is_bot: false, first_name: 'علی' },
      chat: { id: chatId, type: 'private', first_name: 'علی' },
      text,
    },
  } as unknown as Update;
}

const lastText = (sent: Sent[]): string => (sent.at(-1)?.payload.text as string) ?? '';

describe('🎬 Phase-1 demo e2e (P1-T8)', () => {
  let dir: string;
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('full conversation through the wired stack, RESTART mid-conversation, resumes & finishes', async () => {
    dir = mkdtempSync(join(tmpdir(), 'ctb-demo-'));
    const dbPath = join(dir, 'ctb.sqlite');

    // ── server #1 ──
    const s1 = boot(dbPath);
    seed(s1.db);

    await s1.engine.gateway.dispatch('demo-bot', tgUpdate('/start'));
    expect(lastText(s1.sent)).toBe('سلام! اسمت چیه؟');

    await s1.engine.gateway.dispatch('demo-bot', tgUpdate('علی'));
    expect(lastText(s1.sent)).toBe('چند سالته علی؟');

    // validation re-prompt also flows through the real sender
    await s1.engine.gateway.dispatch('demo-bot', tgUpdate('abc'));
    expect(lastText(s1.sent)).toBe('یه عدد بین ۱ تا ۱۲۰ بفرست');

    // ── 💀 kill server #1 mid-conversation (waiting at ask_age, 1 retry burned) ──
    await s1.engine.gateway.stopAll();
    s1.sqlite.close();

    // ── server #2: fresh process semantics — only the SQLite file survives ──
    const s2 = boot(dbPath);
    await s2.engine.gateway.dispatch('demo-bot', tgUpdate('۳۵')); // Persian digits
    expect(lastText(s2.sent)).toBe('سلام علی، 35 ساله! خوش اومدی 🎉');

    // durable end-state assertions
    const execs = s2.db.select().from(schema.executions).all();
    expect(execs).toHaveLength(1);
    expect(execs[0]!.status).toBe('done');
    expect((execs[0]!.state as { vars: Record<string, unknown> }).vars).toMatchObject({ name: 'علی', age: 35 });

    // exec_logs captured steps from BOTH server lifetimes
    const logs = s2.db.select().from(schema.execLogs).all();
    expect(logs.length).toBeGreaterThan(4);

    await s2.engine.gateway.stopAll();
    s2.sqlite.close();
  });

  it('retries exhaust across a restart too — invalid port → flow.stopError', async () => {
    dir = mkdtempSync(join(tmpdir(), 'ctb-demo-'));
    const dbPath = join(dir, 'ctb.sqlite');

    const s1 = boot(dbPath);
    seed(s1.db);
    await s1.engine.gateway.dispatch('demo-bot', tgUpdate('/start'));
    await s1.engine.gateway.dispatch('demo-bot', tgUpdate('سارا'));
    await s1.engine.gateway.dispatch('demo-bot', tgUpdate('999')); // retry 1 (out of range)
    await s1.engine.gateway.stopAll();
    s1.sqlite.close();

    const s2 = boot(dbPath);
    await s2.engine.gateway.dispatch('demo-bot', tgUpdate('xyz')); // retry 2
    expect(lastText(s2.sent)).toBe('یه عدد بین ۱ تا ۱۲۰ بفرست');
    await s2.engine.gateway.dispatch('demo-bot', tgUpdate('باز هم غلط')); // exhausted → invalid port
    const exec = s2.db.select().from(schema.executions).all()[0]!;
    expect(exec.status).toBe('error');
    expect(exec.error).toContain('سن نامعتبر بعد از چند تلاش');
    await s2.engine.gateway.stopAll();
    s2.sqlite.close();
  });

  it('two chats run independently through the same wired bot', async () => {
    dir = mkdtempSync(join(tmpdir(), 'ctb-demo-'));
    const s = boot(join(dir, 'ctb.sqlite'));
    seed(s.db);

    await s.engine.gateway.dispatch('demo-bot', tgUpdate('/start', 1));
    await s.engine.gateway.dispatch('demo-bot', tgUpdate('/start', 2));
    await s.engine.gateway.dispatch('demo-bot', tgUpdate('رضا', 1));
    await s.engine.gateway.dispatch('demo-bot', tgUpdate('مینا', 2));
    await s.engine.gateway.dispatch('demo-bot', tgUpdate('30', 1));
    await s.engine.gateway.dispatch('demo-bot', tgUpdate('25', 2));

    const greets = s.sent.filter((m) => (m.payload.text as string)?.startsWith('سلام ') && (m.payload.text as string).includes('ساله'));
    expect(greets.map((g) => [g.payload.chat_id, g.payload.text])).toEqual([
      [1, 'سلام رضا، 30 ساله! خوش اومدی 🎉'],
      [2, 'سلام مینا، 25 ساله! خوش اومدی 🎉'],
    ]);
    await s.engine.gateway.stopAll();
    s.sqlite.close();
  });

});
