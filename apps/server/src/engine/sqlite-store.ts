/**
 * SqliteExecutionStore — durable ExecutionStore over Drizzle/SQLite (P1-T3,
 * invariant I4). Every wait state survives a process restart.
 *
 * wait_timeout_at is denormalized from the WaitSpec deadline so the timeout
 * scanner uses the (status, wait_timeout_at) index instead of parsing JSON.
 */
import {
  ExecutionSchema,
  ExecutionStateSchema,
  WaitSpecSchema,
  type Execution,
  type ExecutionState,
} from '@ctb/shared';
import {
  waitDeadline,
  type CreateExecutionInput,
  type ExecutionStore,
  type FindWaitingFilter,
  type SaveExecutionInput,
} from '@ctb/core';
import { and, asc, eq, isNotNull, lte } from 'drizzle-orm';
import type { Db } from '../db/index';
import { executions } from '../db/schema';

type Row = typeof executions.$inferSelect;

function rowToExecution(row: Row): Execution {
  return ExecutionSchema.parse({
    id: row.id,
    flowId: row.flowId,
    botId: row.botId,
    chatId: row.chatId,
    userId: row.userId,
    status: row.status,
    state: ExecutionStateSchema.parse(row.state),
    wait: row.wait === null ? null : WaitSpecSchema.parse(row.wait),
    error: row.error,
    startedAt: row.startedAt,
    updatedAt: row.updatedAt,
  });
}

/** Fired when an execution reaches a terminal status (done/error) — P4-T4. */
export type ExecutionFinishedListener = (execution: Execution) => void;

export class SqliteExecutionStore implements ExecutionStore {
  /** Set by the host AFTER construction (drives outbound execution.* webhooks). */
  private onFinished: ExecutionFinishedListener | null = null;

  constructor(
    private readonly db: Db,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  /**
   * Register a callback fired once per execution when `save()` transitions it
   * to a TERMINAL status (`done` → execution.finished, `error` →
   * execution.failed). Best-effort: a throwing listener never fails the save.
   */
  setFinishedListener(fn: ExecutionFinishedListener | null): void {
    this.onFinished = fn;
  }

  async create(input: CreateExecutionInput): Promise<Execution> {
    const now = this.clock().toISOString();
    const row = {
      id: input.id,
      flowId: input.flowId,
      botId: input.botId,
      chatId: input.chatId ?? null,
      userId: input.userId ?? null,
      status: 'running' as const,
      state: ExecutionStateSchema.parse(input.state),
      wait: null,
      waitTimeoutAt: null,
      error: null,
      startedAt: now,
      updatedAt: now,
    };
    this.db.insert(executions).values(row).run();
    return rowToExecution(row as Row);
  }

  async load(id: string): Promise<Execution | null> {
    const row = this.db.select().from(executions).where(eq(executions.id, id)).get();
    return row ? rowToExecution(row) : null;
  }

  async save(input: SaveExecutionInput): Promise<void> {
    const wait = input.wait ?? null;
    const res = this.db
      .update(executions)
      .set({
        status: input.status,
        state: ExecutionStateSchema.parse(input.state),
        wait: input.wait === undefined ? undefined : wait,
        waitTimeoutAt: input.wait === undefined ? undefined : waitDeadline(wait),
        error: input.error === undefined ? undefined : input.error,
        updatedAt: this.clock().toISOString(),
      })
      .where(eq(executions.id, input.id))
      .run();
    if (res.changes === 0) throw new Error(`execution ${input.id} not found`);

    // Terminal transition → notify the outbound-webhook host (best-effort).
    if ((input.status === 'done' || input.status === 'error') && this.onFinished) {
      const row = this.db.select().from(executions).where(eq(executions.id, input.id)).get();
      if (row) {
        try {
          this.onFinished(rowToExecution(row));
        } catch {
          /* a broken listener must never break the save */
        }
      }
    }
  }

  async checkpoint(id: string, state: ExecutionState): Promise<void> {
    const res = this.db
      .update(executions)
      .set({
        state: ExecutionStateSchema.parse(state),
        updatedAt: this.clock().toISOString(),
      })
      .where(eq(executions.id, id))
      .run();
    if (res.changes === 0) throw new Error(`execution ${id} not found`);
  }

  async findWaiting(filter: FindWaitingFilter): Promise<Execution[]> {
    const rows = this.db
      .select()
      .from(executions)
      .where(
        and(
          eq(executions.status, 'waiting'),
          eq(executions.botId, filter.botId),
          eq(executions.chatId, filter.chatId),
        ),
      )
      .orderBy(asc(executions.updatedAt))
      .all();
    const result = rows.map(rowToExecution);
    return filter.kind === undefined
      ? result
      : result.filter((e) => e.wait?.kind === filter.kind);
  }

  async findListening(botId: string): Promise<Execution[]> {
    // Armed listen-for-one executions for a bot (J-T1). They are `waiting` with
    // a `WaitSpec.kind:'trigger'` and chatId null (no chat yet); the kind lives
    // inside the JSON wait blob, so filter status+bot in SQL then narrow by kind.
    const rows = this.db
      .select()
      .from(executions)
      .where(and(eq(executions.status, 'waiting'), eq(executions.botId, botId)))
      .orderBy(asc(executions.updatedAt))
      .all();
    return rows.map(rowToExecution).filter((e) => e.wait?.kind === 'trigger');
  }

  async listTimedOut(now: Date): Promise<Execution[]> {
    const rows = this.db
      .select()
      .from(executions)
      .where(
        and(
          eq(executions.status, 'waiting'),
          isNotNull(executions.waitTimeoutAt),
          lte(executions.waitTimeoutAt, now.toISOString()),
        ),
      )
      .orderBy(asc(executions.updatedAt))
      .all();
    return rows.map(rowToExecution);
  }
}
