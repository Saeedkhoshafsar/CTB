/**
 * In-memory ExecutionStore — reference implementation for engine tests
 * (P1-T3). Mirrors the SQLite implementation's semantics exactly, including
 * JSON round-tripping (structuredClone) so accidental object sharing or
 * non-serializable state shows up in tests, not in production.
 */
import { ExecutionSchema, type Execution, type ExecutionState } from '@ctb/shared';
import {
  waitDeadline,
  type CreateExecutionInput,
  type ExecutionStore,
  type FindWaitingFilter,
  type SaveExecutionInput,
} from './types';

export class MemoryExecutionStore implements ExecutionStore {
  private readonly rows = new Map<string, Execution>();
  private clock: () => Date;

  constructor(clock: () => Date = () => new Date()) {
    this.clock = clock;
  }

  async create(input: CreateExecutionInput): Promise<Execution> {
    if (this.rows.has(input.id)) throw new Error(`execution ${input.id} already exists`);
    const now = this.clock().toISOString();
    const row = ExecutionSchema.parse({
      id: input.id,
      flowId: input.flowId,
      botId: input.botId,
      chatId: input.chatId ?? null,
      userId: input.userId ?? null,
      status: 'running',
      state: input.state,
      wait: null,
      error: null,
      startedAt: now,
      updatedAt: now,
    });
    this.rows.set(row.id, structuredClone(row));
    return structuredClone(row);
  }

  async load(id: string): Promise<Execution | null> {
    const row = this.rows.get(id);
    return row ? structuredClone(row) : null;
  }

  async save(input: SaveExecutionInput): Promise<void> {
    const row = this.rows.get(input.id);
    if (!row) throw new Error(`execution ${input.id} not found`);
    const next: Execution = {
      ...row,
      status: input.status,
      state: structuredClone(input.state),
      wait: input.wait === undefined ? row.wait : structuredClone(input.wait),
      error: input.error === undefined ? row.error : input.error,
      updatedAt: this.clock().toISOString(),
    };
    this.rows.set(input.id, ExecutionSchema.parse(next));
  }

  async checkpoint(id: string, state: ExecutionState): Promise<void> {
    const row = this.rows.get(id);
    if (!row) throw new Error(`execution ${id} not found`);
    row.state = structuredClone(state);
    row.updatedAt = this.clock().toISOString();
  }

  async findWaiting(filter: FindWaitingFilter): Promise<Execution[]> {
    return [...this.rows.values()]
      .filter(
        (r) =>
          r.status === 'waiting' &&
          r.botId === filter.botId &&
          r.chatId === filter.chatId &&
          (filter.kind === undefined || r.wait?.kind === filter.kind),
      )
      .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))
      .map((r) => structuredClone(r));
  }

  async findListening(botId: string): Promise<Execution[]> {
    return [...this.rows.values()]
      .filter((r) => r.status === 'waiting' && r.botId === botId && r.wait?.kind === 'trigger')
      .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))
      .map((r) => structuredClone(r));
  }

  async listTimedOut(now: Date): Promise<Execution[]> {
    const cutoff = now.toISOString();
    return [...this.rows.values()]
      .filter((r) => {
        if (r.status !== 'waiting') return false;
        const deadline = waitDeadline(r.wait);
        return deadline !== null && deadline <= cutoff;
      })
      .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))
      .map((r) => structuredClone(r));
  }
}
