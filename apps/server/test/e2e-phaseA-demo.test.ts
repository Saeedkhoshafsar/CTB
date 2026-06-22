/**
 * 🎬 PA-T8 — Phase-A end-to-end demo.
 *
 * Proves PLAN2 Phase A: a flow built from ONLY Phase-A nodes can do everything
 * an n8n "core nodes" flow can, for the conversational domain — no AI needed.
 *
 * The flow (packages/shared/test/fixtures/phase-a-demo-flow.json) answers a
 * `/report` command by running a pure data-transform pipeline and replying with
 * a Jalali-stamped task summary + a media album:
 *
 *   tg.trigger(/report)
 *     → data.editFields (seed a tasks[] array, JSON value-mode)   [PA-T3]
 *     → data.splitOut   (one item per task)                       [PA-T5]
 *     → data.removeDuplicates (drop the repeat)                   [PA-T6]
 *     → data.sort       (by due date, ascending)                  [PA-T6]
 *     → data.limit      (keep the first 3)                        [PA-T6]
 *     → data.aggregate  (collect titles[]/dues[] into one item)   [PA-T5]
 *     → data.dateTime   (stamp now in the Jalali calendar)        [PA-T7]
 *     → data.editFields (compose the reply text + count)          [PA-T3]
 *     → data.filter     (gate: count > 0 → kept | discarded)      [PA-T4]
 *         kept      → tg.sendMessage (summary) → tg.sendMedia (album)  [PA-T1]
 *         discarded → tg.sendMessage ("nothing to report")
 *
 * Driven through the REAL UpdateRouter + Executor + MemoryExecutionStore with a
 * fake Telegram transport (recording sendMessage + sendMedia), exactly like the
 * P1 e2e (e2e-nodes-flow.test.ts) — so this exercises the genuine engine, not a
 * node harness.
 */
