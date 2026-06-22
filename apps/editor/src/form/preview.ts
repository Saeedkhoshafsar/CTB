/**
 * Live expression preview (G-T2) — pure, DOM-free, browser-safe.
 *
 * DESIGN DECISION (PLAN3 G-T2, logged): the editor previews `{{ … }}` by
 * resolving it CLIENT-SIDE with a tiny SAFE path-resolver — NOT by calling the
 * real engine. Two reasons:
 *   1. the engine's evaluator (packages/core/src/expression) runs every segment
 *      inside the @ctb/sandbox Node-vm worker pool — that cannot run in a
 *      browser at all.
 *   2. a server `/preview-expression` round-trip would re-introduce the very
 *      50ms sandbox-budget cold-start flakiness we just cured in PR #73, for a
 *      feature whose whole point is instant keystroke feedback.
 *
 * So we support the COMMON, SIDE-EFFECT-FREE subset that drag-to-map produces
 * and users actually type for a preview: scope-root access (`$json`, `$vars`,
 * `$items`, `$now`, …), dotted / bracketed property paths, array indexing, a
 * handful of `$now` helper calls, and bare string/number/boolean literals.
 * Anything outside that subset is reported as "no preview available" — we NEVER
 * evaluate arbitrary code, and we NEVER throw. The real engine remains the
 * single source of truth at run time; this is advisory UI only.
 */

import { makeNowHelper, type NowHelper } from './expression';

/** The data a preview resolves against — mirrors the engine scope roots we support. */
export interface PreviewScope {
  $json: Record<string, unknown>;
  $vars: Record<string, unknown>;
  $items: unknown[];
  $now: NowHelper;
}

export interface PreviewResult {
  /** 'value' — resolved ok; 'empty' — nothing to preview; 'unsupported' — outside the safe subset. */
  kind: 'value' | 'empty' | 'unsupported';
  /** A short, display-ready rendering of the resolved value (only when kind==='value'). */
  text?: string;
}

const NO_PREVIEW: PreviewResult = { kind: 'unsupported' };
const EMPTY: PreviewResult = { kind: 'empty' };

/** Build a preview scope from the latest run's first input item (browser-safe). */
export function buildPreviewScope(input: {
  json?: Record<string, unknown>;
  vars?: Record<string, unknown>;
  items?: unknown[];
  now?: () => Date;
}): PreviewScope {
  return {
    $json: input.json ?? {},
    $vars: input.vars ?? {},
    $items: input.items ?? [],
    $now: makeNowHelper(input.now),
  };
}

// ── the safe template / expression resolver ─────────────────────────────────

const TEMPLATE_RE = /\{\{.*?\}\}/gs;

/**
 * Resolve a template string for preview. A lone `{{ expr }}` previews the RAW
 * value (matching the engine, see core/engine/params.ts); a mixed template
 * previews the concatenated string. Returns 'empty' when there's nothing to
 * show and 'unsupported' when any segment falls outside the safe subset.
 */
export function previewExpression(template: string, scope: PreviewScope): PreviewResult {
  if (typeof template !== 'string' || template === '') return EMPTY;

  const matches = [...template.matchAll(TEMPLATE_RE)];
  if (matches.length === 0) return EMPTY; // a literal — the Fixed input already shows it

  // Lone single expression → raw value (engine parity).
  if (matches.length === 1 && matches[0]?.[0] === template) {
    const code = template.slice(2, -2).trim();
    const r = resolveExpr(code, scope);
    return r.ok ? { kind: 'value', text: renderValue(r.value) } : NO_PREVIEW;
  }

  // Mixed template → render each segment to a string and concatenate.
  let out = '';
  let last = 0;
  for (const m of matches) {
    if (m.index > last) out += template.slice(last, m.index);
    const code = m[0].slice(2, -2).trim();
    const r = resolveExpr(code, scope);
    if (!r.ok) return NO_PREVIEW;
    out += stringifySegment(r.value);
    last = m.index + m[0].length;
  }
  if (last < template.length) out += template.slice(last);
  return { kind: 'value', text: out };
}

