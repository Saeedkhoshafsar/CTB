/**
 * Expression evaluator — sandbox-backed (P1-T2 swap, Decision Log #12).
 *
 * Each `{{ … }}` segment is executed inside the @ctb/sandbox worker pool
 * ('expression' mode): fresh frozen vm realm, no require/process/fs
 * (invariant I6), vm CPU timeout + host hard-kill enforcing the budget
 * preemptively (the P1-T1 stub could only measure after the fact).
 *
 * The API is async — node params are resolved inside the executor's step
 * loop (P1-T4), which is async anyway.
 */
import { ExpressionError } from '@ctb/shared';
import { getDefaultSandboxPool, type SandboxPool } from '@ctb/sandbox';
import type { ExpressionScope } from './scope';
import { isSingleExpression, tokenize } from './tokenizer';

export const EXPRESSION_BUDGET_MS = 50;

export interface EvalOutcome {
  /** Rendered string (or raw value when the template is a single expression). */
  value: unknown;
  /** Non-fatal issues, e.g. missing paths rendered as empty string. */
  warnings: string[];
}

export interface EvaluateOptions {
  /** Override the pool (tests / future per-instance config). */
  pool?: SandboxPool;
  /** Per-expression budget in ms (default {@link EXPRESSION_BUDGET_MS}). */
  budgetMs?: number;
}

async function evalOne(
  code: string,
  raw: string,
  scope: ExpressionScope,
  warnings: string[],
  opts: EvaluateOptions,
): Promise<unknown> {
  if (code === '') {
    warnings.push(`empty expression ${raw}`);
    return '';
  }
  const pool = opts.pool ?? getDefaultSandboxPool();
  const budgetMs = opts.budgetMs ?? EXPRESSION_BUDGET_MS;
  let result: unknown;
  try {
    const res = await pool.run(code, scope as Record<string, unknown>, {
      mode: 'expression',
      timeoutMs: budgetMs,
    });
    result = res.value;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/timeout/i.test(msg)) {
      throw new ExpressionError(`expression exceeded ${budgetMs}ms budget: ${msg}`, code);
    }
    throw new ExpressionError(`expression failed: ${msg}`, code);
  }
  if (result === undefined || result === null) {
    warnings.push(`expression ${raw} evaluated to ${result === undefined ? 'undefined' : 'null'}`);
    return '';
  }
  return result;
}

function stringify(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return String(value);
  }
}

/**
 * Evaluate a template. Returns the raw value when the whole template is a
 * single `{{ expr }}` (so numbers/objects survive), otherwise a joined string.
 */
export async function evaluateTemplate(
  template: string,
  scope: ExpressionScope,
  opts: EvaluateOptions = {},
): Promise<EvalOutcome> {
  const warnings: string[] = [];
  const tokens = tokenize(template);

  if (tokens.length === 0) return { value: '', warnings };

  if (isSingleExpression(tokens)) {
    const t = tokens[0] as { kind: 'expr'; code: string; raw: string };
    return { value: await evalOne(t.code, t.raw, scope, warnings, opts), warnings };
  }

  let out = '';
  for (const token of tokens) {
    if (token.kind === 'text') out += token.text;
    else out += stringify(await evalOne(token.code, token.raw, scope, warnings, opts));
  }
  return { value: out, warnings };
}

/** Convenience: always-string rendering (what most node params need). */
export async function renderTemplate(
  template: string,
  scope: ExpressionScope,
  opts: EvaluateOptions = {},
): Promise<EvalOutcome> {
  const res = await evaluateTemplate(template, scope, opts);
  return { value: stringify(res.value), warnings: res.warnings };
}
