/**
 * ai.classify — AI Classify (NODES.md §AI nodes, PLAN P5-T2). A Switch powered
 * by an LLM: the model is asked to pick exactly ONE of the configured
 * categories for the `input` text, and the incoming items are routed to that
 * category's output port. An unrecognized/empty answer falls through to the
 * reserved `other` port.
 *
 * Like ai.llmChat the provider call happens HOST-side via `ctx.ai.chat()` — the
 * node only ever passes a `credentialId` + model + messages (invariants I6/I7:
 * the decrypted key never reaches here). Runs ONCE per node run: one LLM call
 * decides the route for the whole batch (the typical use is "route THIS
 * conversation turn", a single value); classifying N items separately would
 * multiply cost. The chosen `{ category }` is merged onto each routed item
 * under `$json.<save_as>` (default `classification`).
 *
 * Ports: dynamic — one per category (+ `other`), via dynamicOutputs (registry +
 * canvas share the SAME key convention through shared `classifyOutputs`).
 */
import {
  AiClassifyParamsSchema,
  classifyOutputs,
  fail,
  out,
  type AiChatMessage,
  type AiClassifyParams,
  type FlowItem,
  type NodeDef,
  type PortName,
} from '@ctb/shared';

export const aiClassify: NodeDef<AiClassifyParams> = {
  type: 'ai.classify',
  category: 'ai',
  meta: { labelKey: 'nodes.ai.classify.label', descriptionKey: 'nodes.ai.classify.desc', icon: 'split' },
  ports: { inputs: ['main'], outputs: [] },
  dynamicOutputs: (params) => classifyOutputs(params),
  paramsSchema: AiClassifyParamsSchema,
  async execute(ctx, params, items) {
    if (!ctx.ai) {
      return fail('ai.classify: AI service is not available in this context');
    }

    const saveAs = params.save_as ?? 'classification';
    const validKeys = new Set(params.categories.map((c) => c.key));

    // Build the instruction: list each category key + description, then demand a
    // single key back. A low temperature keeps routing deterministic.
    const categoryList = params.categories
      .map((c) => `- ${c.key}${c.description.trim() !== '' ? `: ${c.description}` : ''}`)
      .join('\n');
    const instruction =
      `You are a strict text classifier. Choose the SINGLE best category for the user's message ` +
      `from the list below. Reply with ONLY the category key, exactly as written, and nothing else. ` +
      `If none clearly fit, reply with "other".\n\nCategories:\n${categoryList}`;

    const messages: AiChatMessage[] = [];
    const systemParts: string[] = [];
    if (params.system_prompt && params.system_prompt.trim() !== '') systemParts.push(params.system_prompt.trim());
    systemParts.push(instruction);
    messages.push({ role: 'system', content: systemParts.join('\n\n') });
    messages.push({ role: 'user', content: params.input });

    let reply: string;
    try {
      const result = await ctx.ai.chat({
        credentialId: params.credentialId,
        model: params.model,
        messages,
        ...(params.temperature !== undefined ? { temperature: params.temperature } : {}),
      });
      reply = result.reply;
    } catch (err) {
      return fail(`ai.classify: ${err instanceof Error ? err.message : String(err)}`);
    }

    const category = matchCategory(reply, validKeys);

    // Pre-seed every port (including `other`) so downstream wiring is honored
    // even on the branches that received nothing.
    const outputs: Partial<Record<PortName, FlowItem[]>> = {};
    for (const port of classifyOutputs(params)) outputs[port] = [];

    const input: FlowItem[] = items.length > 0 ? items : [{ json: {} }];
    const routed: FlowItem[] = input.map((it) => {
      const next: FlowItem = { json: { ...it.json, [saveAs]: { category } } };
      if (it.binary !== undefined) next.binary = it.binary;
      return next;
    });
    outputs[category] = routed;

    return out(outputs);
  },
};

/**
 * Resolve the model's free-text reply to a known category key (or `other`).
 * Tolerant of surrounding punctuation/whitespace and case: an exact key match
 * (case-insensitive) wins; otherwise the first key that appears as a whole
 * token in the reply; else `other`.
 */
function matchCategory(reply: string, validKeys: Set<string>): string {
  const cleaned = reply.trim().replace(/^["'`]+|["'`.]+$/g, '').trim();
  const lower = cleaned.toLowerCase();

  for (const key of validKeys) {
    if (key.toLowerCase() === lower) return key;
  }
  // Whole-token containment (handles replies like "Category: refund").
  const tokens = new Set(lower.split(/[^a-z0-9_.-]+/i).filter(Boolean));
  for (const key of validKeys) {
    if (tokens.has(key.toLowerCase())) return key;
  }
  return 'other';
}
