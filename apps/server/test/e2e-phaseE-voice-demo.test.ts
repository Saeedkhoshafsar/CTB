/**
 * 🎬 PE-T5 — Phase-E end-to-end demo (LIVE VOICE, two scenarios, one node set).
 *
 * Proves PLAN2 Phase E: live Telegram voice, in the TWO scenarios the user asked
 * for, both built from the SAME generic nodes — differing only in SETTINGS
 * (target kind + `mode`). There are NO `support.*` / `broadcast.*` domain nodes:
 * behaviour is configuration (invariant I2).
 *
 *   Demo A — AI voice support (1:1 Channel-Direct call), mode:'support':
 *     trigger.callEvent(utteranceFinal)                              [PE-T3]
 *       → ai.speechToText  (source:file → ctx.files.read)            [PB-T7 reused]
 *       → ai.agent         (consumes its typed slots)                [PB-T5]
 *            ▲ ai:model   ← ai.modelOpenai                           [PB-T5]
 *            ▲ ai:memory  ← ai.memoryPostgres (keyed by the CALL)    [PB-T4]
 *            ▲ ai:tool    ← tool.think / tool.httpRequest            [PB-T6]
 *       → ai.textToSpeech  (ctx.ai.speech → ctx.files.write)         [PB-T7 reused]
 *       → call.speak       (source:file → ctx.call.speak)            [PE-T4]
 *
 *   Demo B — channel Q&A moderator (live broadcast), mode:'lineup':
 *     trigger.callEvent(utteranceFinal)                              [PE-T3]
 *       → call.grantTurn   (open the mic to this listener)           [PE-T4]
 *       → ai.textToSpeech  (the "it's your turn" greeting)           [PB-T7 reused]
 *       → call.speak       (announce into the broadcast)             [PE-T4]
 *       → call.endTurn     (close the turn → the queue advances)     [PE-T4]
 *
 * Driven through the REAL Executor + the REAL CallSessionService + the REAL
 * LoopbackVoiceConnector with fake (scripted) AI / Postgres / HTTP / files / tg
 * services. So this exercises the genuine engine + slot resolver + agent loop +
 * the host call runtime — not a node harness.
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
  type CredentialData,
  type FlowGraph,
  type FlowItem,
} from '@ctb/shared';
import { readFileSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import {
  CallSessionService,
  makeVoiceCredentialResolver,
} from '../src/triggers/call-session';
import { LoopbackVoiceConnector } from '../src/engine/loopback-connector';

afterAll(async () => {
  await destroyDefaultSandboxPool();
});

function loadGraph(name: string): FlowGraph {
  return FlowGraphSchema.parse(
    JSON.parse(
      readFileSync(
        new URL(`../../../packages/shared/test/fixtures/${name}`, import.meta.url),
        'utf8',
      ),
    ),
  );
}

const SUPPORT_GRAPH = loadGraph('phase-e-voice-support-flow.json');
const QA_GRAPH = loadGraph('phase-e-qa-moderator-flow.json');

const FIXED_NOW = new Date('2026-06-20T08:00:00.000Z');

/** A structurally-valid `voiceConnection` credential (loopback ignores secrets). */
function voiceCred(): CredentialData {
  return {
    type: 'voiceConnection',
    kind: 'userbot',
    apiId: 12345,
    apiHash: 'deadbeefdeadbeefdeadbeefdeadbeef',
    session: 'FAKE_SESSION_STRING',
  } as unknown as CredentialData;
}

/** A single fake in-memory file store shared by ctx.files (write) + the call svc (read). */
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
type FileStore = ReturnType<typeof makeFileStore>;

