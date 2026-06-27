/**
 * Update router — the conversational core (PLAN P1-T6, ARCHITECTURE §7/§9).
 *
 * For every normalized TgEvent:
 *   (1) a WAITING execution for (bot, chat) whose WaitSpec matches the event
 *       → validate → resume the executor from the wait node's port
 *   (2) else match active flows' trigger nodes
 *       (priority: command > button_click > text-pattern > any_message)
 *       → start a new execution
 *   (3) else drop (logged).
 *
 * Validation rules ride inside the reply WaitSpec (Decision Log #13): the
 * router enforces them because resume() routes from the wait node's ports —
 * the node itself never re-executes on resume.
 *
 * A per-chat mutex serializes handling so two updates from the same chat can
 * never race one waiting execution. The timeout scanner (croner, 30s) resumes
 * overdue waits via the `timeout` port (`main` for durable delays).
 */
import type { Executor, ExecutionStore, FlowRef } from '@ctb/core';
import type {
  Execution,
  FlowGraph,
  FlowItem,
  FlowNode,
  FlowSettings,
  WaitSpec,
} from '@ctb/shared';
import { Cron } from 'croner';
import type { TgEvent } from '../telegram/normalize';
import {
  callbackItem,
  matchCallbackKey,
  replyItem,
  triggerItem,
  triggerMatches,
  validateReply,
  type TriggerParams,
} from './match';

/** A flow as the router sees it — id/name + graph + per-flow settings (P3-T6). */
export type RouterFlow = FlowRef & { graph: FlowGraph; settings: FlowSettings };

/** Where the router finds flows. Server impl arrives with the bots API (P1-T8). */
export interface FlowSource {
  /** Active flows for a bot — trigger matching scans their graphs. */
  activeFlows(botId: string): Promise<RouterFlow[]>;
  /** Flow by id — needed to resume waiting/timed-out executions. */
  getFlow(flowId: string): Promise<RouterFlow | null>;
}

/** A trigger parked by executionPolicy='queue' (P3-T6), drained on terminal. */
export interface PendingTriggerStore {
  /** Park a trigger to run later (FIFO per bot/flow/chat). */
  enqueue(t: {
    botId: string;
    flowId: string;
    chatId: number;
    entryNodeId: string;
    userId: string | null;
    item: FlowItem;
  }): Promise<void>;
  /** Pop the oldest parked trigger for (bot, flow, chat), or null. */
  dequeue(botId: string, flowId: string, chatId: number): Promise<{
    entryNodeId: string;
    userId: string | null;
    item: FlowItem;
  } | null>;
}

export interface RouterDeps {
  store: ExecutionStore;
  executor: Executor;
  flows: FlowSource;
  /** Re-prompt channel for validation failures (centralized TgSender behind it). */
  sendText(botId: string, chatId: number, text: string): Promise<void>;
  /**
   * answerCallbackQuery channel (tg.menu answer_callback_text, P2-T6).
   * Optional — a missing impl (older wiring/tests) silently skips the toast;
   * failures are logged, never block the resume (the click must still work).
   */
  answerCallback?(botId: string, callbackQueryId: string, text?: string): Promise<void>;
  /**
   * User upsert hook (P3-T5). Called once per inbound update that carries a
   * `from` user, BEFORE matching, so the Users page sees everyone who ever
   * messaged the bot and data.userProfile always has a record to read. Optional
   * (older wiring/tests skip it); failures are logged, never block routing —
   * dropping an update because a side-table write hiccuped would be wrong.
   */
  onUser?(event: TgEvent): Promise<void>;
  /**
   * Queue store for executionPolicy='queue' (P3-T6). Optional — without it the
   * `queue` policy degrades to `ignore` (parking is impossible, so the new
   * trigger is simply dropped while a run is waiting).
   */
  pending?: PendingTriggerStore;
  /** Execution id factory (injectable for deterministic tests). */
  newId?: () => string;
  log?: (level: 'debug' | 'info' | 'warn' | 'error', message: string, data?: unknown) => void;
  clock?: () => Date;
}

