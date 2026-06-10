import { z } from 'zod';

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
  /** Free-form note shown on canvas. */
  note: z.string().max(2000).optional(),
});
export type FlowNode = z.infer<typeof FlowNodeSchema>;

export const FlowEdgeSchema = z.object({
  id: z.string().min(1).max(128),
  from: z.object({ node: NodeIdSchema, port: PortNameSchema.default('main') }),
  to: z.object({ node: NodeIdSchema, port: PortNameSchema.default('main') }),
});
export type FlowEdge = z.infer<typeof FlowEdgeSchema>;

export const FlowGraphSchema = z
  .object({
    nodes: z.array(FlowNodeSchema),
    edges: z.array(FlowEdgeSchema),
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
  });
export type FlowGraph = z.infer<typeof FlowGraphSchema>;
