/**
 * i18n namespace fallback (UI review fix) — guards the param-help collision.
 *
 * Several node types reuse a param NAMED `mode` (and `target`) with totally
 * different meanings. Help text is keyed by param name, so a bare
 * `paramDesc.mode` is shared by ALL of them — flow.merge / data.code /
 * flow.executeSubFlow inherited flow.wait's "duration/until" text (a real bug
 * caught in the UI render review). The fix resolves `paramDesc.<nodeType>.<key>`
 * before the bare `paramDesc.<key>`. This test pins that resolution against the
 * REAL catalogs so the per-node overrides can never silently regress.
 */
import { describe, expect, it } from 'vitest';
import { fa } from '../src/i18n/fa';
import { en } from '../src/i18n/en';
import type { MessageKey } from '../src/i18n';

/** Mirror of widgets.tsx resolveNs(): `<base>.<ns>.<key>` → `<base>.<key>`. */
function resolveNs(
  catalog: Record<string, string>,
  base: string,
  ns: string,
  key: string,
): string | undefined {
  if (ns) {
    const nsKey = `${base}.${ns}.${key}`;
    if (catalog[nsKey] !== undefined) return catalog[nsKey];
  }
  return catalog[`${base}.${key}`];
}

const catalogs: Record<'fa' | 'en', Record<string, string>> = { fa, en };

describe('i18n namespace fallback for shared param keys', () => {
  for (const locale of ['fa', 'en'] as const) {
    const cat: Record<string, string> = catalogs[locale];

    it(`[${locale}] paramDesc.mode resolves per node type (no collision)`, () => {
      const wait = resolveNs(cat, 'paramDesc', 'flow.wait', 'mode');
      const merge = resolveNs(cat, 'paramDesc', 'flow.merge', 'mode');
      const code = resolveNs(cat, 'paramDesc', 'data.code', 'mode');
      const sub = resolveNs(cat, 'paramDesc', 'flow.executeSubFlow', 'mode');

      // every mode-bearing node gets a non-empty help text
      for (const d of [wait, merge, code, sub]) {
        expect(d, 'each node has mode help').toBeTruthy();
      }
      // and they are all DISTINCT — the bug was them all being identical
      const set = new Set([wait, merge, code, sub]);
      expect(set.size, 'mode help is node-specific').toBe(4);

      // flow.wait keeps the bare key (its natural home), the others override it
      expect(merge).not.toBe(wait);
      expect(code).not.toBe(wait);
      expect(sub).not.toBe(wait);
    });

    it(`[${locale}] paramDesc.target differs for tg.editMessage vs data nodes`, () => {
      const dataTarget = resolveNs(cat, 'paramDesc', 'data.setFields', 'target');
      const editTarget = resolveNs(cat, 'paramDesc', 'tg.editMessage', 'target');
      expect(dataTarget).toBeTruthy();
      expect(editTarget).toBeTruthy();
      expect(editTarget).not.toBe(dataTarget);
    });

    it(`[${locale}] unknown namespace falls back to the bare key`, () => {
      const bare = cat['paramDesc.mode'];
      expect(resolveNs(cat, 'paramDesc', 'tg.sendMessage', 'mode')).toBe(bare);
      // empty namespace = legacy behaviour
      expect(resolveNs(cat, 'paramDesc', '', 'mode')).toBe(bare);
    });
  }

  it('fa and en carry the same set of namespaced override keys', () => {
    const overrides = (cat: Record<string, string>) =>
      Object.keys(cat)
        .filter((k) => /^(param|paramDesc|option|ph)\.[a-z]+\.[a-zA-Z]+\./.test(k))
        .sort();
    expect(overrides(fa)).toEqual(overrides(en));
  });

  it('every override key is a valid catalog MessageKey', () => {
    const keys: MessageKey[] = [
      'paramDesc.flow.merge.mode',
      'paramDesc.data.code.mode',
      'paramDesc.flow.executeSubFlow.mode',
      'paramDesc.tg.editMessage.target',
    ];
    for (const k of keys) expect(fa[k]).toBeTruthy();
  });
});
