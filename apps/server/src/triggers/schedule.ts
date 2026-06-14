/**
 * Scheduler — the host side of the `schedule.trigger` node (P4-T2, NODES.md
 * §Schedule Trigger, ROADMAP Phase 4).
 *
 * For every ACTIVE flow that contains an enabled `schedule.trigger`, the
 * Scheduler runs one croner job evaluated in the node's `timezone`. When a job
 * fires it:
 *   1. builds the trigger item `{ now, cron, timezone, scheduled: true }`,
 *   2. EITHER starts a single chatless run (no implicit chat — the flow must
 *      resolve a chat itself, like recordChanged/webhook),
 *   3. OR, when `for_each_user` is set, fans out one run per KNOWN bot user —
 *      each run carries that user's chatId + userId so the Telegram nodes
 *      default to messaging them — throttled to `rate_per_min` starts/minute.
 *
 * The Scheduler is RECONCILED against the database: `reconcile()` diffs the
 * desired job set (derived from active flows) against the running jobs, so it
 * is safe to call on boot and again whenever a flow is activated/deactivated or
 * edited. Jobs are keyed by a fingerprint of everything that affects their
 * behaviour, so an edit to the cron/tz/mode tears down the stale job and starts
 * a fresh one. Croner owns the timer; we never use setInterval ourselves.
 *
 * Like the timeout scanner and the record-event bus, a firing failure is
 * contained (logged) and never crashes the process.
 */
import {
  ScheduleTriggerParamsSchema,
  type FlowItem,
  type ScheduleTriggerParams,
} from '@ctb/shared';
import { Cron } from 'croner';
import type { Db } from '../db/index';
import { bots } from '../db/schema';
import type { SqliteFlowSource } from '../engine/flow-source';
import type { RouterFlow, UpdateRouter } from '../engine/router';
import type { SqliteUserStore } from '../engine/user-store';

const TRIGGER_TYPE = 'schedule.trigger';

/** Max users pulled per fan-out (a safety cap; rate_per_min still paces sends). */
const FAN_OUT_USER_CAP = 5000;

export interface SchedulerDeps {
  db: Db;
  flowSource: SqliteFlowSource;
  router: UpdateRouter;
  userStore: SqliteUserStore;
  log?: (level: 'debug' | 'info' | 'warn' | 'error', message: string, data?: unknown) => void;
  /** Test seam — the "now" stamped into the trigger item. */
  clock?: () => Date;
}

/** A scheduled job the Scheduler is running. */
interface ScheduledJob {
  fingerprint: string;
  botId: string;
  flowId: string;
  nodeId: string;
  cron: Cron;
}

/**
 * A desired schedule derived from an active flow's `schedule.trigger` node —
 * everything the Scheduler needs to run it, plus the fingerprint that decides
 * whether a running job is still current.
 */
interface DesiredSchedule {
  fingerprint: string;
  botId: string;
  flow: RouterFlow;
  nodeId: string;
  params: ScheduleTriggerParams;
}

export class Scheduler {
  private readonly jobs = new Map<string, ScheduledJob>();
  private readonly clock: () => Date;

  constructor(private readonly deps: SchedulerDeps) {
    this.clock = deps.clock ?? (() => new Date());
  }

  /** Begin reconciling (idempotent). Call once on boot after flows exist. */
  start(): void {
    void this.reconcile();
  }

  /** Stop every job and clear state. Idempotent. */
  stop(): void {
    for (const job of this.jobs.values()) job.cron.stop();
    this.jobs.clear();
  }

  /** Number of live cron jobs (tests / introspection). */
  get jobCount(): number {
    return this.jobs.size;
  }

  /**
   * Diff the desired schedule set (from active flows) against the running jobs:
   * stop jobs whose flow/node/cron/tz/mode changed or vanished, and start jobs
   * that are new. Safe to call repeatedly. Never throws — a single bad flow is
   * skipped, not fatal.
   */
  async reconcile(): Promise<void> {
    let desired: DesiredSchedule[];
    try {
      desired = await this.collectDesired();
    } catch (err) {
      this.log('error', `schedule reconcile failed to read flows: ${err instanceof Error ? err.message : err}`);
      return;
    }
    const desiredByFp = new Map(desired.map((d) => [d.fingerprint, d]));

    // Drop jobs no longer desired.
    for (const [fp, job] of this.jobs) {
      if (!desiredByFp.has(fp)) {
        job.cron.stop();
        this.jobs.delete(fp);
        this.log('info', `schedule stopped (${job.flowId}/${job.nodeId})`);
      }
    }

    // Start newly-desired jobs.
    for (const d of desired) {
      if (this.jobs.has(d.fingerprint)) continue;
      this.startJob(d);
    }
  }

  // ── internals ──────────────────────────────────────────────────────────────

