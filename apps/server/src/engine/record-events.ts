/**
 * Record-write event bus (P3.5-T5, ARCHITECTURE §13.6) — the host side of the
 * `collection.recordChanged` trigger.
 *
 * Every record write — from the admin panel / records API, OR from a
 * `data.collection` node — funnels through `RecordEventBus.emit()`. The bus:
 *   1. resolves the collection's bot + slug,
 *   2. scans that bot's ACTIVE flows for `collection.recordChanged` trigger
 *      nodes watching this slug + this event kind (+ field_filter on update),
 *   3. evaluates the optional `condition` expression against the new record,
 *   4. applies the depth-1 LOOP GUARD (a write performed BY a flow does not
 *      re-trigger that same flow — `originFlowId`), and
 *   5. starts each surviving flow via the router (no implicit chat → chatId null;
 *      the flow must resolve a chat itself, NODES.md).
 *
 * `suppressEvents` writes never reach the bus (the caller skips `emit`).
 *
 * The matcher half is PURE (`matchRecordChanged`) so it unit-tests without a
 * store/executor; the bus wires it to the real flow source + router.
 */
import { RecordChangedParamsSchema, type FlowItem, type RecordChangedParams } from '@ctb/shared';
import { buildScope, evaluateTemplate } from '@ctb/core';
import type { SqliteCollectionStore } from '../collections/store';
import type { SqliteFlowSource } from './flow-source';
import type { UpdateRouter } from './router';

/** The write kinds a recordChanged trigger can fire on. */
export type RecordChangeKind = 'created' | 'updated' | 'deleted';

/** Where the write came from — provenance carried into the trigger item (§13.6). */
export type RecordChangeSource = 'panel' | 'api' | 'flow';

/** A record-write event handed to the bus. */
export interface RecordChangeEvent {
  /** Collection id (the bus resolves bot + slug from it). */
  collectionId: string;
  kind: RecordChangeKind;
  /** The record AFTER the write (for delete: the record as it was, last seen). */
  record: Record<string, unknown>;
  recordId: string;
  /** updated-only: the record BEFORE the write (drives field_filter + $json.previous). */
  previous?: Record<string, unknown>;
  source: RecordChangeSource;
  /**
   * The flow that performed this write, if any (data.collection sets it). The
   * loop guard skips a trigger whose own flow id equals this — a flow's writes
   * never re-trigger itself (depth 1, NODES.md).
   */
  originFlowId?: string | null;
}

const TRIGGER_TYPE = 'collection.recordChanged';

/**
 * PURE: does a recordChanged trigger's params match this event? Checks the
 * collection slug, the event kind, and (updated-only) the field_filter — i.e.
 * everything decidable WITHOUT evaluating the condition expression. The
 * condition is evaluated separately by the bus (it needs the async evaluator).
 */
export function matchRecordChanged(
  params: RecordChangedParams,
  ev: { slug: string; kind: RecordChangeKind; changedFields: string[] },
): boolean {
  if (params.collection !== ev.slug) return false;
  if (!params.events.includes(ev.kind)) return false;
  // field_filter only constrains updates: fire only when one of the listed
  // fields actually changed. Empty filter ⇒ any change qualifies.
  if (ev.kind === 'updated' && params.field_filter.length > 0) {
    if (!params.field_filter.some((f) => ev.changedFields.includes(f))) return false;
  }
  return true;
}

/** Top-level keys whose value differs between previous and next (shallow, JSON-equal). */
export function changedFields(
  previous: Record<string, unknown> | undefined,
  next: Record<string, unknown>,
): string[] {
  if (!previous) return Object.keys(next);
  const keys = new Set([...Object.keys(previous), ...Object.keys(next)]);
  const out: string[] = [];
  for (const k of keys) {
    if (JSON.stringify(previous[k]) !== JSON.stringify(next[k])) out.push(k);
  }
  return out;
}

export interface RecordEventBusDeps {
  store: SqliteCollectionStore;
  flowSource: SqliteFlowSource;
  router: UpdateRouter;
  log?: (level: 'debug' | 'info' | 'warn' | 'error', message: string, data?: unknown) => void;
}

export class RecordEventBus {
  constructor(private readonly deps: RecordEventBusDeps) {}

  /**
   * Fire `collection.recordChanged` triggers for a write. Never throws — a
   * trigger-dispatch failure must not break the write that caused it (the row
   * is already committed). Returns the number of flows started (for tests).
   */
  async emit(event: RecordChangeEvent): Promise<number> {
    try {
      return await this.dispatch(event);
    } catch (err) {
      this.deps.log?.('warn', `recordChanged dispatch failed: ${err instanceof Error ? err.message : err}`);
      return 0;
    }
  }

  private async dispatch(event: RecordChangeEvent): Promise<number> {
    const col = this.deps.store.get(event.collectionId);
    if (!col) return 0; // collection vanished — nothing to trigger
    const fields = changedFields(event.previous, event.record);

    const flows = await this.deps.flowSource.activeFlows(col.botId);
    let started = 0;
    for (const flow of flows) {
      // Loop guard (depth 1): a write performed by THIS flow doesn't re-trigger it.
      if (event.originFlowId && event.originFlowId === flow.id) continue;

      for (const node of flow.graph.nodes) {
        if (node.type !== TRIGGER_TYPE || node.disabled) continue;
        const parsed = RecordChangedParamsSchema.safeParse(node.params);
        if (!parsed.success) continue;
        const params = parsed.data;
        if (!matchRecordChanged(params, { slug: col.slug, kind: event.kind, changedFields: fields })) {
          continue;
        }

        const item = this.buildItem(event);
        // Optional condition — evaluated against the trigger item ($json).
        if (params.condition !== undefined && params.condition.trim() !== '') {
          const ok = await this.evalCondition(params.condition, item.json);
          if (!ok) continue;
        }

        await this.deps.router.fireRecordChanged({
          flow,
          entryNodeId: node.id,
          botId: col.botId,
          item,
        });
        started += 1;
        // A flow may have several matching triggers; we only enter once per flow
        // per event (the first matching trigger node wins).
        break;
      }
    }
    return started;
  }

  private buildItem(event: RecordChangeEvent): FlowItem {
    const json: Record<string, unknown> = {
      event: event.kind,
      record: event.record,
      record_id: event.recordId,
      source: event.source,
    };
    if (event.kind === 'updated' && event.previous !== undefined) {
      json.previous = event.previous;
    }
    return { json };
  }

  /** Evaluate a `{{ }}` condition against the trigger item; truthy ⇒ fire. */
  private async evalCondition(condition: string, itemJson: Record<string, unknown>): Promise<boolean> {
    try {
      const scope = buildScope({ json: itemJson });
      const res = await evaluateTemplate(condition, scope);
      return toBool(res.value);
    } catch (err) {
      this.deps.log?.('warn', `recordChanged condition failed: ${err instanceof Error ? err.message : err}`);
      return false;
    }
  }
}

/** Coerce a condition result to boolean (string "false"/"" → false). */
function toBool(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return value !== '' && value !== 'false' && value !== '0';
  if (typeof value === 'number') return value !== 0;
  return Boolean(value);
}