const TRIGGER_TYPE = 'tg.trigger';
/** Most-specific match wins (NODES.md, Telegram Trigger). */
const TRIGGER_PRIORITY: Record<string, number> = {
  command: 0,
  button_click: 1,
  text: 2,
  photo: 2,
  document: 2,
  contact: 2,
  location: 2,
  chat_join: 2,
  any_message: 3,
};

export class UpdateRouter {
  private readonly newId: () => string;
  private readonly clock: () => Date;
  /** Per-chat promise chain — serializes updates for the same (bot, chat). */
  private readonly chatLocks = new Map<string, Promise<void>>();
  private scanner: Cron | null = null;

  constructor(private readonly deps: RouterDeps) {
    this.newId = deps.newId ?? (() => crypto.randomUUID());
    this.clock = deps.clock ?? (() => new Date());
  }

  /** Gateway handler entrypoint. Never throws (gateway containment is backup). */
  async handle(event: TgEvent): Promise<void> {
    await this.withChatLock(`${event.botId}:${event.chat.id}`, () =>
      this.handleSerialized(event),
    );
  }

  // ── timeout scanner ──────────────────────────────────────────────────────

  /** Start the croner job (every 30s). Idempotent. */
  startTimeoutScanner(): void {
    if (this.scanner) return;
    this.scanner = new Cron('*/30 * * * * *', () => void this.scanTimeouts());
  }

  stopTimeoutScanner(): void {
    this.scanner?.stop();
    this.scanner = null;
  }

  /** One scan pass — also called directly by tests. Returns #resumed. */
  async scanTimeouts(now: Date = this.clock()): Promise<number> {
    const overdue = await this.deps.store.listTimedOut(now);
    let resumed = 0;
    for (const exec of overdue) {
      const key = exec.chatId === null ? null : `${exec.botId}:${exec.chatId}`;
      const work = (): Promise<void> => this.resumeTimedOut(exec);
      if (key) await this.withChatLock(key, work);
      else
        await work().catch((err) => {
          this.log('error', `timeout resume failed for ${exec.id}: ${err}`);
        });
      resumed += 1;
    }
    return resumed;
  }

  // ── internals ────────────────────────────────────────────────────────────

  private async withChatLock(key: string, work: () => Promise<void>): Promise<void> {
    const prev = this.chatLocks.get(key) ?? Promise.resolve();
    const turn = prev.then(work).catch((err) => {
      this.log('error', `router failed for ${key}: ${err instanceof Error ? err.message : err}`);
    });
    this.chatLocks.set(key, turn);
    await turn;
    if (this.chatLocks.get(key) === turn) this.chatLocks.delete(key);
  }

  private async handleSerialized(event: TgEvent): Promise<void> {
    // (0) upsert the sender into the users table (P3-T5) — best-effort, never
    // blocks routing. Runs first so a brand-new user exists before any flow
    // (or data.userProfile) reads it.
    if (this.deps.onUser) {
      try {
        await this.deps.onUser(event);
      } catch (err) {
        this.log('warn', `onUser upsert failed for ${event.botId}:${event.user.id}: ${err instanceof Error ? err.message : err}`);
      }
    }

    // `/cancel` cancels waiting conversations (NODES.md default) and still
    // falls through to trigger matching so a flow may react to /cancel itself.
    if (event.kind === 'command' && event.command === 'cancel') {
      await this.cancelWaiting(event);
      await this.tryTriggers(event);
      return;
    }

    // (1) waiting execution? (commands never feed waits by default; chat_join can't)
    if (event.kind !== 'command' && event.kind !== 'chat_join') {
      const handled = await this.tryResume(event);
      if (handled) return;
    }

    // (1.5) an armed "listen for one live update" test run? (J-T1, Report B)
    // Checked BEFORE production trigger matching so a test listen CAPTURES the
    // next matching update exactly-once and the same update does NOT also start
    // a production run. Any event kind a `tg.trigger` can match is eligible
    // (a command can both cancel a wait above AND be captured by a listen).
    const captured = await this.tryResumeListen(event);
    if (captured) return;

    // (2) trigger match?
    const started = await this.tryTriggers(event);
    if (started) return;

    // (3) drop
    this.log('debug', `dropped ${event.kind} update for ${event.botId}:${event.chat.id}`);
  }

