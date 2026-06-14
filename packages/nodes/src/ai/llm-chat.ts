/**
 * ai.llmChat — LLM Chat (NODES.md §AI nodes, PLAN P5-T1). Sends a prompt to an
 * OpenAI-compatible chat-completions endpoint and merges the reply into each
 * item. The provider is chosen by the selected credential (openAiApi: base_url
 * + key) which the HOST resolves — the node only ever passes a `credentialId`,
 * the model and the messages (invariants I6/I7: the key never reaches here).
 *
 * Runs ONCE per node run (not per item): an LLM call is expensive execution-
 * external work, and `memory: conversation` is a per-CHAT rolling transcript —
 * hitting it N times for N items would multiply cost and scramble the memory.
 * The `user_prompt`/`system_prompt` expressions are resolved against the FIRST
 * item by the executor, so they read like `{{ $json.text }}`. The result lands
 * on EVERY output item under `$json.<save_as>` (default `ai`) as `{ reply, usage }`.
 *
 * memory=conversation: the last N turns (user+assistant) are persisted per chat
 * in KV (scope=user, key `__ai_mem__:<nodeId>`) so two LLM nodes in one flow keep
 * separate memories. The window is trimmed before sending and after replying so
 * the prompt — and the KV row — stay bounded.
 */
import {
  AiLlmChatParamsSchema,
  fail,
  out,
  type AiChatMessage,
  type AiLlmChatParams,
  type FlowItem,
  type NodeDef,
} from '@ctb/shared';

/** KV key prefix for a node's conversation memory (per-chat via scope=user). */
export const AI_MEMORY_KEY_PREFIX = '__ai_mem__:';

export const aiLlmChat: NodeDef<AiLlmChatParams> = {
  type: 'ai.llmChat',
  category: 'ai',
  meta: { labelKey: 'nodes.ai.llmChat.label', descriptionKey: 'nodes.ai.llmChat.desc', icon: 'sparkles' },
  ports: { inputs: ['main'], outputs: ['main'] },
  paramsSchema: AiLlmChatParamsSchema,
  async execute(ctx, params, items) {
    if (!ctx.ai) {
      return fail('ai.llmChat: AI service is not available in this context');
    }

    const saveAs = params.save_as ?? 'ai';
    const memoryKey = `${AI_MEMORY_KEY_PREFIX}${ctx.nodeId}`;

    // Build the message list: system prompt (optional) → prior turns (memory) →
    // the new user turn. Prompts are already expression-resolved by the executor.
    const messages: AiChatMessage[] = [];
    if (params.system_prompt && params.system_prompt.trim() !== '') {
      messages.push({ role: 'system', content: params.system_prompt });
    }

    let history: AiChatMessage[] = [];
    if (params.memory === 'conversation') {
      history = await loadHistory(ctx.kv, memoryKey, params.memory_window);
      messages.push(...history);
    }

    messages.push({ role: 'user', content: params.user_prompt });

    let result: { reply: string; usage: unknown; model?: string };
    try {
      result = await ctx.ai.chat({
        credentialId: params.credentialId,
        model: params.model,
        messages,
        ...(params.temperature !== undefined ? { temperature: params.temperature } : {}),
        ...(params.max_tokens !== undefined ? { maxTokens: params.max_tokens } : {}),
      });
    } catch (err) {
      return fail(`ai.llmChat: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Persist the new turn pair, trimmed to the window (turns = user+assistant).
    if (params.memory === 'conversation') {
      const updated: AiChatMessage[] = [
        ...history,
        { role: 'user', content: params.user_prompt },
        { role: 'assistant', content: result.reply },
      ];
      const trimmed = updated.slice(-params.memory_window * 2);
      await ctx.kv.set('user', memoryKey, trimmed);
    }

    const value = { reply: result.reply, usage: result.usage ?? {}, ...(result.model ? { model: result.model } : {}) };

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
 * Load the persisted conversation history, defensively (a hand-edited or
 * legacy KV value must never crash the node). Keeps only well-formed messages
 * and the most recent `window` turns (window×2 messages).
 */
async function loadHistory(
  kv: { get(scope: 'user' | 'bot' | 'flow', key: string): Promise<unknown> },
  key: string,
  window: number,
): Promise<AiChatMessage[]> {
  const raw = await kv.get('user', key);
  if (!Array.isArray(raw)) return [];
  const msgs: AiChatMessage[] = [];
  for (const m of raw) {
    if (
      m &&
      typeof m === 'object' &&
      'role' in m &&
      'content' in m &&
      (m.role === 'user' || m.role === 'assistant' || m.role === 'system') &&
      typeof (m as { content: unknown }).content === 'string'
    ) {
      msgs.push({ role: m.role, content: (m as { content: string }).content });
    }
  }
  return msgs.slice(-window * 2);
}
