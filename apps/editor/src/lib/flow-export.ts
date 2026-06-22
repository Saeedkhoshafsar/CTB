/**
 * Flow-export helpers (PLAN3 F-T3) — shared by the flow LIST page and the flow
 * EDITOR toolbar so "export this flow as JSON" behaves identically wherever the
 * user reaches for it.
 *
 * Split into a PURE part (`flowExportFilename`, `flowExportBlob`) that is unit-
 * testable with no DOM, and a thin DOM `downloadFlowExport` that wires the blob
 * to a browser download. The editor's #1 discoverability complaint was "how do
 * I extract a workflow?" — this keeps the answer one button-click away in both
 * places without duplicating the (easy-to-get-wrong) filename/blob logic.
 */
import type { FlowExport } from '@ctb/shared';

/**
 * Turn a human flow name into a safe `*.json` download filename.
 * Non-word characters collapse to `_`; an empty/blank name falls back to `flow`.
 * Pure — no DOM, no globals — so it can be asserted directly in tests.
 */
export function flowExportFilename(flowName: string): string {
  const base = flowName.replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '');
  return `${base || 'flow'}.json`;
}

/** Serialize an export envelope to a pretty-printed JSON Blob (application/json). */
export function flowExportBlob(envelope: FlowExport): Blob {
  return new Blob([JSON.stringify(envelope, null, 2)], { type: 'application/json' });
}

/**
 * Trigger a browser download of the given flow export envelope.
 * Thin DOM glue over the pure helpers above; safe to call from any click handler.
 */
export function downloadFlowExport(envelope: FlowExport, flowName: string): void {
  const url = URL.createObjectURL(flowExportBlob(envelope));
  try {
    const a = document.createElement('a');
    a.href = url;
    a.download = flowExportFilename(flowName);
    a.click();
  } finally {
    URL.revokeObjectURL(url);
  }
}