  private async cancelWaiting(event: TgEvent): Promise<void> {
    const waiting = await this.deps.store.findWaiting({
      botId: event.botId,
      chatId: event.chat.id,
    });
    for (const exec of waiting) {
      await this.deps.store.save({ id: exec.id, status: 'canceled', state: exec.state, wait: null });
      this.log('info', `execution ${exec.id} canceled by /cancel`);
    }
  }

  /** Try to resume a waiting execution. True = event consumed. */
  private async tryResume(event: TgEvent): Promise<boolean> {
    const waiting = await this.deps.store.findWaiting({
      botId: event.botId,
      chatId: event.chat.id,
    });
    for (const exec of waiting) {
      const wait = exec.wait;
      if (!wait) continue;

      if (wait.kind === 'callback' && event.kind === 'callback') {
        const port = matchCallbackKey(wait, event.data);
        if (!port) continue; // a different menu's button — not ours
        const flow = await this.flowOf(exec);
        if (!flow) continue;
        // answerCallbackQuery FIRST (Telegram shows a spinner until answered);
        // failure is logged but never blocks the resume.
        if (this.deps.answerCallback) {
          try {
            await this.deps.answerCallback(event.botId, event.callbackQueryId, wait.answerText);
          } catch (err) {
            this.log('warn', `answerCallback failed for ${exec.id}: ${err instanceof Error ? err.message : err}`);
          }
        }
        // "btn:key" port → bare key for the button-meta lookup (menu WaitSpec).
        const key = port.startsWith('btn:') ? port.slice(4) : port;
        const result = await this.deps.executor.resume({
          executionId: exec.id,
          graph: flow.graph,
          flow: { id: flow.id, name: flow.name },
          port,
          items: [callbackItem(event, wait.buttons?.[key])],
        });
        await this.afterRun(flow, event.botId, event.chat.id, exec.id, result.status, result.error);
        return true;
      }

      if (wait.kind === 'reply' && event.kind !== 'callback') {
        const verdict = validateReply(wait, event);
        if (verdict.outcome === 'no_match') continue;
        const flow = await this.flowOf(exec);
        if (!flow) continue;

        if (verdict.outcome === 'invalid') {
          if (wait.retriesLeft > 0) {
            // re-prompt and stay waiting (retry budget decremented durably)
            const updated: WaitSpec = { ...wait, retriesLeft: wait.retriesLeft - 1 };
            await this.deps.store.save({
              id: exec.id,
              status: 'waiting',
              state: exec.state,
              wait: updated,
            });
            if (wait.invalidMessage) {
              await this.deps.sendText(event.botId, event.chat.id, wait.invalidMessage);
            }
            this.log('debug', `execution ${exec.id}: invalid reply, ${updated.retriesLeft} retries left`);
            return true;
          }
          // retries exhausted → invalid port
          const invalidResult = await this.deps.executor.resume({
            executionId: exec.id,
            graph: flow.graph,
            flow: { id: flow.id, name: flow.name },
            port: 'invalid',
            items: [replyItem(event, null)],
          });
          await this.afterRun(flow, event.botId, event.chat.id, exec.id, invalidResult.status, invalidResult.error);
          return true;
        }

        const result = await this.deps.executor.resume({
          executionId: exec.id,
          graph: flow.graph,
          flow: { id: flow.id, name: flow.name },
          port: 'reply',
          items: [replyItem(event, verdict.value)],
          // save_to → $vars (Decision Log #14): the wait node never re-executes
          // on resume, so the router applies its saveTo durably via varsPatch.
          ...(wait.saveTo !== undefined ? { varsPatch: { [wait.saveTo]: verdict.value } } : {}),
        });
        await this.afterRun(flow, event.botId, event.chat.id, exec.id, result.status, result.error);
        return true;
      }
    }
    return false;
  }

