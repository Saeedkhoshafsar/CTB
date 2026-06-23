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
