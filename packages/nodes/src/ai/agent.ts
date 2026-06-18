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
  appendChatTurn,
  fail,
  loadChatHistory,
  out,
  toAiMessages,
  type AiAgentParams,
  type AgentToolSource,
  type AttachedProvider,
  type AiChatMessage,
  type AiChatResult,
  type AiChatUsage,
  type AiToolCall,
  type AiToolSpec,
  type ChatMemoryConfig,
  type FlowItem,
  type NodeCtx,
  type NodeDef,
  type ToolCodeParams,
  type ToolHttpRequestParams,
  type ToolMcpParams,
  type ToolParamRow,
  type ToolSubflowParams,
  type ToolThinkParams,
} from '@ctb/shared';
import { parseDuration } from '../lib/duration';

/** PB-T6 dedicated tool provider node types — resolved into runners directly. */
const TOOL_PROVIDER_TYPES = ['tool.httpRequest', 'tool.code', 'tool.think', 'tool.subflow'] as const;

/** Hard wall-clock ceiling for a `tool.code` sandbox run (mirrors data.code, 10s). */
const TOOL_CODE_TIMEOUT_CAP_MS = 10_000;

/** Why the agent loop stopped. */
export type AgentStopReason = 'final' | 'max_steps' | 'max_tool_calls' | 'max_tokens';

