/**
 * ai.mcpClient — MCP Client (NODES.md §MCP Client, PLAN P5-T3). Talks to a
 * remote Model-Context-Protocol server selected by an `mcpServer` credential
 * (endpoint URL + optional key). The HOST performs the JSON-RPC calls via the
 * `ctx.mcp` capability — the node only ever passes a `credentialId`, the action
 * and (for a call) a tool name + arguments; the decrypted key never reaches
 * here (invariants I6/I7).
 *
 * Two actions:
 *  - list_tools → `$json.<save_as> = { tools }` (the server's advertised tools).
 *  - call_tool  → invokes `tool_name` with the parsed `arguments_json`,
 *    `$json.<save_as> = { result: { content, text, isError } }`.
 *
 * Runs ONCE per node run (not per item): an MCP round-trip is expensive
 * execution-external work, and the action targets the resolved params (a single
 * value), so it must not be multiplied by the item count. The result is merged
 * onto EVERY output item under `save_as` (default `mcp`).
 */
import {
  AiMcpClientParamsSchema,
  fail,
  out,
  type AiMcpClientParams,
  type FlowItem,
  type NodeDef,
} from '@ctb/shared';

export const aiMcpClient: NodeDef<AiMcpClientParams> = {
  type: 'ai.mcpClient',
  category: 'ai',
  meta: { labelKey: 'nodes.ai.mcpClient.label', descriptionKey: 'nodes.ai.mcpClient.desc', icon: 'plug' },
  ports: { inputs: ['main'], outputs: ['main'] },
  paramsSchema: AiMcpClientParamsSchema,
  async execute(ctx, params, items) {
    if (!ctx.mcp) {
      return fail('ai.mcpClient: MCP service is not available in this context');
    }

    const saveAs = params.save_as ?? 'mcp';

    let value: Record<string, unknown>;
    try {
      if (params.action === 'list_tools') {
        const tools = await ctx.mcp.listTools({ credentialId: params.credentialId });
        value = { tools };
      } else {
        // call_tool — parse the JSON arguments (already expression-resolved).
        const args = parseArguments(params.arguments_json);
        const result = await ctx.mcp.callTool({
          credentialId: params.credentialId,
          name: params.tool_name,
          arguments: args,
        });
        value = { result };
      }
    } catch (err) {
      return fail(`ai.mcpClient: ${err instanceof Error ? err.message : String(err)}`);
    }

    const input: FlowItem[] = items.length > 0 ? items : [{ json: {} }];
    return out({
      main: input.map((item) => {
        const next: FlowItem = { json: { ...item.json, [saveAs]: value } };
        if (item.binary !== undefined) next.binary = item.binary;
        return next;
      }),
    });
  },
};

/**
 * Parse the `arguments_json` param into a plain object. Empty/blank → `{}`. A
 * non-object JSON value (array, number, string…) is rejected so a tool always
 * receives a named-argument object, matching MCP's tool-call contract.
 */
function parseArguments(raw: string): Record<string, unknown> {
  const text = raw.trim();
  if (text === '') return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('arguments_json is not valid JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('arguments_json must be a JSON object');
  }
  return parsed as Record<string, unknown>;
}
