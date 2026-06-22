/**
 * Expression-awareness helpers (P2-T3) — pure, DOM-free.
 *
 * Splits a template string into literal / `{{ expression }}` segments for the
 * highlight overlay, and exposes the scope-variable hints the dropdown offers
 * (mirrors the engine's scope builder — ARCHITECTURE §6).
 */

export interface Segment {
  text: string;
  expr: boolean;
}

/**
 * MIME type for dropping a data-field expression onto an expression input
 * (n8n-style drag-to-map, P2-T3.5). Lives in the PURE half of the form
 * engine so both sides — the canvas data panel (drag source) and the
 * ExpressionInput widget (drop target) — share it without DOM imports.
 */
export const FIELD_DRAG_MIME = 'application/x-ctb-field-expr';

/**
 * Tokenize like the engine: `{{ ... }}` non-greedy; an unclosed `{{` is a
 * literal (the core tokenizer treats it the same way, so the highlight never
 * promises an expression the engine won't evaluate).
 */
export function splitSegments(text: string): Segment[] {
  const out: Segment[] = [];
  const re = /\{\{.*?\}\}/gs;
  let last = 0;
  for (const m of text.matchAll(re)) {
    if (m.index > last) out.push({ text: text.slice(last, m.index), expr: false });
    out.push({ text: m[0], expr: true });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last), expr: false });
  return out;
}

export function hasExpression(text: string): boolean {
  return /\{\{.*?\}\}/s.test(text);
}

// ── Fixed | Expression field mode (G-T1) ─────────────────────────────────────
//
// A "simple" field (number / select / duration / single-line text) can be edited
// either as a literal value (Fixed) or as an expression string (Expression). The
// mode is INFERRED from the value, not stored separately — a value containing
// `{{ }}` is an expression, anything else is fixed. This keeps the stored params
// identical to what the engine already accepts (a lone `{{ … }}` resolves to the
// raw value before Zod runs — see core/engine/params.ts), so no schema change is
// needed and Fixed↔Expression is a pure, lossless string/value conversion.

export type FieldMode = 'fixed' | 'expression';

/**
 * The mode a value is currently in. A string with `{{ }}` ⇒ expression; an empty
 * string / undefined / a plain literal ⇒ fixed. (An empty value stays "fixed" so
 * a freshly-shown field doesn't surprise the user with the expression editor.)
 */
export function fieldModeOf(value: unknown): FieldMode {
  return typeof value === 'string' && hasExpression(value) ? 'expression' : 'fixed';
}

/**
 * Convert a value when the user flips the toggle, preserving their work
 * (n8n behaviour):
 *  • → expression: render the current literal as a string seed the user can
 *    extend (numbers/booleans become their text; an empty value becomes '').
 *    We do NOT auto-wrap in `{{ }}` — the user types the expression; the box is
 *    the expression editor and the `{x}` helper inserts `{{ … }}` scaffolding.
 *  • → fixed: keep an expression string AS-IS so nothing is lost (the Fixed
 *    widget shows it verbatim); a non-string value passes through unchanged.
 * Switching back and forth therefore never drops the user's text.
 */
export function convertFieldMode(to: FieldMode, value: unknown): unknown {
  if (to === 'expression') {
    if (value === undefined || value === null) return '';
    return typeof value === 'string' ? value : String(value);
  }
  // to 'fixed' — leave the value untouched (string expr kept verbatim, others as-is).
  return value;
}

/** Scope roots available inside expressions (ARCHITECTURE §6). */
export const SCOPE_HINTS: { name: string; example: string }[] = [
  { name: '$json', example: '{{ $json.text }}' },
  { name: '$vars', example: '{{ $vars.name }}' },
  { name: '$user', example: '{{ $user.first_name }}' },
  { name: '$chat', example: '{{ $chat.id }}' },
  { name: '$items', example: '{{ $items.length }}' },
  { name: '$execution', example: '{{ $execution.id }}' },
  { name: '$flow', example: '{{ $flow.name }}' },
  { name: '$env', example: '{{ $env.MY_KEY }}' },
  { name: '$now', example: "{{ $now.format('YYYY-MM-DD') }}" },
];

/**
 * Insert a scope hint at the caret. If the caret is already inside an open
 * `{{ }}` pair, inserts just the variable name; otherwise wraps it in
 * `{{ … }}`. Returns the new text and the new caret position.
 */
export function insertHint(
  text: string,
  caret: number,
  hint: string,
): { text: string; caret: number } {
  const before = text.slice(0, caret);
  const after = text.slice(caret);
  const open = before.lastIndexOf('{{');
  const close = before.lastIndexOf('}}');
  const insideExpr = open !== -1 && open > close;
  const snippet = insideExpr ? `${hint}` : `{{ ${hint} }}`;
  const caretOffset = insideExpr ? snippet.length : snippet.length - 3; // before " }}"
  return { text: before + snippet + after, caret: caret + caretOffset };
}
