/**
 * 🎬 PB-T8 — Phase-B end-to-end demo (the voice screenshot, rebuilt in CTB).
 *
 * Proves PLAN2 Phase B: the user's reference screenshot — a Telegram VOICE NOTE
 * answered by an AI that hears, reasons with tools + memory, and replies in a
 * synthesized VOICE NOTE — runs end-to-end on the REAL engine using ONLY shipped
 * Phase-B nodes. The transport (LLM / transcribe / TTS / Telegram / DB) is faked
 * and scripted; the nodes, the typed-slot resolution, the agent tool loop, and
 * the Postgres chat-memory runtime are all genuine.
 *
 * The flow (packages/shared/test/fixtures/phase-b-voice-flow.json):
 *
 *   tg.trigger(message)                                            [P1]
 *     → ai.speechToText  (ctx.tg.getFile → ctx.ai.transcribe)      [PB-T7]
 *     → ai.agent         (consumes its typed slots)                [PB-T5]
 *          ▲ ai:model   ← ai.modelOpenai                           [PB-T5]
 *          ▲ ai:memory  ← ai.memoryPostgres (rolling, over ctx.db) [PB-T4]
 *          ▲ ai:tool    ← tool.think                               [PB-T6]
 *          ▲ ai:tool    ← tool.httpRequest (order_status)          [PB-T6]
 *     → ai.textToSpeech  (ctx.ai.speech → ctx.files.write)         [PB-T7]
 *     → tg.sendMedia     (source:file → upload the voice note)     [PA-T1]
 *
 * Driven straight through the REAL Executor + MemoryExecutionStore (like the
 * PA-T8 demo) with fake, recording services — so this exercises the genuine
 * engine + slot resolver + agent loop, not a node harness.
 */
