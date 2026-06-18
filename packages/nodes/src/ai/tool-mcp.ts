/**
 * tool.mcp — a remote MCP server's tools exposed to an AI Agent (PLAN2 PC-T4;
 * NODES.md §"AI Agent tool nodes"). A `role:'provider'` sub-node that fills an
 * agent's `ai:tool` slot: the author picks ONE `mcpServer` credential and the
 * agent lists that server's advertised tools at the start of its run and exposes
 * them ALL — so a CTB agent can call any MCP tool in the wild. It is the canvas
 * (draggable) form of the inline `AgentToolSource` `mcp` variant; the agent maps
 * a `tool.mcp` provider to an `mcp` tool source BY NODE TYPE (see agent.ts
 * `toolSourcesFromSlots`) and expands it through the host `ctx.mcp` capability
 * (P5-T3) — the decrypted key never reaches a node (invariants I6/I7).
 *
 * A provider is NEVER executed as a data step (PB-T1 — the executor skips
 * `role:'provider'` nodes); its params ARE its contract. The `execute()` below
 * only satisfies the NodeDef contract and fails loudly if a malformed graph ever
 * routes data into it.
 */
import { fail, type NodeDef, type ToolMcpParams } from '@ctb/shared';
import { ToolMcpParamsSchema } from '@ctb/shared';

export const aiToolMcp: NodeDef<ToolMcpParams> = {
  type: 'tool.mcp',
  category: 'ai',
  role: 'provider',
  provides: 'ai:tool',
  meta: { labelKey: 'nodes.tool.mcp.label', descriptionKey: 'nodes.tool.mcp.desc', icon: 'plug' },
  // A provider takes no data input and emits only the dashed `provider` wire.
  ports: { inputs: [], outputs: ['provider'] },
  paramsSchema: ToolMcpParamsSchema,
  async execute() {
    return fail('tool.mcp is an agent tool provider and is not executed as a data step');
  },
};
