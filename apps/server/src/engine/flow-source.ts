/**
 * SqliteFlowSource — the router's FlowSource over Drizzle (P1-T8).
 *
 * activeFlows() feeds trigger matching (active rows only); getFlow() resolves
 * waiting/timed-out executions' flows REGARDLESS of status, so an in-flight
 * conversation keeps working even if its flow was deactivated mid-wait
 * (the user already started — stranding them would be hostile).
 *
 * Graphs are validated on read: a row whose JSON no longer parses is skipped
 * (activeFlows) or null (getFlow) with a log — never a crash in the router.
 */
import { FlowGraphSchema, type FlowGraph } from '@ctb/shared';
import type { FlowRef } from '@ctb/core';
import { and, eq } from 'drizzle-orm';
import type { Db } from '../db/index';
import { flows } from '../db/schema';
import type { FlowSource } from './router';

type LoadedFlow = FlowRef & { graph: FlowGraph };

export class SqliteFlowSource implements FlowSource {
  constructor(
    private readonly db: Db,
    private readonly log?: (level: 'warn', message: string) => void,
  ) {}

  async activeFlows(botId: string): Promise<LoadedFlow[]> {
    const rows = this.db
      .select()
      .from(flows)
      .where(and(eq(flows.botId, botId), eq(flows.status, 'active')))
      .all();
    const result: LoadedFlow[] = [];
    for (const row of rows) {
      const graph = FlowGraphSchema.safeParse(row.graph);
      if (!graph.success) {
        this.log?.('warn', `flow ${row.id} has an invalid graph — skipped from trigger matching`);
        continue;
      }
      result.push({ id: row.id, name: row.name, graph: graph.data });
    }
    return result;
  }

  async getFlow(flowId: string): Promise<LoadedFlow | null> {
    const row = this.db.select().from(flows).where(eq(flows.id, flowId)).get();
    if (!row) return null;
    const graph = FlowGraphSchema.safeParse(row.graph);
    if (!graph.success) {
      this.log?.('warn', `flow ${row.id} has an invalid graph — resume impossible`);
      return null;
    }
    return { id: row.id, name: row.name, graph: graph.data };
  }
}
