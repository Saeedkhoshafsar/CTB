/**
 * Tokenizer for `{{ … }}` expression templates (ARCHITECTURE §6).
 * Splits a template string into literal-text and expression segments.
 * No nesting: the first `}}` after a `{{` closes it. Unclosed `{{` is literal text.
 */

export type Token =
  | { kind: 'text'; text: string }
  | { kind: 'expr'; code: string; raw: string };

export function tokenize(template: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  let textStart = 0;

  while (i < template.length) {
    if (template[i] === '{' && template[i + 1] === '{') {
      const close = template.indexOf('}}', i + 2);
      if (close === -1) break; // unclosed → rest is literal text
      if (i > textStart) tokens.push({ kind: 'text', text: template.slice(textStart, i) });
      const raw = template.slice(i, close + 2);
      tokens.push({ kind: 'expr', code: template.slice(i + 2, close).trim(), raw });
      i = close + 2;
      textStart = i;
    } else {
      i++;
    }
  }
  if (textStart < template.length) {
    tokens.push({ kind: 'text', text: template.slice(textStart) });
  }
  return tokens;
}

/** True when the template is exactly one expression (so its raw value can be returned). */
export function isSingleExpression(tokens: Token[]): boolean {
  return tokens.length === 1 && tokens[0]?.kind === 'expr';
}
