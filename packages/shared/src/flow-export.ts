/**
 * Flow import/export (P3-T7) — a portable JSON envelope of a flow's
 * DESIGN (its graph + settings), free of any instance-specific identity.
 *
 * Why an envelope and not just the FlowGraph?
 *  - A flow's identity (id, botId, version, timestamps) is bound to ONE
 *    install; carrying it across export/import would collide or mislead, so
 *    the envelope omits all of it. Import always creates a NEW flow.
 *  - settings (P3-T6) are part of the design and travel too — EXCEPT
 *    `errorHandlerFlowId`, which names ANOTHER flow by id. That reference
 *    can't survive a move to a different bot/install, so export drops it
 *    (sets it to null). The operator re-points the handler after import.
 *
 * The acceptance bar (PLAN P3-T7): export → import → identical semantics.
 * `graph` round-trips byte-for-byte through FlowGraphSchema; settings
 * round-trip except for the deliberately-dropped error handler. The
 * envelope is GENERIC (invariant I2): it carries no domain fields — the
 * same machinery that exports a feedback form exports a reminder flow.
 */
import { z } from 'zod';
import { FlowSettingsSchema, defaultFlowSettings } from './api';
import { FlowGraphSchema } from './flow';

/** Discriminator + schema version so future formats can be migrated, not guessed. */
export const FLOW_EXPORT_KIND = 'ctb.flow' as const;
export const FLOW_EXPORT_VERSION = 1 as const;

/**
 * Settings as they appear INSIDE an export: identical to FlowSettings but the
 * cross-flow `errorHandlerFlowId` is always null — it can't be carried (see
 * file header). Modeled explicitly so the schema rejects a stray handler id
 * rather than silently importing a dangling reference.
 */
export const ExportedFlowSettingsSchema = FlowSettingsSchema.extend({
  errorHandlerFlowId: z.null().default(null),
});

export const FlowExportSchema = z.object({
  /** Format discriminator — guards against importing some unrelated JSON. */
  kind: z.literal(FLOW_EXPORT_KIND),
  /** Envelope schema version (not the flow's edit version). */
  version: z.literal(FLOW_EXPORT_VERSION),
  /** Human-facing flow name; the importer may override it. */
  name: z.string().min(1).max(200),
  /** The design itself — validated by the one true graph schema (I5). */
  graph: FlowGraphSchema,
  /** Per-flow settings minus the un-portable error handler. */
  settings: ExportedFlowSettingsSchema.default(() => ({
    ...defaultFlowSettings(),
    errorHandlerFlowId: null,
  })),
});
export type FlowExport = z.infer<typeof FlowExportSchema>;

/**
 * Build an export envelope from a live flow's design. `errorHandlerFlowId` is
 * intentionally dropped (→ null) because it references another flow by id.
 */
export function toFlowExport(input: {
  name: string;
  graph: z.infer<typeof FlowGraphSchema>;
  settings?: z.infer<typeof FlowSettingsSchema>;
}): FlowExport {
  const settings = input.settings ?? defaultFlowSettings();
  return {
    kind: FLOW_EXPORT_KIND,
    version: FLOW_EXPORT_VERSION,
    name: input.name,
    graph: input.graph,
    settings: { executionPolicy: settings.executionPolicy, errorHandlerFlowId: null },
  };
}

/**
 * Parse arbitrary JSON into a validated FlowExport, or return the Zod issues.
 * Used by both the server (import endpoint) and the editor (pre-flight) so
 * they reject the exact same malformed envelopes (invariant I5).
 */
export function parseFlowExport(
  raw: unknown,
): { ok: true; value: FlowExport } | { ok: false; issues: z.core.$ZodIssue[] } {
  const parsed = FlowExportSchema.safeParse(raw);
  return parsed.success ? { ok: true, value: parsed.data } : { ok: false, issues: parsed.error.issues };
}
