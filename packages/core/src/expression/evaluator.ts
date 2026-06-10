/**
 * Expression evaluator (P1-T1 stub implementation).
 *
 * Per PLAN.md: this version executes the inner JS expression with
 * `new Function` over a frozen scope. It will be SWAPPED for the
 * worker_threads sandbox in P1-T2 (Decision Log entry required then).
 *
 * Notes on the stub's safety posture:
 * - scope objects are frozen; `globalThis`/`process`/`require` are shadowed
 *   with undefined parameters so naive escapes fail;
 * - the 50ms budget is enforced by measuring elapsed wall time after the
 *   synchronous call — a hard preemptive kill is only possible in the
 *   P1-T2 worker sandbox.
 */
import { ExpressionError } from '@ctb/shared';
import type { ExpressionScope } from './scope';
import { isSingleExpression, tokenize } from './tokenizer';

export const EXPRESSION_BUDGET_MS = 50;

export interface EvalOutcome {
  /** Rendered string (or raw value when the template is a single expression). */
  value: unknown;
  /** Non-fatal issues, e.g. missing paths rendered as empty string. */
  warnings: string[];
}

// NOTE: `eval`/`arguments` cannot be parameter names in strict mode — strict
// mode itself already blocks indirect access patterns; the P1-T2 worker
// sandbox provides the real isolation (invariant I6).
const SHADOWED_GLOBALS = [
  'globalThis',
  'process',
  'require',
  'module',
  'exports',
  'Function',
  'fetch',
  'setTimeout',
  'setInterval',
  'setImmediate',
] as const;

function compile(code: string): (scope: ExpressionScope) => unknown {
  const scopeKeys = [
    '$json',
    '$items',
    '$vars',
    '$user',
    '$chat',
    '$execution',
    '$flow',
    '$env',
    '$now',
  ];
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const fn = new Function(
    ...scopeKeys,
    ...SHADOWED_GLOBALS,
    `"use strict"; return (${code});`,
  ) as (...args: unknown[]) => unknown;
  return (scope: ExpressionScope) =>
    fn(
      scope.$json,
      scope.$items,
      scope.$vars,
      scope.$user,
      scope.$chat,
      scope.$execution,
      scope.$flow,
      scope.$env,
      scope.$now,
      // shadowed globals → undefined
      ...SHADOWED_GLOBALS.map(() => undefined),
    );
}

function evalOne(code: string, raw: string, scope: ExpressionScope, warnings: string[]): unknown {
  if (code === '') {
    warnings.push(`empty expression ${raw}`);
    return '';
  }
  const started = Date.now();
  let result: unknown;
  try {
    result = compile(code)(scope);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new ExpressionError(`expression failed: ${msg}`, code);
  }
  const elapsed = Date.now() - started;
  if (elapsed > EXPRESSION_BUDGET_MS) {
    throw new ExpressionError(
      `expression exceeded ${EXPRESSION_BUDGET_MS}ms budget (took ${elapsed}ms)`,
      code,
    );
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
export function evaluateTemplate(template: string, scope: ExpressionScope): EvalOutcome {
  const warnings: string[] = [];
  const tokens = tokenize(template);

  if (tokens.length === 0) return { value: '', warnings };

  if (isSingleExpression(tokens)) {
    const t = tokens[0] as { kind: 'expr'; code: string; raw: string };
    return { value: evalOne(t.code, t.raw, scope, warnings), warnings };
  }

  let out = '';
  for (const token of tokens) {
    if (token.kind === 'text') out += token.text;
    else out += stringify(evalOne(token.code, token.raw, scope, warnings));
  }
  return { value: out, warnings };
}

/** Convenience: always-string rendering (what most node params need). */
export function renderTemplate(template: string, scope: ExpressionScope): EvalOutcome {
  const res = evaluateTemplate(template, scope);
  return { value: stringify(res.value), warnings: res.warnings };
}
