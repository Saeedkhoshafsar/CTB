/**
 * ai.agent — AI Agent with tools (NODES.md §AI Agent, PLAN P5-T4). An LLM that
 * can CALL TOOLS in a multi-turn loop: the model decides which tool(s) to run,
 * the node executes each one and feeds the result back, looping until the model
 * gives a final text answer or a budget cap stops it.
 *
 * Tools come from two GENERIC sources (invariant I2 — nothing domain-specific):
 *  - `mcp`     — every tool an MCP server advertises (via `ctx.mcp`, P5-T3). The
 *                author picks one `mcpServer` credential; the agent lists its
 *                tools at the start of the run and exposes them all.
 *  - `subflow` — another flow OF THE SAME BOT exposed as ONE named tool (n8n's
 *                "Workflow Tool"). The model's JSON arguments become the
 *                sub-flow's entry `$json`; the items its `flow.return` produced
 *                become the tool result. Runs through `ctx.subflow` (P3-T1) so
 *                the same-bot + recursion-depth guards apply.
 *
 * The provider call is HOST-side via the EXTENDED `ctx.ai.chat()` capability
 * (now carrying `tools` and returning `toolCalls`) — the node only ever passes a
 * `credentialId` + model + messages + tool specs (invariants I6/I7: the key
 * never reaches here).
 *
 * Budget caps are mandatory safety rails on an autonomous loop:
 *  - `max_steps`        — assistant↔tool round-trips.
 *  - `max_tool_calls`   — total tool invocations.
 *  - `max_tokens_total` — cumulative reported usage (0 = no token cap).
 * On any cap the loop stops and returns the best answer so far with a
 * `stopReason`. Runs ONCE per node run; the result merges onto EVERY output item
 * under `$json.<save_as>` (default `agent`).
 */
import {
  AiAgentParamsSchema,
  fail,
  out,
  type AiAgentParams,
  type AgentToolSource,
  type AiChatMessage,
  type AiChatResult,
  type AiChatUsage,
  type AiToolCall,
  type AiToolSpec,
  type FlowItem,
  type NodeCtx,
  type NodeDef,
} from '@ctb/shared';

/** Why the agent loop stopped. */
export type AgentStopReason = 'final' | 'max_steps' | 'max_tool_calls' | 'max_tokens';

/** A resolved tool the agent can call: its spec for the model + a runner for the node. */
interface ResolvedTool {
  spec: AiToolSpec;
  /** Run the tool with parsed JSON args → a text result for the model. */
  run(args: Record<string, unknown>): Promise<string>;
}

export const aiAgent: NodeDef<AiAgentParams> = {
  type: 'ai.agent',
  category: 'ai',
  meta: { labelKey: 'nodes.ai.agent.label', descriptionKey: 'nodes.ai.agent.desc', icon: 'bot' },
  ports: { inputs: ['main'], outputs: ['main'] },
  paramsSchema: AiAgentParamsSchema,
  async execute(ctx, params, items) {
    if (!ctx.ai) {
      return fail('ai.agent: AI service is not available in this context');
    }

    const saveAs = params.save_as ?? 'agent';

    // Resolve the attached tools into model specs + node-side runners. An mcp
    // source expands into one tool per advertised server tool; a subflow source
    // becomes a single named tool. Resolution failures (no MCP service, unknown
    // flow) fail the node loudly — a misconfigured agent must not run blind.
    let resolved: ResolvedTool[];
    try {
      resolved = await resolveTools(ctx, params.tools);
    } catch (err) {
      return fail(`ai.agent: ${err instanceof Error ? err.message : String(err)}`);
    }
    const toolByName = new Map(resolved.map((t) => [t.spec.name, t]));
    const toolSpecs = resolved.map((t) => t.spec);

    // Conversation seed: system prompt + the user's request.
    const messages: AiChatMessage[] = [];
    if (params.system_prompt && params.system_prompt.trim() !== '') {
      messages.push({ role: 'system', content: params.system_prompt });
    }
    messages.push({ role: 'user', content: params.user_prompt });

    const usage: AiChatUsage = {};
    let steps = 0;
    let toolCallCount = 0;
    let stopReason: AgentStopReason = 'final';
    let reply = '';

    // The agent loop. Each iteration is one LLM turn; if it requests tools we run
    // them and loop again, otherwise its text is the final answer.
    while (true) {
      if (steps >= params.max_steps) {
        stopReason = 'max_steps';
        break;
      }
      steps += 1;

      let result: AiChatResult;
      try {
        result = await ctx.ai.chat({
          credentialId: params.credentialId,
          model: params.model,
          messages,
          ...(toolSpecs.length > 0 ? { tools: toolSpecs } : {}),
          ...(params.temperature !== undefined ? { temperature: params.temperature } : {}),
          ...(params.max_tokens !== undefined ? { maxTokens: params.max_tokens } : {}),
        });
      } catch (err) {
        return fail(`ai.agent: ${err instanceof Error ? err.message : String(err)}`);
      }

      accumulateUsage(usage, result.usage);
      reply = result.reply ?? '';

      const calls = result.toolCalls ?? [];
      if (calls.length === 0) {
        // No tool calls → the model gave its final answer.
        stopReason = 'final';
        break;
      }

      // Record the assistant's tool-call turn so the model sees its own request
      // alongside the results we feed back.
      messages.push({ role: 'assistant', content: reply, toolCalls: calls });

      // Token budget is checked AFTER each LLM turn (the call already happened).
      if (params.max_tokens_total > 0 && (usage.totalTokens ?? 0) > params.max_tokens_total) {
        stopReason = 'max_tokens';
        break;
      }

      let hitToolCap = false;
      for (const call of calls) {
        if (params.max_tool_calls > 0 && toolCallCount >= params.max_tool_calls) {
          hitToolCap = true;
          break;
        }
        if (params.max_tool_calls === 0) {
          // Tools advertised but invocations forbidden — tell the model so.
          messages.push(toolResult(call, 'error: tool calls are disabled (max_tool_calls = 0)'));
          continue;
        }
        toolCallCount += 1;
        const resultText = await runOneTool(toolByName, call, ctx);
        messages.push(toolResult(call, resultText));
      }
      if (hitToolCap) {
        stopReason = 'max_tool_calls';
        break;
      }
    }

    const value = {
      reply,
      steps,
      toolCalls: toolCallCount,
      usage,
      stopReason,
    };

    const input: FlowItem[] = items.length > 0 ? items : [{ json: {} }];
    return out({
      main: input.map((it) => {
        const next: FlowItem = { json: { ...it.json, [saveAs]: value } };
        if (it.binary !== undefined) next.binary = it.binary;
        return next;
      }),
    });
  },
};