  /**
   * Try to resume an armed "listen for one live update" test run (J-T1).
   * True = the event was consumed by a test listen. The arming is a `waiting`
   * execution whose `WaitSpec.kind` is `'trigger'`; it is NOT keyed by chat (a
   * test listen is armed before any chat exists, so it waits for the FIRST
   * message). We match the event against the snapshot `triggerParams` with the
   * SAME pure matcher production uses (`triggerMatches`), then resume the
   * trigger node on `main` with the REAL trigger item — so the captured sender
   * data flows downstream exactly like n8n's "listen for test event". Exactly
   * one update is captured per arming: resuming clears the trigger-wait, so a
   * later update no longer matches it. The same `tg.trigger` node powers both
   * this trial run and a production run — only the run mode differs.
   *
   * Critically this runs BEFORE `tryTriggers`, so a captured update is NOT also
   * delivered to a production run (exactly-once across test vs production).
   */
  private async tryResumeListen(event: TgEvent): Promise<boolean> {
    const armed = await this.deps.store.findListening(event.botId);
    if (armed.length === 0) return false;
    for (const exec of armed) {
      const wait = exec.wait;
      if (!wait || wait.kind !== 'trigger') continue;
      if (!triggerMatches(wait.triggerParams as TriggerParams, event)) continue;
      const flow = await this.flowOf(exec);
      if (!flow) continue;
      // Resume the trigger node: emit the real trigger item on `main`, exactly
      // as a production trigger would, so the next node sees the sender's data.
      const result = await this.deps.executor.resume({
        executionId: exec.id,
        graph: flow.graph,
        flow: { id: flow.id, name: flow.name },
        port: 'main',
        items: [triggerItem(event)],
      });
      this.log(
        'info',
        `test-listen captured ${event.kind} for ${flow.id} → execution ${exec.id} ${result.status}`,
      );
      // A test listen has no chat slot (chatId null) so the per-chat afterRun
      // hooks (error-handler / queue drain) don't apply — mirror the chatless
      // recordChanged/schedule paths and just log the outcome.
      return true;
    }
    return false;
  }

  /** Try to start a flow from a trigger. True = the event was consumed. */
  private async tryTriggers(event: TgEvent): Promise<boolean> {
    const flows = await this.deps.flows.activeFlows(event.botId);
    let best: { flow: RouterFlow; node: FlowNode; priority: number } | null = null;

    for (const flow of flows) {
      for (const node of flow.graph.nodes) {
        if (node.type !== TRIGGER_TYPE || node.disabled) continue;
        const params = node.params as TriggerParams;
        if (!triggerMatches(params, event)) continue;
        const priority = TRIGGER_PRIORITY[params.event ?? 'any_message'] ?? 3;
        if (!best || priority < best.priority) best = { flow, node, priority };
      }
    }
    if (!best) return false;

    // Execution policy (P3-T6): a NEW trigger arriving while THIS flow already
    // has a waiting run in THIS chat. one-waiting-execution-per-(flow,chat).
    const policy = best.flow.settings.executionPolicy;
    if (policy !== 'replace') {
      const waiting = await this.waitingForFlow(event.botId, event.chat.id, best.flow.id);
      if (waiting.length > 0) {
        if (policy === 'ignore') {
          this.log('debug', `trigger ignored — ${best.flow.id} already waiting in chat ${event.chat.id}`);
          return true; // consumed (deliberately dropped)
        }
        // queue: park the trigger; it runs when the waiting run finishes.
        if (this.deps.pending) {
          await this.deps.pending.enqueue({
            botId: event.botId,
            flowId: best.flow.id,
            chatId: event.chat.id,
            entryNodeId: best.node.id,
            userId: String(event.user.id),
            item: triggerItem(event),
          });
          this.log('info', `trigger queued — ${best.flow.id} busy in chat ${event.chat.id}`);
        } else {
          // No queue store wired → degrade to ignore (documented in RouterDeps).
          this.log('debug', `trigger dropped (no queue store) — ${best.flow.id} waiting`);
        }
        return true;
      }
    } else {
      // replace: cancel any waiting run of THIS flow in THIS chat before starting.
      await this.cancelWaitingForFlow(event.botId, event.chat.id, best.flow.id);
    }

    await this.startFlow(best.flow, {
      botId: event.botId,
      chatId: event.chat.id,
      userId: String(event.user.id),
      entryNodeId: best.node.id,
      item: triggerItem(event),
    });
    return true;
  }

