/**
 * SQLite-backed pending-trigger queue (P3-T6, queue execution policy).
 *
 * When a flow's `executionPolicy` is `queue` and a NEW trigger arrives while
 * that flow already has a WAITING run in the same chat, the router parks the
 * trigger here instead of starting/replacing/dropping it. Once the waiting run
 * reaches a terminal status the router drains the OLDEST parked trigger (FIFO,
 * ordered by the autoincrement id) and starts it.
 *
 * The table is the durable backing store for {@link PendingTriggerStore} — the
 * router never touches Drizzle directly (invariant I3: side effects injected).
 */
import { asc, eq, and } from 'drizzle-orm';
import type { FlowItem } from '@ctb/shared';
import type { Db } from '../db/index';
import { pendingTriggers } from '../db/schema';
import type { PendingTriggerStore } from './router';

export class SqlitePendingTriggerStore implements PendingTriggerStore {
  constructor(
    private readonly db: Db,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async enqueue(t: {
    botId: string;
    flowId: string;
    chatId: number;
    entryNodeId: string;
    userId: string | null;
    item: FlowItem;
  }): Promise<void> {
    this.db
      .insert(pendingTriggers)
      .values({
        botId: t.botId,
        flowId: t.flowId,
        chatId: t.chatId,
        entryNodeId: t.entryNodeId,
        userId: t.userId,
        item: t.item,
        createdAt: this.clock().toISOString(),
      })
      .run();
  }

  /** Pop the OLDEST parked trigger for (bot, flow, chat), or null when empty. */
  async dequeue(
    botId: string,
    flowId: string,
    chatId: number,
  ): Promise<{ entryNodeId: string; userId: string | null; item: FlowItem } | null> {
    const where = and(
      eq(pendingTriggers.botId, botId),
      eq(pendingTriggers.flowId, flowId),
      eq(pendingTriggers.chatId, chatId),
    );
    const row = this.db
      .select()
      .from(pendingTriggers)
      .where(where)
      .orderBy(asc(pendingTriggers.id))
      .limit(1)
      .get();
    if (!row) return null;
    this.db.delete(pendingTriggers).where(eq(pendingTriggers.id, row.id)).run();
    return {
      entryNodeId: row.entryNodeId,
      userId: row.userId ?? null,
      item: row.item as FlowItem,
    };
  }
}
