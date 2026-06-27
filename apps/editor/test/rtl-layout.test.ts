import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * RTL/LTR layout guard.
 *
 * The product is Persian-first (`dir="rtl"`), but the node-settings (NDV) and
 * the executions log I/O panes must ALWAYS read the same way:
 *
 *   visual LEFT  = INPUT  (= the previous node's output)
 *   visual CENTER (NDV)   = the node's own params/fields
 *   visual RIGHT = OUTPUT (= this node's output)
 *
 * The DOM order in both views is INPUT -> (params) -> OUTPUT. In a plain RTL
 * grid that order flips (INPUT would land on the right), which is exactly the
 * bug the user reported ("سمت راست خروجی، سمت چپ ورودی"). We pin the column
 * flow with `direction: ltr` on the grid container and restore `direction: rtl`
 * on each pane's content. This test fails loudly if that contract is dropped.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(resolve(__dirname, '../src/styles.css'), 'utf8');

/** Extract the body `{ ... }` of the first rule whose selector matches exactly. */
function ruleBody(selector: string): string {
  const idx = css.indexOf(selector);
  expect(idx, `selector ${selector} should exist in styles.css`).toBeGreaterThan(-1);
  const open = css.indexOf('{', idx);
  const close = css.indexOf('}', open);
  return css.slice(open + 1, close);
}

describe('NDV / log-io always lay out INPUT-left, OUTPUT-right (RTL contract)', () => {
  it('.ndv-body pins the three columns left->right with direction: ltr', () => {
    const body = ruleBody('.ndv-body {');
    expect(body).toMatch(/direction:\s*ltr/);
    // params stay in the centre column.
    expect(body).toMatch(/grid-template-columns:\s*1fr\s+minmax\([^)]*\)\s+1fr/);
  });

  it('.ndv-body children restore RTL for their inner content', () => {
    const body = ruleBody('.ndv-body > * {');
    expect(body).toMatch(/direction:\s*rtl/);
  });

  it('.log-io pins INPUT-left / OUTPUT-right with direction: ltr', () => {
    const body = ruleBody('.log-io {');
    expect(body).toMatch(/direction:\s*ltr/);
  });

  it('.log-io children restore RTL for their inner content', () => {
    const body = ruleBody('.log-io > * {');
    expect(body).toMatch(/direction:\s*rtl/);
  });
});
