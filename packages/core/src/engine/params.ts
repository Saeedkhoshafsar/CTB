/**
 * Param expression resolution (P1-T4). Before a node executes, every string
 * inside its raw params is template-evaluated against the current item scope:
 *   "Hello {{$json.name}}"  → "Hello علی"      (mixed → string)
 *   "{{$json.age + 1}}"     → 43                (single expr → raw value,
 *                                                so number/boolean schemas pass)
 * Plain strings without {{ }} never touch the sandbox (fast path).
 */
import { evaluateTemplate, type EvaluateOptions } from '../expression/evaluator';
import type { ExpressionScope } from '../expression/scope';

function hasExpression(s: string): boolean {
  return s.includes('{{');
}

export async function resolveParams(
  raw: unknown,
  scope: ExpressionScope,
  opts: EvaluateOptions = {},
  warnings: string[] = [],
): Promise<unknown> {
  if (typeof raw === 'string') {
    if (!hasExpression(raw)) return raw;
    const res = await evaluateTemplate(raw, scope, opts);
    warnings.push(...res.warnings);
    return res.value;
  }
  if (Array.isArray(raw)) {
    const out = [];
    for (const v of raw) out.push(await resolveParams(v, scope, opts, warnings));
    return out;
  }
  if (raw !== null && typeof raw === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(raw)) {
      out[k] = await resolveParams(v, scope, opts, warnings);
    }
    return out;
  }
  return raw;
}
