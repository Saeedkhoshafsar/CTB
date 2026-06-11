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
