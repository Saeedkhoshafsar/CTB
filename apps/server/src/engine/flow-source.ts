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
import {
  FlowGraphSchema,
  FlowSettingsSchema,
  defaultFlowSettings,
  type FlowGraph,
  type FlowSettings,
} from '@ctb/shared';
import type { FlowRef } from '@ctb/core';
import { and, eq } from 'drizzle-orm';
import type { Db } from '../db/index';
import { flows } from '../db/schema';
import type { FlowSource } from './router';

/** A flow loaded for the router — graph + per-flow settings (policy/error-handler, P3-T6). */
type LoadedFlow = FlowRef & { graph: FlowGraph; settings: FlowSettings };

/** Stored settings JSON → typed FlowSettings, defaulting anything missing/legacy. */
function readSettings(raw: unknown): FlowSettings {
  const parsed = FlowSettingsSchema.safeParse(raw ?? {});
  return parsed.success ? parsed.data : defaultFlowSettings();
}

/** A flow loaded for sub-flow execution — carries its owning bot for the same-bot guard (P3-T1). */
export type LoadedSubFlow = LoadedFlow & { botId: string };

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
      result.push({ id: row.id, name: row.name, graph: graph.data, settings: readSettings(row.settings) });
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
    return { id: row.id, name: row.name, graph: graph.data, settings: readSettings(row.settings) };
  }

  /**
   * Load a flow for sub-flow execution (flow.executeSubFlow, P3-T1). Like
   * getFlow but ALSO returns the owning botId so the host can enforce the
   * same-bot guard. Status-agnostic: a sub-flow library flow is typically a
   * draft (never activated on its own) — it exists only to be called.
   */
  async loadSubFlow(flowId: string): Promise<LoadedSubFlow | null> {
    const row = this.db.select().from(flows).where(eq(flows.id, flowId)).get();
    if (!row) return null;
    const graph = FlowGraphSchema.safeParse(row.graph);
    if (!graph.success) {
      this.log?.('warn', `sub-flow ${row.id} has an invalid graph — cannot execute`);
      return null;
    }
    return {
      id: row.id,
      name: row.name,
      graph: graph.data,
      settings: readSettings(row.settings),
      botId: row.botId,
    };
  }
}