/** Build a `role:'tool'` reply message linked to its originating call. */
function toolResult(call: AiToolCall, content: string): AiChatMessage {
  return { role: 'tool', content, toolCallId: call.id };
}

/** Add a turn's reported usage into the running total (best-effort, all optional). */
function accumulateUsage(total: AiChatUsage, turn: AiChatUsage | undefined): void {
  if (!turn) return;
  if (typeof turn.promptTokens === 'number') total.promptTokens = (total.promptTokens ?? 0) + turn.promptTokens;
  if (typeof turn.completionTokens === 'number')
    total.completionTokens = (total.completionTokens ?? 0) + turn.completionTokens;
  if (typeof turn.totalTokens === 'number') total.totalTokens = (total.totalTokens ?? 0) + turn.totalTokens;
}

/**
 * Run one requested tool call: find the tool, parse its JSON arguments, invoke
 * it, and return a text result. Every failure is turned into an `error: …`
 * STRING fed back to the model (never a node failure) — an agent should be able
 * to recover from a bad tool call by trying differently, just like in n8n.
 */
async function runOneTool(
  toolByName: Map<string, ResolvedTool>,
  call: AiToolCall,
  ctx: NodeCtx,
): Promise<string> {
  const tool = toolByName.get(call.name);
  if (!tool) return `error: unknown tool "${call.name}"`;
  let args: Record<string, unknown>;
  try {
    args = parseToolArguments(call.argumentsJson);
  } catch (err) {
    return `error: ${err instanceof Error ? err.message : String(err)}`;
  }
  try {
    return await tool.run(args);
  } catch (err) {
    ctx.log('warn', `ai.agent: tool "${call.name}" failed: ${err instanceof Error ? err.message : String(err)}`);
    return `error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

/** Parse a tool-call arguments string; blank → `{}`; must be a JSON object. */
export function parseToolArguments(raw: string): Record<string, unknown> {
  const text = (raw ?? '').trim();
  if (text === '') return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('tool arguments are not valid JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('tool arguments must be a JSON object');
  }
  return parsed as Record<string, unknown>;
}

/**
 * Resolve the configured tool sources into runnable tools. `mcp` sources expand
 * to one tool per advertised server tool (calling back through `ctx.mcp`);
 * `subflow` sources become a single tool that runs the flow via `ctx.subflow`.
 * Throws when a required capability is missing so the node fails loudly.
 */
async function resolveTools(ctx: NodeCtx, sources: AgentToolSource[]): Promise<ResolvedTool[]> {
  const tools: ResolvedTool[] = [];
  const seen = new Set<string>();

  for (const src of sources) {
    if (src.type === 'mcp') {
      if (!ctx.mcp) throw new Error('MCP service is not available — an mcp tool needs it');
      const credentialId = src.credentialId;
      const advertised = await ctx.mcp.listTools({ credentialId });
      for (const t of advertised) {
        if (!t.name || seen.has(t.name)) continue;
        seen.add(t.name);
        const spec: AiToolSpec = { name: t.name };
        if (t.description) spec.description = t.description;
        if (t.inputSchema) spec.parameters = t.inputSchema;
        tools.push({
          spec,
          async run(args) {
            const r = await ctx.mcp!.callTool({ credentialId, name: t.name, arguments: args });
            if (r.isError) return `error: ${r.text || 'tool reported an error'}`;
            return r.text !== '' ? r.text : JSON.stringify(r.content);
          },
        });
      }
    } else {
      // subflow tool
      if (!ctx.subflow) throw new Error('sub-flow execution is not available — a subflow tool needs it');
      const flowId = src.flow_id;
      const name = src.tool_name.trim() !== '' ? src.tool_name.trim() : `flow_${flowId.replace(/[^A-Za-z0-9_-]/g, '_')}`;
      if (seen.has(name)) continue;
      seen.add(name);
      const spec: AiToolSpec = {
        name,
        description: src.description.trim() !== '' ? src.description : `Run the "${flowId}" flow as a tool`,
        // Open object: the sub-flow reads whatever the model passes from $json.
        parameters: { type: 'object', additionalProperties: true },
      };
      tools.push({
        spec,
        async run(args) {
          const { items: returned } = await ctx.subflow!.run(flowId, [{ json: args }]);
          // Flatten the returned items' json into a compact text result.
          if (returned.length === 0) return '(no output)';
          if (returned.length === 1) return JSON.stringify(returned[0]!.json);
          return JSON.stringify(returned.map((i) => i.json));
        },
      });
    }
  }
  return tools;
}
