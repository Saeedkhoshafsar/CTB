/**
 * Run-data mapping (P2-T3.5) — pure, DOM-free.
 *
 * Turns an execution's step log into a per-node I/O lookup for the node
 * detail view (NDV): for every canvas node, what items entered it and what
 * it emitted per port on the LATEST visit (a node revisited in a loop shows
 * its most recent run — same as n8n).
 */
import type { ExecLogEntry, FlowItem } from '@ctb/shared';

export interface NodeRunData {
  input: FlowItem[];
  output: Record<string, FlowItem[]>;
  durationMs: number | null;
  ts: string;
}

/** Last "executed" row per node wins. Rows without I/O snapshots are skipped. */
export function mapRunData(logs: ExecLogEntry[]): Map<string, NodeRunData> {
  const byNode = new Map<string, NodeRunData>();
  for (const row of logs) {
    if (row.nodeId === null || row.input === null) continue;
    byNode.set(row.nodeId, {
      input: row.input,
      output: row.output ?? {},
      durationMs: row.durationMs,
      ts: row.ts,
    });
  }
  return byNode;
}

/**
 * H-T3 (gap G15) — per-node error lookup for the canvas "glow red" overlay.
 *
 * A failed node's row carries `level: 'error'` and usually has NO input/output
 * snapshot, so {@link mapRunData} deliberately skips it — this pass keeps
 * exactly those rows. The message prefers the structured `error` column and
 * falls back to the human `message`; the LAST error row per node wins (a node
 * revisited in a loop reports its most recent failure, matching mapRunData's
 * "latest visit" semantics). Pure + DOM-free so it unit-tests in isolation.
 */
export function mapRunErrors(logs: ExecLogEntry[]): Map<string, string> {
  const byNode = new Map<string, string>();
  for (const row of logs) {
    if (row.nodeId === null || row.level !== 'error') continue;
    const msg = (row.error ?? row.message ?? '').trim();
    byNode.set(row.nodeId, msg || 'error');
  }
  return byNode;
}

/**
 * Defensive coercion for run-data the data panes render (crash-hardening).
 *
 * The NDV/side-panel used to crash the WHOLE app to a black screen when a run
 * payload wasn't shaped as `FlowItem[]` / `{ json: object }` (e.g. a node that
 * emitted a primitive, or a half-written execution row). These two helpers make
 * the render total: never throw, always hand the UI an array of `{json:object}`.
 * Pure + DOM-free so they unit-test directly.
 */
export function safeItemJson(item: unknown): Record<string, unknown> {
  const j = (item as { json?: unknown } | null | undefined)?.json;
  return j !== null && typeof j === 'object' && !Array.isArray(j)
    ? (j as Record<string, unknown>)
    : {};
}

export function safeItems(items: unknown): FlowItem[] {
  return Array.isArray(items) ? (items as FlowItem[]) : [];
}

/** Schema cap on pinned items (mirrors `FlowNodeSchema.pinnedData.max(50)`). */
export const PIN_ITEMS_CAP = 50;

/**
 * I-T1 (gap G4) — flatten a node's per-port run OUTPUT into the flat
 * `FlowItem[]` we pin onto the node. Pure + DOM-free so it unit-tests directly.
 *
 * The engine replays a pin on the universal `main` port (executor short-circuit),
 * so a multi-port node's pin is the concatenation of every port's items in a
 * stable port order (`main` first if present, then the rest as encountered).
 * Capped at {@link PIN_ITEMS_CAP} to satisfy the schema — a pin is a sample,
 * not a dataset. Returns `null` when there is nothing to pin (no output items),
 * so the caller can disable the Pin action.
 */
export function flattenOutputForPin(
  output: Record<string, FlowItem[]> | null | undefined,
): FlowItem[] | null {
  if (!output) return null;
  const ports = Object.keys(output);
  // main first (the port the engine replays on), then the rest in object order
  ports.sort((a, b) => (a === 'main' ? -1 : b === 'main' ? 1 : 0));
  const flat: FlowItem[] = [];
  for (const port of ports) {
    for (const it of output[port] ?? []) {
      flat.push(it);
      if (flat.length >= PIN_ITEMS_CAP) return flat;
    }
  }
  return flat.length > 0 ? flat : null;
}
