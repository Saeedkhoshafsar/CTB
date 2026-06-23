import { z } from 'zod';
import { FlowItemSchema } from './item';

/**
 * Flow graph — THE document the canvas edits and the engine executes.
 * One Zod schema, two consumers (invariant I5): editor and engine both
 * parse with exactly this definition; there is no compile step in v1.
 */

/** Node ids are caller-chosen but must be url/log friendly. */
export const NodeIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
export type NodeId = z.infer<typeof NodeIdSchema>;

/**
 * Port naming convention:
 *  - default single ports are "main"
 *  - multi-output nodes use semantic names: "true"/"false" (IF),
 *    "reply"/"timeout"/"invalid" (Wait for Reply), rule keys (Switch),
 *    button keys (Menu: "btn:<key>")
 */
export const PortNameSchema = z.string().regex(/^[A-Za-z0-9_:.-]{1,64}$/);
export type PortName = z.infer<typeof PortNameSchema>;

/** Node type ids: namespace.camelCase — e.g. "tg.sendMessage", "flow.if". */
export const NodeTypeSchema = z.string().regex(/^[a-z][a-zA-Z0-9]*\.[a-z][a-zA-Z0-9]*$/);
export type NodeType = z.infer<typeof NodeTypeSchema>;

export const FlowNodeSchema = z.object({
  id: NodeIdSchema,
  type: NodeTypeSchema,
  /** Node-type-specific parameters; validated against the node's paramsSchema by the registry. */
  params: z.record(z.string(), z.unknown()).default({}),
  /** Canvas position — engine ignores it, editor needs it. Kept in the same doc on purpose. */
  position: z.object({ x: z.number(), y: z.number() }).default({ x: 0, y: 0 }),
  /** Disabled nodes are skipped by the executor (items pass through "main"). */
  disabled: z.boolean().default(false),
  /**
   * Human label for the node, distinct from its `type` (H-T2, gap G7). PURELY
   * presentational: the canvas head and the node panel show `title` when set
   * (otherwise the type's i18n label), but the executor NEVER reads it — it
   * routes solely by `id`/`type`/edges, exactly as it already ignores
   * `position`/`note`. OPTIONAL (no default) so every existing stored flow,
   * fixture and export literal stays byte-identical (a node with no title
   * omits the field); editor consumers fall back to the type label.
   * Decision Log #20.
   */
  title: z.string().max(120).optional(),
  /** Free-form note shown on canvas. */
  note: z.string().max(2000).optional(),
  /**
   * Pinned sample data (I-T1, gap G4). When set, a TEST run uses these items as
   * the node's OUTPUT (on the universal `main` port) INSTEAD of executing the
   * node — so a downstream node can be built/tested with stable, known data
   * without re-running (or even being able to run) the upstream node. This is
   * the n8n "pin data" affordance, kept generic at the engine level.
   *
   * CRITICAL durability/safety contract (Decision Log #21): pinned data is
   * honoured ONLY in a TEST run (`ExecutionState.testRun === true`); a
   * production run IGNORES it entirely and executes the node normally — a pin is
   * a build-time convenience, never a live behaviour. OPTIONAL (no default) so
   * every existing stored flow, fixture and export literal stays byte-identical
   * (a node with no pin omits the field); the executor reads `node.pinnedData`
   * only on the test-run path. Capped at 50 items — a pin is a sample, not a
   * dataset.
   */
  pinnedData: z.array(FlowItemSchema).max(50).optional(),
});
export type FlowNode = z.infer<typeof FlowNodeSchema>;

export const FlowEdgeSchema = z.object({
  id: z.string().min(1).max(128),
  from: z.object({ node: NodeIdSchema, port: PortNameSchema.default('main') }),
  to: z.object({ node: NodeIdSchema, port: PortNameSchema.default('main') }),
});
export type FlowEdge = z.infer<typeof FlowEdgeSchema>;

/** Sticky-note ids share the node-id alphabet but are namespaced "note_*". */
export const NoteIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
export type NoteId = z.infer<typeof NoteIdSchema>;

/**
 * Sticky note (H-T1) — a CANVAS-ONLY annotation element. It is NOT a node:
 * it has no type, no params, no ports and the executor never sees it (the
 * engine reads only `graph.nodes`/`graph.edges`, Decision Log #19). It lives
 * in the same flow document so a note travels with export/import and undo/redo
 * for free. A small fixed colour palette keeps the canvas legible (RTL-safe).
 */
export const NoteColorSchema = z.enum(['yellow', 'green', 'blue', 'pink', 'gray']);
export type NoteColor = z.infer<typeof NoteColorSchema>;

export const StickyNoteSchema = z.object({
  id: NoteIdSchema,
  /** Free-form markdown-ish text (rendered as plain text in v1). */
  text: z.string().max(5000).default(''),
  /** Top-left canvas position, same coordinate space as nodes. */
  position: z.object({ x: z.number(), y: z.number() }).default({ x: 0, y: 0 }),
  /** Box size in canvas units; clamped to sane bounds the resizer enforces. */
  size: z
    .object({ width: z.number().min(80).max(2000), height: z.number().min(60).max(2000) })
    .default({ width: 240, height: 160 }),
  color: NoteColorSchema.default('yellow'),
});
export type StickyNote = z.infer<typeof StickyNoteSchema>;

export const FlowGraphSchema = z
  .object({
    nodes: z.array(FlowNodeSchema),
    edges: z.array(FlowEdgeSchema),
    /**
     * Canvas sticky notes (H-T1). OPTIONAL (no default) so EVERY existing
     * stored flow, fixture, export and in-code graph literal stays valid
     * byte-for-byte — a flow with no notes simply omits the field. The engine
     * ignores this field entirely (it is purely an editor concern, like
     * `node.position`); editor consumers read `graph.notes ?? []`.
     * Decision Log #19.
     */
    notes: z.array(StickyNoteSchema).optional(),
  })
  .superRefine((graph, ctx) => {
    const ids = new Set<string>();
    for (const n of graph.nodes) {
      if (ids.has(n.id)) {
        ctx.addIssue({ code: 'custom', message: `duplicate node id "${n.id}"`, path: ['nodes'] });
      }
      ids.add(n.id);
    }
    graph.edges.forEach((e, i) => {
      if (!ids.has(e.from.node)) {
        ctx.addIssue({ code: 'custom', message: `edge "${e.id}" from unknown node "${e.from.node}"`, path: ['edges', i] });
      }
      if (!ids.has(e.to.node)) {
        ctx.addIssue({ code: 'custom', message: `edge "${e.id}" to unknown node "${e.to.node}"`, path: ['edges', i] });
      }
    });
    // Sticky notes (H-T1) must have unique ids too; they share no namespace
    // with nodes (a note id may coincide with a node id — they never collide
    // since the engine and edges only ever reference node ids).
    const noteIds = new Set<string>();
    for (const n of graph.notes ?? []) {
      if (noteIds.has(n.id)) {
        ctx.addIssue({ code: 'custom', message: `duplicate note id "${n.id}"`, path: ['notes'] });
      }
      noteIds.add(n.id);
    }
  });
export type FlowGraph = z.infer<typeof FlowGraphSchema>;