import {
  Executor,
  MemoryExecutionStore,
  NodeRegistry,
  type ExecutorServices,
} from '@ctb/core';
import { registerBuiltinNodes } from '@ctb/nodes';
import { destroyDefaultSandboxPool } from '@ctb/sandbox';
import { FlowGraphSchema, defaultFlowSettings, type FlowGraph } from '@ctb/shared';
import type { Update } from 'grammy/types';
import { readFileSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import { UpdateRouter, type FlowSource } from '../src/engine/router';
import { normalizeUpdate, type TgEvent } from '../src/telegram/normalize';

afterAll(async () => {
  await destroyDefaultSandboxPool();
});

const GRAPH: FlowGraph = FlowGraphSchema.parse(
  JSON.parse(
    readFileSync(
      new URL('../../../packages/shared/test/fixtures/phase-a-demo-flow.json', import.meta.url),
      'utf8',
    ),
  ),
);

interface SentText {
  chatId: number;
  text: string;
}
interface SentMedia {
  chatId: number;
  caption: string | undefined;
  media: { kind: string; ref: string }[];
}

/** A fixed clock so the Jalali "now" stamp is deterministic. */
const FIXED_NOW = new Date('2026-06-11T08:00:00.000Z'); // 11:30 Asia/Tehran → Jalali 1405/03/21

function makeWorld(store = new MemoryExecutionStore()) {
  const sent: SentText[] = [];
  const media: SentMedia[] = [];
  const registry = registerBuiltinNodes(new NodeRegistry());
  const services: ExecutorServices = {
    clock: () => FIXED_NOW,
    // Raise the expression budget for the slow CI sandbox (the supported host
    // tuning seam — ExecutorServices.evalOptions.budgetMs). The default 50ms can
    // be blown by the worker's COLD START on a loaded sandbox, which would error
    // an otherwise-correct flow (`expression exceeded 50ms budget`); production
    // hosts keep the strict default. Mirrors e2e-phaseE-voice-demo.
    evalOptions: { budgetMs: 5_000 },
    kv: () => ({ get: async () => undefined, set: async () => undefined, delete: async () => undefined }),
    http: { request: async () => ({ status: 200, headers: {}, body: null }) },
    tg: () => ({
      async sendMessage(opts) {
        sent.push({ chatId: opts.chat_id as number, text: (opts.text as string) ?? '' });
        return { messageId: sent.length };
      },
      async sendMedia(opts) {
        // The node resolves a URL/file_id source into a TgInputMedia carrying `ref`.
        const m = (opts.media as { kind: string; ref: string }[]).map((x) => ({
          kind: x.kind,
          ref: x.ref,
        }));
        media.push({
          chatId: opts.chat_id as number,
          caption: opts.caption as string | undefined,
          media: m,
        });
        return { messageIds: m.map((_, i) => i + 1) };
      },
    }),
  };
  const executor = new Executor(registry, store, services);
  const flow = { id: 'rep', name: 'گزارش', graph: GRAPH, settings: defaultFlowSettings() };
  const flows: FlowSource = {
    activeFlows: async () => [flow],
    getFlow: async (id) => (id === 'rep' ? flow : null),
  };
  let n = 0;
  const router = new UpdateRouter({
    store,
    executor,
    flows,
    sendText: async (_b, chatId, text) => {
      sent.push({ chatId, text });
    },
    newId: () => `exec-${++n}`,
  });
  return { store, router, sent, media };
}

function cmd(text: string, updateId: number, chatId = 555): TgEvent {
  const update = {
    update_id: updateId,
    message: {
      message_id: updateId * 10,
      date: 0,
      from: { id: 900, is_bot: false, first_name: 'سعید' },
      chat: { id: chatId, type: 'private', first_name: 'سعید' },
      text,
    },
  } as unknown as Update;
  const event = normalizeUpdate('b1', update);
  if (!event) throw new Error('unsupported fixture update');
  return event;
}

describe('🎬 PA-T8 — Phase-A demo flow on the real engine', () => {
  it('/report → split/dedupe/sort/limit/aggregate/Jalali → summary + album', async () => {
    const { router, store, sent, media } = makeWorld();

    await router.handle(cmd('/report', 1));

    // The run completes synchronously (no waits in this flow).
    const done = (await store.load('exec-1'))!;
    expect(done.status).toBe('done');
    expect(done.error).toBeNull();

    // Two text sends are expected: NONE on the empty branch — only the summary.
    expect(sent).toHaveLength(1);
    const summary = sent[0]!;
    expect(summary.chatId).toBe(555);

    // Header carries the Jalali (Persian-digit) report date for the fixed clock.
    expect(summary.text).toContain('📋 گزارش کارها — ۱۴۰۵/۰۳/۲۱');
    // Count is the 3 surviving (deduped + limited) tasks.
    expect(summary.text).toContain('(3 مورد، به‌ترتیب سررسید)');

    // Tasks appear sorted by due date ascending, after the duplicate is dropped:
    //   raw: طراحی(11) کدنویسی(09) طراحی(11,dup) تست(14) استقرار(12)
    //   dedupe → کدنویسی(09) طراحی(11) تست(14) استقرار(12)
    //   sort asc → کدنویسی(09) طراحی(11) استقرار(12) تست(14)
    //   limit 3 → کدنویسی(09) طراحی(11) استقرار(12)
    expect(summary.text).toContain('• کدنویسی — 2026-06-09');
    expect(summary.text).toContain('• طراحی — 2026-06-11');
    expect(summary.text).toContain('• استقرار — 2026-06-12');
    // The 4th task (تست) was dropped by the limit.
    expect(summary.text).not.toContain('تست');

    // The album is sent AFTER the summary, on the kept branch.
    expect(media).toHaveLength(1);
    const album = media[0]!;
    expect(album.chatId).toBe(555);
    expect(album.caption).toBe('نمودارهای گزارش 📷');
    expect(album.media).toEqual([
      { kind: 'photo', ref: 'https://example.com/chart-1.png' },
      { kind: 'photo', ref: 'https://example.com/chart-2.png' },
    ]);
  });

  it('durability (I4): a restart mid-run is moot — the flow has no waits and finishes in one pass', async () => {
    // This flow is purely synchronous (no tg.waitForReply), so a single
    // dispatch runs it end-to-end. We assert it never parks a waiting row.
    const { router, store } = makeWorld();
    await router.handle(cmd('/report', 1));
    const waiting = await store.findWaiting({ botId: 'b1', chatId: 555 });
    expect(waiting).toHaveLength(0);
  });
});
