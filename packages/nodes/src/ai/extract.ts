/**
 * ai.extract — AI Extract (NODES.md §AI nodes, PLAN P5-T2). Pulls structured
 * JSON out of free text: the model is asked to return a JSON object matching the
 * configured `fields`, the node parses + shape-checks it and, on failure,
 * RE-ASKS up to `max_retries` times before failing. The extracted object lands
 * in `$json.<save_as>` (default `extracted`) on every output item.
 *
 * Provider call is HOST-side via `ctx.ai.chat()` (invariants I6/I7 — the key
 * never reaches here). Runs ONCE per node run (plus retries): the extraction
 * targets the resolved `input` (a single value), and one LLM call should not be
 * multiplied by the item count.
 */
import {
  AiExtractParamsSchema,
  fail,
  out,
  type AiChatMessage,
  type AiExtractParams,
  type ExtractField,
  type FlowItem,
  type NodeDef,
} from '@ctb/shared';

export const aiExtract: NodeDef<AiExtractParams> = {
  type: 'ai.extract',
  category: 'ai',
  meta: { labelKey: 'nodes.ai.extract.label', descriptionKey: 'nodes.ai.extract.desc', icon: 'braces' },
  ports: { inputs: ['main'], outputs: ['main'] },
  paramsSchema: AiExtractParamsSchema,
  async execute(ctx, params, items) {
    if (!ctx.ai) {
      return fail('ai.extract: AI service is not available in this context');
    }

    const saveAs = params.save_as ?? 'extracted';

    const schemaLines = params.fields
      .map(
        (f) =>
          `- ${f.name} (${f.type}${f.required ? ', required' : ''})` +
          (f.description.trim() !== '' ? `: ${f.description}` : ''),
      )
      .join('\n');
    const instruction =
      `Extract the following fields from the user's message and reply with ONLY a single JSON ` +
      `object — no markdown, no code fences, no commentary. Use the exact field names and types ` +
      `below. If a value is genuinely not present, use null (unless the field is required, in ` +
      `which case do your best to infer it).\n\nFields:\n${schemaLines}`;

    const systemParts: string[] = [];
    if (params.system_prompt && params.system_prompt.trim() !== '') systemParts.push(params.system_prompt.trim());
    systemParts.push(instruction);
    const systemContent = systemParts.join('\n\n');

    const maxAttempts = params.max_retries + 1;
    let lastError = '';
    let extracted: Record<string, unknown> | null = null;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const messages: AiChatMessage[] = [
        { role: 'system', content: systemContent },
        { role: 'user', content: params.input },
      ];
      // On a retry, tell the model what went wrong so it can correct.
      if (attempt > 0 && lastError !== '') {
        messages.push({
          role: 'system',
          content: `Your previous reply was rejected: ${lastError}. Reply again with ONLY the JSON object.`,
        });
      }

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
        return fail(`ai.extract: ${err instanceof Error ? err.message : String(err)}`);
      }

      const parsed = parseJsonObject(reply);
      if (!parsed.ok) {
        lastError = parsed.error;
        continue;
      }

      const checked = coerceAndValidate(parsed.value, params.fields);
      if (!checked.ok) {
        lastError = checked.error;
        continue;
      }
      extracted = checked.value;
      break;
    }

    if (extracted === null) {
      return fail(`ai.extract: could not extract valid JSON after ${maxAttempts} attempt(s): ${lastError}`);
    }

    const input: FlowItem[] = items.length > 0 ? items : [{ json: {} }];
    return out({
      main: input.map((it) => {
        const next: FlowItem = { json: { ...it.json, [saveAs]: extracted } };
        if (it.binary !== undefined) next.binary = it.binary;
        return next;
      }),
    });
  },
};

/**
 * Parse a JSON object from a model reply, tolerant of ```json fences and of
 * leading/trailing prose around the object.
 */
function parseJsonObject(reply: string): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  let text = reply.trim();
  // Strip a fenced code block if present.
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence && fence[1] !== undefined) text = fence[1].trim();
  // If there's surrounding prose, slice from the first { to the last }.
  if (!text.startsWith('{')) {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start !== -1 && end > start) text = text.slice(start, end + 1);
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, error: 'reply was not valid JSON' };
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, error: 'reply was not a JSON object' };
  }
  return { ok: true, value: value as Record<string, unknown> };
}

/**
 * Coerce each field to its declared type and enforce `required`. Only the
 * declared fields are kept (unknown keys dropped). On a required-miss or an
 * uncoercible value, returns an error so the node can retry.
 */
function coerceAndValidate(
  raw: Record<string, unknown>,
  fields: ExtractField[],
): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  const result: Record<string, unknown> = {};
  for (const field of fields) {
    const present = Object.prototype.hasOwnProperty.call(raw, field.name);
    const v = present ? raw[field.name] : undefined;
    const missing = !present || v === undefined || v === null || (typeof v === 'string' && v.trim() === '');

    if (missing) {
      if (field.required) return { ok: false, error: `missing required field "${field.name}"` };
      result[field.name] = null;
      continue;
    }

    const coerced = coerceType(v, field.type);
    if (coerced === SENTINEL) {
      if (field.required) return { ok: false, error: `field "${field.name}" is not a valid ${field.type}` };
      result[field.name] = null;
      continue;
    }
    result[field.name] = coerced;
  }
  return { ok: true, value: result };
}

/** Unique marker for "could not coerce" (distinct from a legitimate null/0/false). */
const SENTINEL = Symbol('uncoercible');

function coerceType(value: unknown, type: ExtractField['type']): unknown | typeof SENTINEL {
  switch (type) {
    case 'string':
      return typeof value === 'string' ? value : typeof value === 'number' || typeof value === 'boolean' ? String(value) : SENTINEL;
    case 'number': {
      if (typeof value === 'number' && Number.isFinite(value)) return value;
      if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
      return SENTINEL;
    }
    case 'boolean': {
      if (typeof value === 'boolean') return value;
      if (typeof value === 'string') {
        const l = value.trim().toLowerCase();
        if (l === 'true' || l === 'yes' || l === '1') return true;
        if (l === 'false' || l === 'no' || l === '0') return false;
      }
      return SENTINEL;
    }
    default:
      return SENTINEL;
  }
}