  /**
   * Start a flow from a `trigger.callEvent` (Phase E / PE-T3). Like the
   * recordChanged path this has NO implicit chat (chatId null — a voice flow
   * answers over `ctx.call`, not a chat message). The host CallEventBus has
   * already matched the trigger to the live call + event; we just enter the
   * flow at the trigger node with the pre-built item. Never throws — a voice
   * trigger failure must not break the live call or the next event.
   */
  async fireCallEvent(input: {
    flow: RouterFlow;
    entryNodeId: string;
    botId: string;
    item: FlowItem;
  }): Promise<void> {
    const executionId = this.newId();
    try {
      const result = await this.deps.executor.start({
        executionId,
        flow: { id: input.flow.id, name: input.flow.name },
        graph: input.flow.graph,
        botId: input.botId,
        chatId: null,
        userId: null,
        entry: { nodeId: input.entryNodeId, items: { main: [input.item] } },
      });
      this.log(
        'info',
        `callEvent started execution ${executionId} (${input.flow.id}) → ${result.status}`,
      );
    } catch (err) {
      this.log('error', `callEvent start failed for ${input.flow.id}: ${err instanceof Error ? err.message : err}`);
    }
  }

  /**
   * Start a flow from a `collection.recordChanged` trigger (P3.5-T5). Unlike a
   * Telegram trigger this has NO implicit chat (chatId null — the flow must
   * resolve a chat itself if it sends messages, NODES.md). The record-write
   * event bus has already matched the trigger + checked the condition; we just
   * enter the flow at the trigger node with the pre-built item. Never throws —
   * the write that caused the event is already committed.
   */
  async fireRecordChanged(input: {
    flow: RouterFlow;
    entryNodeId: string;
    botId: string;
    item: FlowItem;
  }): Promise<void> {
    const executionId = this.newId();
    try {
      const result = await this.deps.executor.start({
        executionId,
        flow: { id: input.flow.id, name: input.flow.name },
        graph: input.flow.graph,
        botId: input.botId,
        chatId: null,
        userId: null,
        entry: { nodeId: input.entryNodeId, items: { main: [input.item] } },
      });
      this.log(
        'info',
        `recordChanged started execution ${executionId} (${input.flow.id}) → ${result.status}`,
      );
    } catch (err) {
      this.log('error', `recordChanged start failed for ${input.flow.id}: ${err instanceof Error ? err.message : err}`);
    }
  }

