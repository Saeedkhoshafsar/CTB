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
import type { Execution, FlowGraph, FlowItem, FlowNode, WaitSpec } from '@ctb/shared';
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

/** Where the router finds flows. Server impl arrives with the bots API (P1-T8). */
export interface FlowSource {
  /** Active flows for a bot — trigger matching scans their graphs. */
  activeFlows(botId: string): Promise<Array<FlowRef & { graph: FlowGraph }>>;
  /** Flow by id — needed to resume waiting/timed-out executions. */
  getFlow(flowId: string): Promise<(FlowRef & { graph: FlowGraph }) | null>;
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
        await this.deps.executor.resume({
          executionId: exec.id,
          graph: flow.graph,
          flow: { id: flow.id, name: flow.name },
          port,
          items: [callbackItem(event, wait.buttons?.[key])],
        });
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
          await this.deps.executor.resume({
            executionId: exec.id,
            graph: flow.graph,
            flow: { id: flow.id, name: flow.name },
            port: 'invalid',
            items: [replyItem(event, null)],
          });
          return true;
        }

        await this.deps.executor.resume({
          executionId: exec.id,
          graph: flow.graph,
          flow: { id: flow.id, name: flow.name },
          port: 'reply',
          items: [replyItem(event, verdict.value)],
          // save_to → $vars (Decision Log #14): the wait node never re-executes
          // on resume, so the router applies its saveTo durably via varsPatch.
          ...(wait.saveTo !== undefined ? { varsPatch: { [wait.saveTo]: verdict.value } } : {}),
        });
        return true;
      }
    }
    return false;
  }

  /** Try to start a flow from a trigger. True = execution started. */
  private async tryTriggers(event: TgEvent): Promise<boolean> {
    const flows = await this.deps.flows.activeFlows(event.botId);
    let best: { flow: FlowRef & { graph: FlowGraph }; node: FlowNode; priority: number } | null =
      null;

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

    const result = await this.deps.executor.start({
      executionId: this.newId(),
      flow: { id: best.flow.id, name: best.flow.name },
      graph: best.flow.graph,
      botId: event.botId,
      chatId: event.chat.id,
      userId: String(event.user.id),
      entry: { nodeId: best.node.id, items: { main: [triggerItem(event)] } },
    });
    this.log('info', `started execution via ${best.node.id} (${best.flow.id}) → ${result.status}`);
    return true;
  }

  private async resumeTimedOut(exec: Execution): Promise<void> {
    const fresh = await this.deps.store.load(exec.id);
    if (!fresh || fresh.status !== 'waiting' || !fresh.wait) return; // already resumed by a reply
    const flow = await this.flowOf(fresh);
    if (!flow) return;
    // delays resume on "main" (the wait simply elapsed); reply/callback fire "timeout"
    const port = fresh.wait.kind === 'delay' ? 'main' : 'timeout';
    await this.deps.executor.resume({
      executionId: fresh.id,
      graph: flow.graph,
      flow: { id: flow.id, name: flow.name },
      port,
      items: [{ json: { timedOut: fresh.wait.kind !== 'delay' } }],
    });
    this.log('info', `execution ${fresh.id} resumed via "${port}" after timeout`);
  }

  private async flowOf(exec: Execution): Promise<(FlowRef & { graph: FlowGraph }) | null> {
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