/** The model + credential the agent will call, after resolving the `ai:model` slot. */
interface ResolvedModel {
  credentialId: string;
  model: string;
  temperature?: number;
  maxTokens?: number;
}

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
  // Typed sub-connection slots (PB-T5). The agent is a CONSUMER: a model
  // provider is required (the LLM it drives), memory is optional (rolling
  // conversation history), and tools are repeatable (each attached tool node
  // adds one callable). Inline params (credentialId/model/tools) remain a
  // backward-compatible fallback so Phase-A agent flows keep working.
  inputSlots: [
    { kind: 'ai:model', required: false, repeatable: false },
    { kind: 'ai:memory', required: false, repeatable: false },
    { kind: 'ai:tool', required: false, repeatable: true },
  ],
  paramsSchema: AiAgentParamsSchema,
  async execute(ctx, params, items) {
    if (!ctx.ai) {
      return fail('ai.agent: AI service is not available in this context');
    }

    const saveAs = params.save_as ?? 'agent';

    // Resolve the model to call. An attached `ai:model` provider slot wins;
    // otherwise we fall back to the inline credentialId/model params (back-compat).
    let modelCfg: ResolvedModel;
    try {
      modelCfg = resolveModel(ctx, params);
    } catch (err) {
      return fail(`ai.agent: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Resolve the attached tools into model specs + node-side runners. Tools come
    // from THREE places: (1) the inline `tools` param (Phase-A mcp/subflow
    // sources); (2) dedicated PB-T6 tool PROVIDER nodes wired into the `ai:tool`
    // slot (`tool.httpRequest`/`tool.code`/`tool.think`/`tool.subflow`), resolved
    // directly into runners; (3) slot providers whose params already match an
    // inline source shape (forward-compat). An mcp source expands into one tool
    // per advertised server tool; everything else becomes a single named tool.
    // Resolution failures (no MCP service, unknown flow) fail the node loudly — a
    // misconfigured agent must not run blind.
    let resolved: ResolvedTool[];
    try {
      const providers = ctx.slots['ai:tool'] ?? [];
      const slotTools = resolveSlotTools(ctx, providers);
      const slotSources = toolSourcesFromSlots(ctx, providers);
      resolved = [...(await resolveTools(ctx, [...params.tools, ...slotSources])), ...slotTools];
    } catch (err) {
      return fail(`ai.agent: ${err instanceof Error ? err.message : String(err)}`);
    }
    const toolByName = new Map(resolved.map((t) => [t.spec.name, t]));
    const toolSpecs = resolved.map((t) => t.spec);

    // Resolve the optional `ai:memory` provider slot into a chat-memory config.
    // When attached, we replay the rolling window before the loop and persist the
    // new turn after it (PB-T4 runtime). No slot → stateless (legacy behavior).
    let memory: ChatMemoryConfig | null;
    try {
      memory = resolveMemory(ctx, ctx.slots['ai:memory']?.[0]);
    } catch (err) {
      return fail(`ai.agent: ${err instanceof Error ? err.message : String(err)}`);
    }

    let history: AiChatMessage[] = [];
    if (memory) {
      try {
        history = toAiMessages(await loadChatHistory(memory, { kv: ctx.kv, db: ctx.db }));
      } catch (err) {
        return fail(`ai.agent: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // Conversation seed: system prompt + replayed memory + the user's request.
    const messages: AiChatMessage[] = [];
    if (params.system_prompt && params.system_prompt.trim() !== '') {
      messages.push({ role: 'system', content: params.system_prompt });
    }
    messages.push(...history);
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
          credentialId: modelCfg.credentialId,
          model: modelCfg.model,
          messages,
          ...(toolSpecs.length > 0 ? { tools: toolSpecs } : {}),
          ...(modelCfg.temperature !== undefined ? { temperature: modelCfg.temperature } : {}),
          ...(modelCfg.maxTokens !== undefined ? { maxTokens: modelCfg.maxTokens } : {}),
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

    // Persist the new turn (user prompt + final reply) when memory is attached.
    // Best-effort: a store hiccup must not lose the answer we already produced —
    // we log and continue (consistent with the loop never failing on tool errors).
    if (memory && reply !== '') {
      try {
        await appendChatTurn(memory, { kv: ctx.kv, db: ctx.db }, { user: params.user_prompt, assistant: reply });
      } catch (err) {
        ctx.log('warn', `ai.agent: failed to persist chat memory: ${err instanceof Error ? err.message : String(err)}`);
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
 * Resolve which LLM the agent calls (PB-T5). An attached `ai:model` provider
 * slot supplies the credential + model + sampling knobs; when none is attached
 * we fall back to the inline `credentialId`/`model` params so existing flows keep
 * working. Throws (→ node failure) when neither source yields a credential, so a
 * model-less agent fails loudly instead of calling the host with a blank id.
 */
function resolveModel(ctx: NodeCtx, params: AiAgentParams): ResolvedModel {
  const provider = ctx.slots['ai:model']?.[0];
  if (provider) {
    // The provider's params were already validated against AiModelOpenaiParamsSchema
    // by the executor (PB-T5 resolveSlots), so this read is safe.
    const p = provider.params as {
      credentialId: string;
      model: string;
      temperature?: number;
      max_tokens?: number;
    };
    if (!p.credentialId || p.credentialId.trim() === '') {
      throw new Error(`model provider "${provider.nodeId}" has no credential`);
    }
    const cfg: ResolvedModel = { credentialId: p.credentialId, model: p.model };
    if (p.temperature !== undefined) cfg.temperature = p.temperature;
    if (p.max_tokens !== undefined) cfg.maxTokens = p.max_tokens;
    return cfg;
  }
  // No model slot → inline fallback (back-compat). The inline credentialId is
  // optional in the schema now, so enforce it here when it's the only source.
  if (!params.credentialId || params.credentialId.trim() === '') {
    throw new Error('no model: attach an ai:model provider or set an inline credential');
  }
  const cfg: ResolvedModel = { credentialId: params.credentialId, model: params.model };
  if (params.temperature !== undefined) cfg.temperature = params.temperature;
  if (params.max_tokens !== undefined) cfg.maxTokens = params.max_tokens;
  return cfg;
}

/**
 * Resolve the optional `ai:memory` provider slot into a `ChatMemoryConfig`
 * (PB-T5). Mirrors the two provider param shapes (`ai.memoryKv` /
 * `ai.memoryPostgres`); the resolved `session_key` falls back to a per-chat,
 * per-node default (matching the old ai.llmChat key convention) when blank, so a
 * single attached provider gives every chat isolated memory out of the box.
 * Returns null when no memory provider is attached.
 */
function resolveMemory(ctx: NodeCtx, provider: AttachedProvider | undefined): ChatMemoryConfig | null {
  if (!provider) return null;
  const defaultKey = `${ctx.nodeId}:${ctx.chatId ?? 'nochat'}`;
  if (provider.type === 'ai.memoryKv') {
    const p = provider.params as { session_key: string; memory_window: number };
    return {
      kind: 'kv',
      sessionKey: p.session_key.trim() !== '' ? p.session_key : defaultKey,
      window: p.memory_window,
    };
  }
  if (provider.type === 'ai.memoryPostgres') {
    const p = provider.params as {
      credentialId: string;
      table: string;
      session_key: string;
      memory_window: number;
      auto_create: boolean;
    };
    return {
      kind: 'postgres',
      credentialId: p.credentialId,
      table: p.table,
      sessionKey: p.session_key.trim() !== '' ? p.session_key : defaultKey,
      window: p.memory_window,
      autoCreate: p.auto_create,
    };
  }
  throw new Error(`unsupported memory provider type "${provider.type}"`);
}

/**
 * Convert attached `ai:tool` provider slots into `AgentToolSource`s.
 * Two paths feed this:
 *  - `tool.mcp` (PC-T4): the canvas form of an `mcp` source — mapped to a source
 *    BY NODE TYPE (its params carry only a `credentialId`, no `type` field), so
 *    `resolveTools` expands it into one tool per advertised server tool.
 *  - forward-compat (PB-T5): a provider whose validated params ALREADY match an
 *    inline `AgentToolSource` (`{type:'mcp'|'subflow', …}`) is accepted as-is.
 * Dedicated PB-T6 tool nodes (`tool.httpRequest`/`code`/`think`/`subflow`) are
 * NOT handled here — `resolveSlotTools` turns those into runners directly. An
 * unrecognized provider is skipped with a warning rather than crashing the agent.
 */
function toolSourcesFromSlots(ctx: NodeCtx, providers: readonly AttachedProvider[]): AgentToolSource[] {
  const sources: AgentToolSource[] = [];
  for (const provider of providers) {
    // tool.mcp (PC-T4): a draggable MCP-tools provider → an `mcp` source.
    if (provider.type === 'tool.mcp') {
      const p = provider.params as ToolMcpParams;
      sources.push({ type: 'mcp', credentialId: p.credentialId, flow_id: '', tool_name: '', description: '' });
      continue;
    }
    if (isToolProviderType(provider.type)) continue; // handled by resolveSlotTools
    const p = provider.params as { type?: unknown };
    if (p && (p.type === 'mcp' || p.type === 'subflow')) {
      sources.push(provider.params as AgentToolSource);
      continue;
    }
    ctx.log('warn', `ai.agent: tool provider "${provider.nodeId}" (${provider.type}) is not a recognized tool source — skipped`);
  }
  return sources;
}

function isToolProviderType(type: string): type is (typeof TOOL_PROVIDER_TYPES)[number] {
  return (TOOL_PROVIDER_TYPES as readonly string[]).includes(type);
}

/**
 * Resolve the dedicated PB-T6 tool PROVIDER nodes wired into the `ai:tool` slot
 * into runnable tools. Each node type maps to one callable tool whose spec the
 * model reads (name + description + parameter schema) and whose runner the agent
 * invokes when the model calls it:
 *  - `tool.httpRequest` → `ctx.http.request` (host-limited), model args merged
 *    into the query (GET/HEAD) or JSON body.
 *  - `tool.code`        → `ctx.code.run` (sandbox), model args visible as `$json`.
 *  - `tool.think`       → a no-op scratchpad that echoes the model's `thought`.
 *  - `tool.subflow`     → `ctx.subflow.run` (same-bot child flow as a tool).
 * Duplicate tool names are dropped (first wins) so the model never sees an
 * ambiguous tool set. A capability that a tool needs but the host hasn't wired
 * (no `ctx.subflow`) throws → the agent fails loudly.
 */
function resolveSlotTools(ctx: NodeCtx, providers: readonly AttachedProvider[]): ResolvedTool[] {
  const tools: ResolvedTool[] = [];
  const seen = new Set<string>();
  for (const provider of providers) {
    if (!isToolProviderType(provider.type)) continue;
    const tool = buildSlotTool(ctx, provider);
    if (!tool) continue;
    if (seen.has(tool.spec.name)) {
      ctx.log('warn', `ai.agent: duplicate tool name "${tool.spec.name}" from "${provider.nodeId}" — skipped`);
      continue;
    }
    seen.add(tool.spec.name);
    tools.push(tool);
  }
  return tools;
}

/** Build one `ResolvedTool` from a dedicated tool provider node (PB-T6). */
function buildSlotTool(ctx: NodeCtx, provider: AttachedProvider): ResolvedTool | null {
  switch (provider.type) {
    case 'tool.httpRequest':
      return buildHttpTool(ctx, provider.params as ToolHttpRequestParams);
    case 'tool.code':
      return buildCodeTool(ctx, provider.params as ToolCodeParams);
    case 'tool.think':
      return buildThinkTool(provider.params as ToolThinkParams);
    case 'tool.subflow':
      return buildSubflowTool(ctx, provider.params as ToolSubflowParams);
    default:
      return null;
  }
}

/**
 * Turn the author's declared `params` rows into a JSON-Schema `parameters`
 * object for the model (PB-T6). No rows → an open object (the model may pass
 * anything). Each row becomes one typed property; `required` rows are listed.
 */
function buildToolParameters(rows: readonly ToolParamRow[] | undefined): Record<string, unknown> {
  if (!rows || rows.length === 0) return { type: 'object', additionalProperties: true };
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const row of rows) {
    const prop: Record<string, unknown> = { type: row.type };
    if (row.description.trim() !== '') prop.description = row.description;
    properties[row.name] = prop;
    if (row.required) required.push(row.name);
  }
  const schema: Record<string, unknown> = { type: 'object', properties, additionalProperties: false };
  if (required.length > 0) schema.required = required;
  return schema;
}

/** tool.httpRequest → a tool that calls an API; model args merge into query/body. */
function buildHttpTool(ctx: NodeCtx, p: ToolHttpRequestParams): ResolvedTool {
  const spec: AiToolSpec = {
    name: p.tool_name,
    description: p.description,
    parameters: buildToolParameters(p.params),
  };
  return {
    spec,
    async run(args) {
      // Credential auth headers form the base set (I7); static rows layer on top.
      const headers: Record<string, string> = {};
      if (p.credentialId.trim() !== '') {
        if (!ctx.credentials) throw new Error('credentials are not available in this context');
        const authHeaders = await ctx.credentials.authHeaders(p.credentialId);
        if (!authHeaders) throw new Error(`credential "${p.credentialId}" not found`);
        Object.assign(headers, authHeaders);
      }
      for (const row of p.headers) headers[row.name] = row.value;

      // GET/HEAD have no body → the model's args become query params; otherwise
      // they form the JSON body (merged over the author's body template).
      const isBodyless = p.method === 'GET' || p.method === 'HEAD';
      let url: string;
      try {
        const u = new URL(p.url);
        if (isBodyless) for (const [k, v] of Object.entries(args)) u.searchParams.append(k, String(v));
        url = u.toString();
      } catch {
        throw new Error(`invalid url "${p.url}"`);
      }

      let body: string | undefined;
      if (!isBodyless && p.body_type !== 'none') {
        if (p.body_type === 'json') {
          const base = p.body.trim() !== '' ? safeJsonObject(p.body) : {};
          body = JSON.stringify({ ...base, ...args });
          if (!hasContentType(headers)) headers['content-type'] = 'application/json';
        } else {
          body = p.body;
        }
      } else if (!isBodyless && Object.keys(args).length > 0) {
        // No body template but the model supplied args → send them as JSON.
        body = JSON.stringify(args);
        if (!hasContentType(headers)) headers['content-type'] = 'application/json';
      }

      const res = await ctx.http.request({
        method: p.method,
        url,
        ...(Object.keys(headers).length > 0 ? { headers } : {}),
        ...(body !== undefined ? { body } : {}),
        ...(p.timeout ? { timeoutMs: parseDuration(p.timeout) } : {}),
      });
      const payload = { statusCode: res.status, body: res.body };
      return JSON.stringify(payload);
    },
  };
}

/** tool.code → a tool that runs sandboxed JS; model args are visible as `$json`. */
function buildCodeTool(ctx: NodeCtx, p: ToolCodeParams): ResolvedTool {
  const spec: AiToolSpec = {
    name: p.tool_name,
    description: p.description,
    parameters: buildToolParameters(p.params),
  };
  const timeoutMs = p.timeout ? Math.min(parseDuration(p.timeout), TOOL_CODE_TIMEOUT_CAP_MS) : TOOL_CODE_TIMEOUT_CAP_MS;
  return {
    spec,
    async run(args) {
      // The model's arguments are the single input item ($json = args).
      const { value, logs } = await ctx.code.run(p.code, [{ json: args }], { timeoutMs });
      for (const line of logs) ctx.log('debug', `tool.code(${p.tool_name}): ${line}`);
      if (value === undefined || value === null) return '(no result)';
      if (typeof value === 'string') return value;
      return JSON.stringify(value);
    },
  };
}

/** tool.think → a no-op scratchpad: returns the model's own thought unchanged. */
function buildThinkTool(p: ToolThinkParams): ResolvedTool {
  const spec: AiToolSpec = {
    name: p.tool_name,
    description: p.description,
    parameters: {
      type: 'object',
      properties: { thought: { type: 'string', description: 'Your step-by-step reasoning.' } },
      required: ['thought'],
      additionalProperties: false,
    },
  };
  return {
    spec,
    async run(args) {
      const thought = typeof args.thought === 'string' ? args.thought : JSON.stringify(args.thought ?? '');
      return thought.trim() !== '' ? thought : '(noted)';
    },
  };
}

/** tool.subflow → a tool that runs another flow of the same bot (n8n Workflow Tool). */
function buildSubflowTool(ctx: NodeCtx, p: ToolSubflowParams): ResolvedTool {
  const name =
    p.tool_name.trim() !== '' ? p.tool_name.trim() : `flow_${p.flow_id.replace(/[^A-Za-z0-9_-]/g, '_')}`;
  const spec: AiToolSpec = {
    name,
    description: p.description.trim() !== '' ? p.description : `Run the "${p.flow_id}" flow as a tool`,
    parameters: buildToolParameters(p.params),
  };
  return {
    spec,
    async run(args) {
      if (!ctx.subflow) throw new Error('sub-flow execution is not available — a subflow tool needs it');
      const { items: returned } = await ctx.subflow.run(p.flow_id, [{ json: args }]);
      if (returned.length === 0) return '(no output)';
      if (returned.length === 1) return JSON.stringify(returned[0]!.json);
      return JSON.stringify(returned.map((i) => i.json));
    },
  };
}

/** Parse a JSON object string for an http tool body template; `{}` on any failure. */
function safeJsonObject(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    /* fall through */
  }
  return {};
}

/** Case-insensitive check for an existing content-type header. */
function hasContentType(headers: Record<string, string>): boolean {
  return Object.keys(headers).some((k) => k.toLowerCase() === 'content-type');
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