  /**
   * Start a flow from a `schedule.trigger` (P4-T2). The host-side Scheduler has
   * already decided this flow's cron fired; we just enter at the trigger node
   * with the pre-built item. A plain schedule has NO implicit chat (chatId null
   * — the flow resolves a chat itself, like recordChanged/webhook); a
   * `for_each_user` fan-out run carries that user's chatId + userId so the
   * Telegram nodes default to messaging them. Never throws — a scheduled run's
   * failure must not stop the Scheduler from firing the next one.
   */
  async fireSchedule(input: {
    flow: RouterFlow;
    entryNodeId: string;
    botId: string;
    item: FlowItem;
    chatId?: number | null;
    userId?: string | null;
  }): Promise<void> {
    const chatId = input.chatId ?? null;
    const userId = input.userId ?? null;
    const run = async (): Promise<void> => {
      const executionId = this.newId();
      try {
        const result = await this.deps.executor.start({
          executionId,
          flow: { id: input.flow.id, name: input.flow.name },
          graph: input.flow.graph,
          botId: input.botId,
          chatId,
          userId,
          entry: { nodeId: input.entryNodeId, items: { main: [input.item] } },
        });
        this.log(
          'info',
          `schedule started execution ${executionId} (${input.flow.id}${chatId === null ? '' : `, chat ${chatId}`}) → ${result.status}`,
        );
        // Post-run hooks (error-handler + queue drain) need a chat slot — they
        // run only for a `for_each_user` per-user run. A chatless schedule run
        // has no per-chat queue and no chat for an error-handler to message
        // (same as the recordChanged path), so its failures are logged only.
        if (chatId !== null) {
          await this.afterRun(input.flow, input.botId, chatId, executionId, result.status, result.error);
        }
      } catch (err) {
        this.log('error', `schedule start failed for ${input.flow.id}: ${err instanceof Error ? err.message : err}`);
      }
    };
    // A per-user run owns that (bot, chat) slot, so serialize it through the
    // same chat lock the Telegram router uses; a chatless run runs free.
    if (chatId === null) await run();
    else await this.withChatLock(`${input.botId}:${chatId}`, run);
  }

  /** Start a flow execution from a trigger entry, then run post-run hooks. */
  private async startFlow(
    flow: RouterFlow,
    entry: { botId: string; chatId: number; userId: string | null; entryNodeId: string; item: FlowItem },
  ): Promise<void> {
    const executionId = this.newId();
    const result = await this.deps.executor.start({
      executionId,
      flow: { id: flow.id, name: flow.name },
      graph: flow.graph,
      botId: entry.botId,
      chatId: entry.chatId,
      userId: entry.userId,
      entry: { nodeId: entry.entryNodeId, items: { main: [entry.item] } },
    });
    this.log('info', `started execution ${executionId} via ${entry.entryNodeId} (${flow.id}) → ${result.status}`);
    await this.afterRun(flow, entry.botId, entry.chatId, executionId, result.status, result.error);
  }

  /**
   * Post-run hooks (P3-T6), run after a start OR a resume reaches a terminal
   * status. (1) on error → fire the flow's error-handler flow; (2) on any
   * terminal status → drain the next queued trigger for this (flow, chat).
   */
  private async afterRun(
    flow: RouterFlow,
    botId: string,
    chatId: number,
    executionId: string,
    status: Execution['status'],
    error: string | null,
  ): Promise<void> {
    if (status === 'error') {
      await this.runErrorHandler(flow, botId, chatId, executionId, error);
    }
    // waiting runs are not terminal — they still own the (flow, chat) slot.
    if (status === 'done' || status === 'error' || status === 'canceled') {
      await this.drainQueue(flow, botId, chatId);
    }
  }

  /** Fire the flow's configured error-handler flow (P3-T6), if any. */
  private async runErrorHandler(
    flow: RouterFlow,
    botId: string,
    chatId: number,
    failedExecutionId: string,
    error: string | null,
  ): Promise<void> {
    const handlerId = flow.settings.errorHandlerFlowId;
    if (!handlerId) return;
    const handler = await this.deps.flows.getFlow(handlerId);
    if (!handler) {
      this.log('warn', `error-handler ${handlerId} for flow ${flow.id} not found — skipped`);
      return;
    }
    // The handler enters at its first enabled trigger node (any trigger — it's
    // an internal invocation, not a real Telegram event). Falls back to nothing
    // if the handler has no trigger.
    const entryNode = handler.graph.nodes.find((n) => n.type === TRIGGER_TYPE && !n.disabled);
    if (!entryNode) {
      this.log('warn', `error-handler ${handlerId} has no enabled trigger — skipped`);
      return;
    }
    const item: FlowItem = {
      json: {
        error: error ?? 'unknown error',
        failedFlowId: flow.id,
        failedFlowName: flow.name,
        failedExecutionId,
      },
    };
    const executionId = this.newId();
    const result = await this.deps.executor.start({
      executionId,
      flow: { id: handler.id, name: handler.name },
      graph: handler.graph,
      botId,
      chatId,
      userId: null,
      entry: { nodeId: entryNode.id, items: { main: [item] } },
    });
    this.log('info', `error-handler ${handlerId} ran for failed ${failedExecutionId} → ${result.status}`);
    // Note: an error-handler that itself errors is NOT re-handled (no recursion).
  }