  /** All `schedule.trigger` nodes across every bot's ACTIVE flows. */
  private async collectDesired(): Promise<DesiredSchedule[]> {
    const out: DesiredSchedule[] = [];
    const botRows = this.deps.db.select({ id: bots.id }).from(bots).all();
    for (const { id: botId } of botRows) {
      const flows = await this.deps.flowSource.activeFlows(botId);
      for (const flow of flows) {
        for (const node of flow.graph.nodes) {
          if (node.type !== TRIGGER_TYPE || node.disabled) continue;
          const parsed = ScheduleTriggerParamsSchema.safeParse(node.params);
          if (!parsed.success) {
            this.log('warn', `schedule.trigger ${flow.id}/${node.id} has invalid params — skipped`);
            continue;
          }
          const params = parsed.data;
          out.push({
            fingerprint: fingerprintOf(flow.id, node.id, params),
            botId,
            flow,
            nodeId: node.id,
            params,
          });
        }
      }
    }
    return out;
  }

  /** Construct + register a croner job for a desired schedule. */
  private startJob(d: DesiredSchedule): void {
    const tz = d.params.timezone.trim();
    let cron: Cron;
    try {
      cron = new Cron(
        d.params.cron,
        { ...(tz ? { timezone: tz } : {}) },
        () => void this.fire(d.botId, d.flow.id, d.nodeId),
      );
    } catch (err) {
      // An invalid cron/timezone string must not abort reconcile — log + skip.
      this.log('warn', `schedule.trigger ${d.flow.id}/${d.nodeId} invalid cron "${d.params.cron}"${tz ? ` tz "${tz}"` : ''}: ${err instanceof Error ? err.message : err}`);
      return;
    }
    this.jobs.set(d.fingerprint, {
      fingerprint: d.fingerprint,
      botId: d.botId,
      flowId: d.flow.id,
      nodeId: d.nodeId,
      cron,
    });
    this.log('info', `schedule started (${d.flow.id}/${d.nodeId}) cron="${d.params.cron}"${tz ? ` tz=${tz}` : ''}${d.params.for_each_user ? ' for_each_user' : ''}`);
  }

  /**
   * A job fired — re-read the flow (it may have been edited/deactivated since
   * the job was created) and dispatch. Public so tests can fire deterministically
   * without waiting on the wall clock.
   */
  async fire(botId: string, flowId: string, nodeId: string): Promise<void> {
    try {
      const flow = await this.deps.flowSource.getFlow(flowId);
      if (!flow) return; // deactivated/deleted mid-flight — reconcile will drop the job
      const node = flow.graph.nodes.find((n) => n.id === nodeId && n.type === TRIGGER_TYPE && !n.disabled);
      if (!node) return;
      const parsed = ScheduleTriggerParamsSchema.safeParse(node.params);
      if (!parsed.success) return;
      const params = parsed.data;

      if (params.for_each_user) {
        await this.fanOut(botId, flow, nodeId, params);
      } else {
        await this.deps.router.fireSchedule({
          flow,
          entryNodeId: nodeId,
          botId,
          item: this.buildItem(params),
        });
      }
    } catch (err) {
      this.log('error', `schedule fire failed for ${flowId}/${nodeId}: ${err instanceof Error ? err.message : err}`);
    }
  }

  /**
   * Fan out one run per known bot user, paced to `rate_per_min` starts/minute
   * (0 = unlimited). Each run's chat = the user's tg id, so the flow's Telegram
   * nodes default to messaging that user.
   */
  private async fanOut(
    botId: string,
    flow: RouterFlow,
    nodeId: string,
    params: ScheduleTriggerParams,
  ): Promise<void> {
    const users = this.deps.userStore.list(botId, { limit: FAN_OUT_USER_CAP });
    if (users.length === 0) return;
    const rate = params.rate_per_min;
    const gapMs = rate > 0 ? Math.ceil(60_000 / rate) : 0;
    this.log('info', `schedule fan-out ${flow.id}/${nodeId} → ${users.length} users${rate > 0 ? ` @ ${rate}/min` : ''}`);

    let started = 0;
    for (const { user } of users) {
      const item = this.buildItem(params, {
        id: user.tgUserId,
        profile: user.profile,
        tags: user.tags,
      });
      await this.deps.router.fireSchedule({
        flow,
        entryNodeId: nodeId,
        botId,
        item,
        chatId: user.tgUserId,
        userId: String(user.tgUserId),
      });
      started += 1;
      if (gapMs > 0 && started < users.length) await delay(gapMs);
    }
  }

  /** Build the scheduled trigger item; `user` only present on a fan-out run. */
  private buildItem(params: ScheduleTriggerParams, user?: Record<string, unknown>): FlowItem {
    const json: Record<string, unknown> = {
      now: this.clock().toISOString(),
      cron: params.cron,
      timezone: params.timezone || null,
      scheduled: true,
    };
    if (user) json.user = user;
    return { json };
  }

  private log(level: 'debug' | 'info' | 'warn' | 'error', message: string, data?: unknown): void {
    this.deps.log?.(level, message, data);
  }
}

/** A job's identity: flow + node + everything that changes its behaviour. */
function fingerprintOf(flowId: string, nodeId: string, params: ScheduleTriggerParams): string {
  return [
    flowId,
    nodeId,
    params.cron,
    params.timezone,
    params.for_each_user ? '1' : '0',
    String(params.rate_per_min),
  ].join('\u0000');
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