interface Resolved {
  ok: boolean;
  value?: unknown;
}

const FAIL: Resolved = { ok: false };

/** Resolve ONE expression's code against the scope, safely. */
export function resolveExpr(code: string, scope: PreviewScope): Resolved {
  if (code === '') return FAIL;

  // Bare literals: 'str' | "str" | number | true | false | null
  const lit = literalOf(code);
  if (lit !== NO_LITERAL) return { ok: true, value: lit };

  // A safe access chain rooted at a scope variable: $root(.prop|[idx]|["k"]|())*
  return resolveChain(code, scope);
}

const NO_LITERAL = Symbol('no-literal');

function literalOf(code: string): unknown {
  if (/^-?\d+(\.\d+)?$/.test(code)) return Number(code);
  if (code === 'true') return true;
  if (code === 'false') return false;
  if (code === 'null') return null;
  const str = code.match(/^'([^']*)'$|^"([^"]*)"$/);
  if (str) return str[1] ?? str[2] ?? '';
  return NO_LITERAL;
}

// chain segment matchers — order matters: try call, bracket, then dotted prop
const SEG_RE =
  /^\s*(?:\.([A-Za-z_$][\w$]*)|\[\s*(\d+)\s*\]|\[\s*'([^']*)'\s*\]|\[\s*"([^"]*)"\s*\]|(\(\s*\)))/;

const ROOT_RE = /^(\$[A-Za-z][\w$]*)/;

/** A few read-only, deterministic `$now` helpers we allow to be called with no args. */
const NOW_NULLARY = new Set(['ts', 'iso', 'date']);

function resolveChain(code: string, scope: PreviewScope): Resolved {
  const root = code.match(ROOT_RE);
  const rootName = root?.[1];
  if (!rootName || !(rootName in scope)) return FAIL;
  let current: unknown = (scope as unknown as Record<string, unknown>)[rootName];
  let rest = code.slice(rootName.length);
  let prevKey: string | null = null; // the property name we just stepped onto (for nullary calls)

  while (rest.length > 0) {
    const seg = rest.match(SEG_RE);
    if (!seg) return FAIL; // operators, spaces-as-syntax, function args… → unsupported
    const [matched, prop, idx, sQ, dQ, call] = seg;

    if (call !== undefined) {
      // only `$now.<nullary>()` is permitted
      if (current instanceof Function && prevKey && NOW_NULLARY.has(prevKey)) {
        try {
          current = (current as () => unknown)();
        } catch {
          return FAIL;
        }
        prevKey = null;
      } else {
        return FAIL;
      }
    } else {
      const key = prop ?? sQ ?? dQ ?? (idx !== undefined ? idx : undefined);
      if (key === undefined) return FAIL;
      if (current === null || current === undefined) {
        // path walks past a missing value → engine renders '' ; preview shows empty string
        current = undefined;
      } else if (typeof current === 'object' || current instanceof Function) {
        current = (current as Record<string, unknown>)[key];
      } else {
        return FAIL; // can't index a primitive
      }
      prevKey = typeof key === 'string' ? key : null;
    }
    rest = rest.slice(matched.length);
  }
  return { ok: true, value: current };
}

// ── value → display text ────────────────────────────────────────────────────

const MAX_LEN = 200;

/** Render a resolved RAW value for the single-expression case. */
export function renderValue(value: unknown): string {
  if (value === undefined) return '';
  if (value === null) return 'null';
  if (typeof value === 'string') return clip(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value instanceof Function) return '';
  try {
    return clip(JSON.stringify(value));
  } catch {
    return '';
  }
}

/** Render a value embedded inside a mixed template (objects → JSON, like the engine renderer). */
function stringifySegment(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return '';
  }
}

function clip(s: string): string {
  return s.length > MAX_LEN ? `${s.slice(0, MAX_LEN)}…` : s;
}