  /** Drain the next queued trigger for (flow, chat) and run it (P3-T6, queue policy). */
  private async drainQueue(flow: RouterFlow, botId: string, chatId: number): Promise<void> {
    if (!this.deps.pending) return;
    const next = await this.deps.pending.dequeue(botId, flow.id, chatId);
    if (!next) return;
    this.log('info', `draining queued trigger for ${flow.id} in chat ${chatId}`);
    await this.startFlow(flow, {
      botId,
      chatId,
      userId: next.userId,
      entryNodeId: next.entryNodeId,
      item: next.item,
    });
  }

  /** Waiting executions of a SPECIFIC flow in a chat (filters findWaiting by flowId). */
  private async waitingForFlow(botId: string, chatId: number, flowId: string): Promise<Execution[]> {
    const waiting = await this.deps.store.findWaiting({ botId, chatId });
    return waiting.filter((e) => e.flowId === flowId);
  }

  /** Cancel every waiting execution of a specific flow in a chat (replace policy). */
  private async cancelWaitingForFlow(botId: string, chatId: number, flowId: string): Promise<void> {
    for (const exec of await this.waitingForFlow(botId, chatId, flowId)) {
      await this.deps.store.save({ id: exec.id, status: 'canceled', state: exec.state, wait: null });
      this.log('info', `execution ${exec.id} replaced (policy=replace) in chat ${chatId}`);
    }
  }

  private async resumeTimedOut(exec: Execution): Promise<void> {
    const fresh = await this.deps.store.load(exec.id);
    if (!fresh || fresh.status !== 'waiting' || !fresh.wait) return; // already resumed by a reply
    // An armed "listen for one live update" (J-T1) that timed out captured
    // nothing — there's no update to resume with, so DISARM it (cancel) rather
    // than route a fake item downstream. Mirrors the test-listen Cancel button.
    if (fresh.wait.kind === 'trigger') {
      await this.deps.store.save({ id: fresh.id, status: 'canceled', state: fresh.state, wait: null });
      this.log('info', `test-listen ${fresh.id} expired without a capture — disarmed`);
      return;
    }
    const flow = await this.flowOf(fresh);
    if (!flow) return;
    // delays resume on "main" (the wait simply elapsed); reply/callback fire "timeout"
    const port = fresh.wait.kind === 'delay' ? 'main' : 'timeout';
    const result = await this.deps.executor.resume({
      executionId: fresh.id,
      graph: flow.graph,
      flow: { id: flow.id, name: flow.name },
      port,
      items: [{ json: { timedOut: fresh.wait.kind !== 'delay' } }],
    });
    this.log('info', `execution ${fresh.id} resumed via "${port}" after timeout`);
    // Drive error-handler / queue-drain hooks after the timeout resume too.
    // Requires a concrete chat (queue + error-handler are per-chat); skip if null.
    if (fresh.chatId !== null) {
      await this.afterRun(flow, fresh.botId, fresh.chatId, fresh.id, result.status, result.error);
    }
  }

  private async flowOf(exec: Execution): Promise<RouterFlow | null> {
    const flow = await this.deps.flows.getFlow(exec.flowId);
    if (!flow) this.log('warn', `execution ${exec.id} references missing flow ${exec.flowId}`);
    return flow;
  }

  private log(
    level: 'debug' | 'info' | 'warn' | 'error',
    message: string,
    data?: unknown,
  ): void {
    this.deps.log?.(level, message, data);
  }
}
