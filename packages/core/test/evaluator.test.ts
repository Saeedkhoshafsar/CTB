import { ExpressionError } from '@ctb/shared';
import { describe, expect, it } from 'vitest';
import {
  buildScope,
  evaluateTemplate,
  makeNowHelper,
  renderTemplate,
} from '../src/expression/index';

const scope = (json: Record<string, unknown> = {}, vars: Record<string, unknown> = {}) =>
  buildScope({ json, vars });

describe('expression evaluator (P1-T1 stub)', () => {
  it('plain string passes through untouched', () => {
    const res = evaluateTemplate('no expressions here', scope());
    expect(res.value).toBe('no expressions here');
    expect(res.warnings).toEqual([]);
  });

  it('interpolates values into text', () => {
    const res = evaluateTemplate(
      'Hi {{ $json.user.first_name }}!',
      scope({ user: { first_name: 'علی' } }),
    );
    expect(res.value).toBe('Hi علی!');
  });

  it('resolves nested paths', () => {
    const res = evaluateTemplate(
      '{{ $json.a.b.c }}',
      scope({ a: { b: { c: 'deep' } } }),
    );
    expect(res.value).toBe('deep');
  });

  it('single expression returns the RAW value (number, object)', () => {
    expect(evaluateTemplate('{{ $json.n }}', scope({ n: 42 })).value).toBe(42);
    expect(evaluateTemplate('{{ $json.o }}', scope({ o: { k: 1 } })).value).toEqual({ k: 1 });
    expect(evaluateTemplate('{{ 1 + 2 }}', scope()).value).toBe(3);
  });

  it('missing path via optional chaining → empty string + warning collected', () => {
    const res = evaluateTemplate('val: {{ $json.missing?.deep }}', scope({}));
    expect(res.value).toBe('val: ');
    expect(res.warnings).toHaveLength(1);
    expect(res.warnings[0]).toContain('undefined');
  });

  it('expression throwing → typed ExpressionError', () => {
    expect(() => evaluateTemplate('{{ $json.a.b.c }}', scope({}))).toThrow(ExpressionError);
    try {
      evaluateTemplate('{{ nope( }}', scope());
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ExpressionError);
      expect((err as ExpressionError).expression).toBe('nope(');
    }
  });

  it('enforces the 50ms budget', () => {
    expect(() =>
      evaluateTemplate('{{ (() => { let i = 0; while (i < 2e9) i++; return i; })() }}', scope()),
    ).toThrow(/budget/);
  });

  it('$vars / $env / $flow are visible in scope', () => {
    const s = buildScope({
      vars: { name: 'مریم' },
      env: { BRAND: 'CTB' },
      flow: { id: 'f1', name: 'demo' },
    });
    expect(evaluateTemplate('{{ $vars.name }} @ {{ $env.BRAND }}/{{ $flow.name }}', s).value).toBe(
      'مریم @ CTB/demo',
    );
  });

  it('$now helper formats dates', () => {
    const fixed = () => new Date('2026-06-10T12:34:56Z');
    const s = buildScope({ now: fixed });
    const res = evaluateTemplate('{{ $now.format("YYYY-MM-DD") }}', s);
    expect(res.value).toBe('2026-06-10');
    expect(makeNowHelper(fixed).iso()).toBe('2026-06-10T12:34:56.000Z');
  });

  it('standard JS string/number/array methods work', () => {
    expect(evaluateTemplate('{{ $json.s.toUpperCase() }}', scope({ s: 'ok' })).value).toBe('OK');
    expect(
      evaluateTemplate('{{ $items.length }}', buildScope({ items: [{ json: {} }, { json: {} }] }))
        .value,
    ).toBe(2);
    expect(evaluateTemplate('{{ [1,2,3].map(x => x * 2).join(",") }}', scope()).value).toBe(
      '2,4,6',
    );
  });

  it('shadowed globals are undefined inside expressions', () => {
    expect(evaluateTemplate('{{ typeof process }}', scope()).value).toBe('undefined');
    expect(evaluateTemplate('{{ typeof require }}', scope()).value).toBe('undefined');
    expect(evaluateTemplate('{{ typeof globalThis }}', scope()).value).toBe('undefined');
    expect(evaluateTemplate('{{ typeof fetch }}', scope()).value).toBe('undefined');
  });

  it('scope objects are frozen (writes fail in strict mode)', () => {
    expect(() => evaluateTemplate('{{ ($vars.x = 1) }}', scope())).toThrow(ExpressionError);
  });

  it('renderTemplate always returns a string', () => {
    expect(renderTemplate('{{ $json.n }}', scope({ n: 7 })).value).toBe('7');
    expect(renderTemplate('{{ $json.o }}', scope({ o: { a: 1 } })).value).toBe('{"a":1}');
  });

  it('empty expression {{}} → empty string + warning', () => {
    const res = evaluateTemplate('x{{}}y', scope());
    expect(res.value).toBe('xy');
    expect(res.warnings[0]).toContain('empty');
  });
});
