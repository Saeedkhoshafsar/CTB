/**
 * ExecutionStore — the durability contract behind pause/resume (P1-T3,
 * invariant I4). The executor talks ONLY to this interface; the server
 * provides the SQLite implementation, tests use the in-memory one.
 */
import type { Execution, ExecutionState, ExecutionStatus, WaitSpec } from '@ctb/shared';

export interface CreateExecutionInput {
  id: string;
  flowId: string;
  botId: string;
  chatId?: number | null;
  userId?: string | null;
  state: ExecutionState;
}

export interface SaveExecutionInput {
  id: string;
  status: ExecutionStatus;
  state: ExecutionState;
  wait?: WaitSpec | null;
  error?: string | null;
}

export interface FindWaitingFilter {
  botId: string;
  chatId: number;
  /** Restrict by wait kind (e.g. router matching a callback vs a reply). */
  kind?: WaitSpec['kind'];
}

export interface ExecutionStore {
  /** Insert a new execution in `running` status. */
  create(input: CreateExecutionInput): Promise<Execution>;

  /** Load by id; null when missing. */
  load(id: string): Promise<Execution | null>;

  /** Full state save (status transition, wait set/cleared, error). */
  save(input: SaveExecutionInput): Promise<void>;

  /** Lightweight mid-run persistence: state only, status untouched. */
  checkpoint(id: string, state: ExecutionState): Promise<void>;

  /**
   * Waiting executions for a chat, oldest-first (the update router resumes
   * the first match — ARCHITECTURE §7).
   */
  findWaiting(filter: FindWaitingFilter): Promise<Execution[]>;

  /** Waiting executions whose wait timeout/resume time has passed. */
  listTimedOut(now: Date): Promise<Execution[]>;
}

/** Wait deadline (timeoutAt for reply/callback, resumeAt for delay) or null. */
export function waitDeadline(wait: WaitSpec | null | undefined): string | null {
  if (!wait) return null;
  if (wait.kind === 'delay') return wait.resumeAt;
  return wait.timeoutAt ?? null;
}