import {
  Executor,
  MemoryExecutionStore,
  NodeRegistry,
  type ExecutorServices,
} from '@ctb/core';
import { registerBuiltinNodes } from '@ctb/nodes';
import { destroyDefaultSandboxPool } from '@ctb/sandbox';
import {
  FlowGraphSchema,
  defaultFlowSettings,
  type AiChatRequest,
  type AiChatResult,
  type AiSpeechRequest,
  type AiTranscribeRequest,
  type FlowGraph,
  type FlowItem,
} from '@ctb/shared';
import { readFileSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';

afterAll(async () => {
  await destroyDefaultSandboxPool();
});

const GRAPH: FlowGraph = FlowGraphSchema.parse(
  JSON.parse(
    readFileSync(
      new URL('../../../packages/shared/test/fixtures/phase-b-voice-flow.json', import.meta.url),
      'utf8',
    ),
  ),
);

const FIXED_NOW = new Date('2026-06-18T08:00:00.000Z');

interface SentMedia {
  chatId: number;
  caption: string | undefined;
  media: { kind: string; ref?: string; bytes?: Uint8Array }[];
}

/** A single fake in-memory file store shared by ctx.files (write) + ctx.tg.getFile. */
function makeFileStore() {
  const files = new Map<string, { bytes: Uint8Array; mime: string | null }>();
  let n = 0;
  return {
    files,
    async write(bytes: Uint8Array, mime: string | null) {
      const id = `file-${++n}`;
      files.set(id, { bytes, mime });
      return { id, mime, size: bytes.byteLength, url: `ctb://files/${id}` };
    },
    async read(id: string) {
      const f = files.get(id);
      if (!f) throw new Error(`no such file ${id}`);
      return { bytes: f.bytes, mime: f.mime };
    },
  };
}

/**
 * A fake in-memory Postgres standing in for ctx.db, honouring exactly the three
 * statements the chat-memory runtime issues (CREATE TABLE / INSERT pair / SELECT
 * window). Rows persist ACROSS runs so the second call can replay the first.
 */
function makeFakeDb() {
  const rows: { id: number; session_key: string; role: string; content: string }[] = [];
  let seq = 0;
  const queries: string[] = [];
  return {
    rows,
    queries,
    db: {
      async query(req: { sql: string; params?: unknown[] }) {
        queries.push(req.sql.replace(/\s+/g, ' ').trim());
        const sql = req.sql;
        const v = (req.params ?? []) as unknown[];
        if (/^\s*CREATE TABLE/i.test(sql)) {
          return { rows: [], rowCount: 0 };
        }
        if (/^\s*INSERT INTO/i.test(sql)) {
          // INSERT … VALUES ($1,$2,$3),($1,$4,$5) — a user+assistant pair.
          const sessionKey = String(v[0]);
          rows.push({ id: ++seq, session_key: sessionKey, role: String(v[1]), content: String(v[2]) });
          rows.push({ id: ++seq, session_key: sessionKey, role: String(v[3]), content: String(v[4]) });
          return { rows: [], rowCount: 2 };
        }
        if (/^\s*SELECT/i.test(sql)) {
          const sessionKey = String(v[0]);
          const limit = Number(v[1]);
          const hist = rows
            .filter((r) => r.session_key === sessionKey)
            .slice(-limit)
            .map((r) => ({ role: r.role, content: r.content }));
          return { rows: hist, rowCount: hist.length };
        }
        return { rows: [], rowCount: 0 };
      },
    },
  };
}

interface AiRecorder {
  transcribeCalls: AiTranscribeRequest[];
  chatCalls: AiChatRequest[];
  speechCalls: AiSpeechRequest[];
}

/**
 * A scripted fake ctx.ai. `chatScript` is replayed in order (the last entry is
 * reused if the loop overruns). `transcript` is what every transcribe returns.
 */
function makeAi(opts: {
  transcript: string;
  chatScript: AiChatResult[];
  rec: AiRecorder;
}): NonNullable<ExecutorServices['ai']> {
  let chatTurn = 0;
  return {
    async chat(req: AiChatRequest): Promise<AiChatResult> {
      opts.rec.chatCalls.push(req);
      const idx = Math.min(chatTurn, opts.chatScript.length - 1);
      chatTurn += 1;
      return opts.chatScript[idx]!;
    },
    async transcribe(req: AiTranscribeRequest) {
      opts.rec.transcribeCalls.push(req);
      return { text: opts.transcript, language: 'fa', duration: 3.2 };
    },
    async speech(req: AiSpeechRequest) {
      opts.rec.speechCalls.push(req);
      // Encode the input text into bytes so we can assert what was synthesized.
      return { audio: new TextEncoder().encode(`AUDIO:${req.input}`), mime: 'audio/ogg' };
    },
  };
}

interface World {
  store: MemoryExecutionStore;
  executor: Executor;
  media: SentMedia[];
  httpCalls: { url: string; method: string }[];
  rec: AiRecorder;
  dbState: ReturnType<typeof makeFakeDb>;
}

function makeWorld(opts: {
  transcript: string;
  chatScript: AiChatResult[];
  store?: MemoryExecutionStore;
  dbState?: ReturnType<typeof makeFakeDb>;
}): World {
  const store = opts.store ?? new MemoryExecutionStore();
  const media: SentMedia[] = [];
  const httpCalls: { url: string; method: string }[] = [];
  const rec: AiRecorder = { transcribeCalls: [], chatCalls: [], speechCalls: [] };
  const fileStore = makeFileStore();
  const dbState = opts.dbState ?? makeFakeDb();
  const registry = registerBuiltinNodes(new NodeRegistry());

  const services: ExecutorServices = {
    clock: () => FIXED_NOW,
    kv: () => ({ get: async () => undefined, set: async () => undefined, delete: async () => undefined }),
    http: {
      async request(req) {
        httpCalls.push({ url: req.url, method: req.method ?? 'GET' });
        return { status: 200, headers: {}, body: { status: 'shipped', eta: '2026-06-20' } };
      },
    },
    ai: makeAi({ transcript: opts.transcript, chatScript: opts.chatScript, rec }),
    db: dbState.db as unknown as NonNullable<ExecutorServices['db']>,
    files: () => ({
      write: fileStore.write,
      read: fileStore.read,
    }),
    tg: () => ({
      async sendMessage() {
        return { messageId: 1 };
      },
      async sendMedia(o) {
        const m = (o.media as { kind: string; ref?: string; bytes?: Uint8Array }[]).map((x) => ({
          kind: x.kind,
          ...(x.ref !== undefined ? { ref: x.ref } : {}),
          ...(x.bytes !== undefined ? { bytes: x.bytes } : {}),
        }));
        media.push({ chatId: o.chat_id as number, caption: o.caption as string | undefined, media: m });
        return { messageIds: m.map((_, i) => i + 1) };
      },
      // tg.getFile — the host download the STT node calls for source:telegram.
      async getFile(fileId: string) {
        return {
          bytes: new TextEncoder().encode(`VOICE-BYTES:${fileId}`),
          filePath: `voice/${fileId}.oga`,
          size: 2048,
          mime: 'audio/ogg',
        };
      },
    }),
  };

  const executor = new Executor(registry, store, services);
  return { store, executor, media, httpCalls, rec, dbState };
}

/** A trigger item shaped like apps/server match.ts `triggerItem` for a voice msg. */
function voiceItem(chatId = 555, fileId = 'voice_abc'): Record<'main', FlowItem[]> {
  return {
    main: [
      {
        json: {
          user: { id: 900, first_name: 'سعید' },
          chat: { id: chatId, type: 'private' },
          message_id: 4242,
          raw: { message: { voice: { file_id: fileId, duration: 3 } } },
        },
      },
    ],
  };
}

const FLOW = { id: 'voice', name: 'پشتیبان صوتی', graph: GRAPH, settings: defaultFlowSettings() };

/** Turn-1 asks the order_status tool; turn-2 answers. */
const TURN1_TOOLCALL: AiChatResult = {
  reply: '',
  usage: { totalTokens: 25 },
  model: 'gpt-4o-mini',
  toolCalls: [{ id: 'call_1', name: 'order_status', argumentsJson: '{"orderId":"A-17"}' }],
};
const TURN2_FINAL: AiChatResult = {
  reply: 'سفارش شما ارسال شده و تا ۳۰ خرداد می‌رسد.',
  usage: { totalTokens: 50 },
  model: 'gpt-4o-mini',
};

describe('🎬 PB-T8 — Phase-B voice demo on the real engine', () => {
  it('voice note → STT → agent(model+memory+tools) → TTS → audio reply', async () => {
    const w = makeWorld({
      transcript: 'وضعیت سفارش A-17 چیه؟',
      chatScript: [TURN1_TOOLCALL, TURN2_FINAL],
    });

    const res = await w.executor.start({
      executionId: 'exec-voice-1',
      flow: FLOW,
      graph: GRAPH,
      botId: 'b1',
      chatId: 555,
      entry: { nodeId: 'trigger', items: voiceItem() },
    });
    expect(res.status).toBe('done');
    expect(res.error).toBeNull();

    // ── STT: the host downloaded the voice file_id and transcribed those bytes ──
    expect(w.rec.transcribeCalls).toHaveLength(1);
    const tr = w.rec.transcribeCalls[0]!;
    expect(new TextDecoder().decode(tr.audio)).toBe('VOICE-BYTES:voice_abc');
    expect(tr.filename).toBe('voice_abc.oga'); // basename of the Telegram file_path
    expect(tr.language).toBe('fa');

    // ── Agent: model slot supplied the model; the user prompt was the transcript ──
    expect(w.rec.chatCalls.length).toBe(2); // tool turn + final turn
    const turn1 = w.rec.chatCalls[0]!;
    expect(turn1.model).toBe('openai/gpt-4o-mini'); // from the ai.modelOpenai PROVIDER
    expect(turn1.temperature).toBe(0.3);
    const userMsg = turn1.messages.find((m) => m.role === 'user');
    expect(userMsg?.content).toBe('وضعیت سفارش A-17 چیه؟');
    // Both tools were advertised to the model (think + order_status).
    const toolNames = (turn1.tools ?? []).map((t) => t.name).sort();
    expect(toolNames).toEqual(['order_status', 'think']);

    // ── HTTP tool actually ran with the model's chosen arg ──
    // A GET tool merges the model's args into the query string.
    expect(w.httpCalls).toHaveLength(1);
    expect(w.httpCalls[0]!.url).toContain('/orders');
    expect(w.httpCalls[0]!.url).toContain('orderId=A-17');

    // ── TTS: synthesized the agent's reply, stored bytes, sent as an audio note ──
    expect(w.rec.speechCalls).toHaveLength(1);
    expect(w.rec.speechCalls[0]!.input).toBe('سفارش شما ارسال شده و تا ۳۰ خرداد می‌رسد.');
    expect(w.rec.speechCalls[0]!.format).toBe('opus');

    expect(w.media).toHaveLength(1);
    const sent = w.media[0]!;
    expect(sent.chatId).toBe(555);
    expect(sent.caption).toBe('🔊 پاسخ صوتی');
    expect(sent.media[0]!.kind).toBe('audio');
    // source:'file' → the host READ the stored bytes (the synthesized audio that
    // ai.textToSpeech wrote) and uploads them; assert it's the right reply audio.
    expect(sent.media[0]!.bytes).toBeDefined();
    expect(new TextDecoder().decode(sent.media[0]!.bytes!)).toBe(
      'AUDIO:سفارش شما ارسال شده و تا ۳۰ خرداد می‌رسد.',
    );

    // ── Memory: the turn was persisted to the (fake) Postgres table ──
    const stored = w.dbState.rows;
    expect(stored.map((r) => r.role)).toEqual(['user', 'assistant']);
    expect(stored[0]!.content).toBe('وضعیت سفارش A-17 چیه؟');
    expect(stored[1]!.content).toBe('سفارش شما ارسال شده و تا ۳۰ خرداد می‌رسد.');
    expect(w.dbState.queries.some((q) => q.startsWith('CREATE TABLE'))).toBe(true);
  });

  it('memory replay: a SECOND voice call sees the FIRST turn in the model prompt', async () => {
    // Share ONE store-less db across two runs so the rolling memory persists.
    const dbState = makeFakeDb();

    // Call #1 — seeds the memory.
    const w1 = makeWorld({
      transcript: 'سلام، اسم من سعیده.',
      chatScript: [{ reply: 'سلام سعید! چطور می‌تونم کمک کنم؟', usage: { totalTokens: 12 }, model: 'gpt-4o-mini' }],
      dbState,
    });
    const r1 = await w1.executor.start({
      executionId: 'exec-mem-1',
      flow: FLOW,
      graph: GRAPH,
      botId: 'b1',
      chatId: 777,
      entry: { nodeId: 'trigger', items: voiceItem(777, 'voice_one') },
    });
    expect(r1.status).toBe('done');

    // Call #2 — same chat → the runtime must REPLAY turn #1 into the prompt.
    const w2 = makeWorld({
      transcript: 'اسم من چی بود؟',
      chatScript: [{ reply: 'اسم شما سعید بود.', usage: { totalTokens: 14 }, model: 'gpt-4o-mini' }],
      dbState,
    });
    const r2 = await w2.executor.start({
      executionId: 'exec-mem-2',
      flow: FLOW,
      graph: GRAPH,
      botId: 'b1',
      chatId: 777,
      entry: { nodeId: 'trigger', items: voiceItem(777, 'voice_two') },
    });
    expect(r2.status).toBe('done');

    // The second model call's messages include the replayed first exchange,
    // BEFORE the new user turn.
    const msgs = w2.rec.chatCalls[0]!.messages.map((m) => `${m.role}:${m.content}`);
    expect(msgs).toContain('user:سلام، اسم من سعیده.');
    expect(msgs).toContain('assistant:سلام سعید! چطور می‌تونم کمک کنم؟');
    expect(msgs).toContain('user:اسم من چی بود؟');
    // Order: the replayed pair precedes the new question.
    const firstUserIdx = msgs.indexOf('user:سلام، اسم من سعیده.');
    const newUserIdx = msgs.indexOf('user:اسم من چی بود؟');
    expect(firstUserIdx).toBeGreaterThanOrEqual(0);
    expect(newUserIdx).toBeGreaterThan(firstUserIdx);
  });
});