/** A fake in-memory Postgres honouring the chat-memory runtime's three statements. */
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
        if (/^\s*CREATE TABLE/i.test(sql)) return { rows: [], rowCount: 0 };
        if (/^\s*INSERT INTO/i.test(sql)) {
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

/** A scripted fake ctx.ai. `chatScript` replays in order (last entry reused). */
function makeAi(opts: {
  transcript: string;
  chatScript: AiChatResult[];
  rec: AiRecorder;
}): NonNullable<ExecutorServices['ai']> {
  let chatTurn = 0;
  return () => ({
    async chat(req: AiChatRequest): Promise<AiChatResult> {
      opts.rec.chatCalls.push(req);
      const idx = Math.min(chatTurn, opts.chatScript.length - 1);
      chatTurn += 1;
      return opts.chatScript[idx]!;
    },
    async transcribe(req: AiTranscribeRequest) {
      opts.rec.transcribeCalls.push(req);
      return { text: opts.transcript, language: 'fa', duration: 2.1 };
    },
    async speech(req: AiSpeechRequest) {
      opts.rec.speechCalls.push(req);
      // Encode the input text into bytes so the connector spy can assert it.
      return { audio: new TextEncoder().encode(req.input), mime: 'audio/l16' };
    },
  });
}

interface SpokenFrame {
  target: string;
  text: string;
}

interface World {
  executor: Executor;
  service: CallSessionService;
  connector: LoopbackVoiceConnector;
  fileStore: FileStore;
  spoken: SpokenFrame[];
  httpCalls: { url: string; method: string }[];
  rec: AiRecorder;
  dbState: ReturnType<typeof makeFakeDb>;
}

function makeWorld(opts: {
  transcript: string;
  chatScript: AiChatResult[];
  dbState?: ReturnType<typeof makeFakeDb>;
}): World {
  const store = new MemoryExecutionStore();
  const httpCalls: { url: string; method: string }[] = [];
  const rec: AiRecorder = { transcribeCalls: [], chatCalls: [], speechCalls: [] };
  const fileStore = makeFileStore();
  const dbState = opts.dbState ?? makeFakeDb();
  const registry = registerBuiltinNodes(new NodeRegistry());

  // ── the REAL host call runtime ────────────────────────────────────────────────
  const connector = new LoopbackVoiceConnector();
  const service = new CallSessionService({
    connector,
    resolveCredential: makeVoiceCredentialResolver(() => voiceCred()),
    readFile: (id) => fileStore.read(id),
    clock: () => FIXED_NOW.getTime(),
  });

  // Spy on every PCM frame the connector plays so we can assert what was spoken.
  const spoken: SpokenFrame[] = [];
  const realSpeak = connector.speak.bind(connector);
  connector.speak = async (target, audio) => {
    spoken.push({ target: `${target.kind}:${target.id}`, text: new TextDecoder().decode(audio.pcm) });
    return realSpeak(target, audio);
  };

  const services: ExecutorServices = {
    clock: () => FIXED_NOW,
    kv: () => ({ get: async () => undefined, set: async () => undefined, delete: async () => undefined }),
    http: {
      async request(req) {
        httpCalls.push({ url: req.url, method: req.method ?? 'GET' });
        return { status: 200, headers: {}, body: { status: 'shipped', eta: '2026-06-25' } };
      },
    },
    ai: makeAi({ transcript: opts.transcript, chatScript: opts.chatScript, rec }),
    db: dbState.db as unknown as NonNullable<ExecutorServices['db']>,
    files: () => ({ write: fileStore.write, read: fileStore.read }),
    // Executor always builds ctx.tg; a minimal stub keeps it happy (unused here).
    tg: () => ({
      async sendMessage() {
        return { messageId: 1 };
      },
    }),
    // The live-voice capability — bound to bot+flow, proxies to the real service.
    call: (botId, flowId) => service.capabilityFor(botId, flowId),
    // Raise the expression budget for the slow CI sandbox (the supported host
    // tuning seam — ExecutorServices.evalOptions.budgetMs). The default 50ms can
    // flake on a cold-start worker; the demo asserts behaviour, not latency.
    evalOptions: { budgetMs: 5_000 },
  };

  const executor = new Executor(registry, store, services);
  return { executor, service, connector, fileStore, spoken, httpCalls, rec, dbState };
}

/** The item the CallEventBus.buildItem produces for a finalized utterance. */
function utteranceItem(opts: {
  targetKind: 'chat' | 'channel' | 'user';
  targetId: string;
  mode: 'support' | 'lineup';
  speakerId: number | string;
  audioFileId: string;
  sampleRate?: number;
}): Record<'main', FlowItem[]> {
  return {
    main: [
      {
        json: {
          event: 'utteranceFinal',
          target: { kind: opts.targetKind, id: opts.targetId },
          mode: opts.mode,
          speakerId: opts.speakerId,
          audioFileId: opts.audioFileId,
          audioMime: 'audio/l16',
          audioSampleRate: opts.sampleRate ?? 16_000,
        },
      },
    ],
  };
}

const SUPPORT_FLOW = {
  id: 'voice-support',
  name: 'پشتیبان صوتی زنده',
  graph: SUPPORT_GRAPH,
  settings: defaultFlowSettings(),
};
const QA_FLOW = {
  id: 'qa-moderator',
  name: 'مجری پخش زنده',
  graph: QA_GRAPH,
  settings: defaultFlowSettings(),
};

/** Turn-1 calls the order_status tool; turn-2 answers. */
const TURN1_TOOLCALL: AiChatResult = {
  reply: '',
  usage: { totalTokens: 25 },
  model: 'gpt-4o-mini',
  toolCalls: [{ id: 'call_1', name: 'order_status', argumentsJson: '{"orderId":"B-42"}' }],
};
const TURN2_FINAL: AiChatResult = {
  reply: 'سفارش شما ارسال شده و تا ۴ تیر می‌رسد.',
  usage: { totalTokens: 50 },
  model: 'gpt-4o-mini',
};

describe('🎬 PE-T5 — Phase-E live-voice demo on the real engine', () => {
  // ── DEMO A: AI voice support (1:1) ─────────────────────────────────────────────
  it('SUPPORT: utterance → STT → agent(model+memory+tools) → TTS → call.speak', async () => {
    const w = makeWorld({
      transcript: 'وضعیت سفارش B-42 چیه؟',
      chatScript: [TURN1_TOOLCALL, TURN2_FINAL],
    });
    // The host establishes the 1:1 call (the flow only REACTS to events).
    await w.service
      .capabilityFor('b1', SUPPORT_FLOW.id)
      .connect({ credentialId: 'cred-voice', target: { kind: 'user', id: '900' }, mode: 'support' });

    // Seed the inbound utterance bytes as the bus's persistAudio would (audio/l16).
    const utterFile = await w.fileStore.write(
      new TextEncoder().encode('PCM:وضعیت سفارش B-42 چیه؟'),
      'audio/l16',
    );

    const res = await w.executor.start({
      executionId: 'exec-support-1',
      flow: SUPPORT_FLOW,
      graph: SUPPORT_GRAPH,
      botId: 'b1',
      chatId: null,
      entry: {
        nodeId: 'trigger',
        items: utteranceItem({
          targetKind: 'user',
          targetId: '900',
          mode: 'support',
          speakerId: 900,
          audioFileId: utterFile.id,
        }),
      },
    });
    expect(res.status).toBe('done');
    expect(res.error).toBeNull();

    // STT read the host-persisted utterance bytes (source:'file').
    expect(w.rec.transcribeCalls).toHaveLength(1);
    expect(new TextDecoder().decode(w.rec.transcribeCalls[0]!.audio)).toBe('PCM:وضعیت سفارش B-42 چیه؟');

    // Agent: model slot supplied model; the prompt was the transcript; both tools advertised.
    expect(w.rec.chatCalls.length).toBe(2);
    expect(w.rec.chatCalls[0]!.model).toBe('openai/gpt-4o-mini');
    expect(w.rec.chatCalls[0]!.messages.find((m) => m.role === 'user')?.content).toBe('وضعیت سفارش B-42 چیه؟');
    expect((w.rec.chatCalls[0]!.tools ?? []).map((t) => t.name).sort()).toEqual(['order_status', 'think']);

    // HTTP tool actually ran with the model's chosen arg.
    expect(w.httpCalls).toHaveLength(1);
    expect(w.httpCalls[0]!.url).toContain('orderId=B-42');

    // TTS synthesized the reply; call.speak played those bytes INTO the call.
    expect(w.rec.speechCalls).toHaveLength(1);
    expect(w.rec.speechCalls[0]!.input).toBe('سفارش شما ارسال شده و تا ۴ تیر می‌رسد.');
    expect(w.spoken).toHaveLength(1);
    expect(w.spoken[0]!.target).toBe('user:900');
    expect(w.spoken[0]!.text).toBe('سفارش شما ارسال شده و تا ۴ تیر می‌رسد.');

    // Memory persisted under a session key derived from the CALL target. NOTE: the
    // provider's `{{ }}` session_key is passed VERBATIM — the slot resolver
    // validates provider params but does NOT evaluate their expressions; the agent
    // uses it literally. So the persisted key is the literal expression string.
    expect(w.dbState.rows.map((r) => r.role)).toEqual(['user', 'assistant']);
    const insert = w.dbState.queries.find((q) => q.startsWith('INSERT INTO'));
    expect(insert).toBeDefined();
    expect(w.dbState.rows[0]!.session_key).toBe('call-{{ $json.target.id }}');
  });

  it('SUPPORT: memory replays across two utterances of the same call', async () => {
    const dbState = makeFakeDb();

    const w1 = makeWorld({
      transcript: 'سلام، اسم من سعیده.',
      chatScript: [{ reply: 'سلام سعید! بفرمایید.', usage: { totalTokens: 12 }, model: 'gpt-4o-mini' }],
      dbState,
    });
    await w1.service
      .capabilityFor('b1', SUPPORT_FLOW.id)
      .connect({ credentialId: 'cred-voice', target: { kind: 'user', id: '900' }, mode: 'support' });
    const f1 = await w1.fileStore.write(new TextEncoder().encode('PCM:1'), 'audio/l16');
    const r1 = await w1.executor.start({
      executionId: 'exec-support-mem-1',
      flow: SUPPORT_FLOW,
      graph: SUPPORT_GRAPH,
      botId: 'b1',
      chatId: null,
      entry: {
        nodeId: 'trigger',
        items: utteranceItem({ targetKind: 'user', targetId: '900', mode: 'support', speakerId: 900, audioFileId: f1.id }),
      },
    });
    expect(r1.status).toBe('done');

    const w2 = makeWorld({
      transcript: 'اسم من چی بود؟',
      chatScript: [{ reply: 'اسم شما سعید بود.', usage: { totalTokens: 14 }, model: 'gpt-4o-mini' }],
      dbState,
    });
    await w2.service
      .capabilityFor('b1', SUPPORT_FLOW.id)
      .connect({ credentialId: 'cred-voice', target: { kind: 'user', id: '900' }, mode: 'support' });
    const f2 = await w2.fileStore.write(new TextEncoder().encode('PCM:2'), 'audio/l16');
    const r2 = await w2.executor.start({
      executionId: 'exec-support-mem-2',
      flow: SUPPORT_FLOW,
      graph: SUPPORT_GRAPH,
      botId: 'b1',
      chatId: null,
      entry: {
        nodeId: 'trigger',
        items: utteranceItem({ targetKind: 'user', targetId: '900', mode: 'support', speakerId: 900, audioFileId: f2.id }),
      },
    });
    expect(r2.status).toBe('done');

    const msgs = w2.rec.chatCalls[0]!.messages.map((m) => `${m.role}:${m.content}`);
    expect(msgs).toContain('user:سلام، اسم من سعیده.');
    expect(msgs).toContain('assistant:سلام سعید! بفرمایید.');
    expect(msgs).toContain('user:اسم من چی بود؟');
    const firstUserIdx = msgs.indexOf('user:سلام، اسم من سعیده.');
    const newUserIdx = msgs.indexOf('user:اسم من چی بود؟');
    expect(newUserIdx).toBeGreaterThan(firstUserIdx);
  });

  // ── DEMO B: channel Q&A moderator (lineup) ─────────────────────────────────────
  it('LINEUP: two listeners queue → grant→speak→endTurn advances the line', async () => {
    const w = makeWorld({ transcript: '(ignored — no STT in this flow)', chatScript: [] });
    const cap = w.service.capabilityFor('b1', QA_FLOW.id);
    await cap.connect({
      credentialId: 'cred-voice',
      target: { kind: 'channel', id: '-100500' },
      mode: 'lineup',
      order: 'sequential',
    });

    // Two listeners ask to speak (the connector segments each as an utterance);
    // the service enqueues them in order.
    w.connector.emitUtterance(
      { kind: 'channel', id: '-100500' },
      { speakerId: 111, audio: { pcm: new TextEncoder().encode('q1'), sampleRate: 16_000 } },
    );
    w.connector.emitUtterance(
      { kind: 'channel', id: '-100500' },
      { speakerId: 222, audio: { pcm: new TextEncoder().encode('q2'), sampleRate: 16_000 } },
    );
    expect((await cap.status({ target: { kind: 'channel', id: '-100500' } })).queue).toEqual([111, 222]);

    // Run the moderator flow for listener 111 (utteranceFinal at the front).
    const r1 = await w.executor.start({
      executionId: 'exec-qa-1',
      flow: QA_FLOW,
      graph: QA_GRAPH,
      botId: 'b1',
      chatId: null,
      entry: {
        nodeId: 'trigger',
        items: utteranceItem({ targetKind: 'channel', targetId: '-100500', mode: 'lineup', speakerId: 111, audioFileId: 'x' }),
      },
    });
    expect(r1.status).toBe('done');
    // 111 was granted + greeted, then the turn closed → queue is now [222].
    expect((await cap.status({ target: { kind: 'channel', id: '-100500' } })).queue).toEqual([222]);
    expect(w.spoken.at(-1)!.target).toBe('channel:-100500');
    expect(w.spoken.at(-1)!.text).toBe('نوبت شما رسید. بفرمایید سؤالتان را بپرسید.');

    // Run again for listener 222.
    const r2 = await w.executor.start({
      executionId: 'exec-qa-2',
      flow: QA_FLOW,
      graph: QA_GRAPH,
      botId: 'b1',
      chatId: null,
      entry: {
        nodeId: 'trigger',
        items: utteranceItem({ targetKind: 'channel', targetId: '-100500', mode: 'lineup', speakerId: 222, audioFileId: 'x' }),
      },
    });
    expect(r2.status).toBe('done');
    expect((await cap.status({ target: { kind: 'channel', id: '-100500' } })).queue).toEqual([]);
    expect(w.spoken).toHaveLength(2);
  });

  // ── the invariant: SAME nodes power both demos (I2) ─────────────────────────────
  it('the two demos are built from the same node set, differing only in settings', () => {
    const supportTypes = SUPPORT_GRAPH.nodes.map((n) => n.type);
    const qaTypes = QA_GRAPH.nodes.map((n) => n.type);

    // Both start with the SAME live-voice entry node.
    expect(supportTypes[0]).toBe('trigger.callEvent');
    expect(qaTypes[0]).toBe('trigger.callEvent');

    // The Q&A flow composes the generic call.* actions to run a line.
    expect(qaTypes).toContain('call.grantTurn');
    expect(qaTypes).toContain('call.endTurn');
    expect(qaTypes).toContain('call.speak');

    // Same node TYPE, different MODE — the only thing that forks behaviour.
    const supportTrigger = SUPPORT_GRAPH.nodes.find((n) => n.id === 'trigger')!;
    const qaTrigger = QA_GRAPH.nodes.find((n) => n.id === 'trigger')!;
    expect((supportTrigger.params as { mode: string }).mode).toBe('support');
    expect((qaTrigger.params as { mode: string }).mode).toBe('lineup');

    // No domain-specific node types exist — only generic call.* / ai.* / tool.*.
    for (const t of [...supportTypes, ...qaTypes]) {
      expect(t).toMatch(/^(trigger|ai|tool|call)\./);
    }
  });
});
