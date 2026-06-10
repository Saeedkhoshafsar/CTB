import { ExpressionError } from '@ctb/shared';
import { destroyDefaultSandboxPool } from '@ctb/sandbox';
import { afterAll, describe, expect, it } from 'vitest';
import {
  buildScope,
  evaluateTemplate,
  makeNowHelper,
  renderTemplate,
} from '../src/expression/index';

afterAll(async () => {
  await destroyDefaultSandboxPool();
});

const scope = (json: Record<string, unknown> = {}, vars: Record<string, unknown> = {}) =>
  buildScope({ json, vars });

describe('expression evaluator (sandbox-backed, P1-T2)', () => {
  it('plain string passes through untouched', async () => {
    const res = await evaluateTemplate('no expressions here', scope());
    expect(res.value).toBe('no expressions here');
    expect(res.warnings).toEqual([]);
  });

  it('interpolates values into text', async () => {
    const res = await evaluateTemplate(
      'Hi {{ $json.user.first_name }}!',
      scope({ user: { first_name: 'علی' } }),
    );
    expect(res.value).toBe('Hi علی!');
  });

  it('resolves nested paths', async () => {
    const res = await evaluateTemplate(
      '{{ $json.a.b.c }}',
      scope({ a: { b: { c: 'deep' } } }),
    );
    expect(res.value).toBe('deep');
  });

  it('single expression returns the RAW value (number, object)', async () => {
    expect((await evaluateTemplate('{{ $json.n }}', scope({ n: 42 }))).value).toBe(42);
    expect((await evaluateTemplate('{{ $json.o }}', scope({ o: { k: 1 } }))).value).toEqual({
      k: 1,
    });
    expect((await evaluateTemplate('{{ 1 + 2 }}', scope())).value).toBe(3);
  });

  it('missing path via optional chaining → empty string + warning collected', async () => {
    const res = await evaluateTemplate('val: {{ $json.missing?.deep }}', scope({}));
    expect(res.value).toBe('val: ');
    expect(res.warnings).toHaveLength(1);
    expect(res.warnings[0]).toContain('undefined');
  });

  it('expression throwing → typed ExpressionError', async () => {
    await expect(evaluateTemplate('{{ $json.a.b.c }}', scope({}))).rejects.toThrow(
      ExpressionError,
    );
    try {
      await evaluateTemplate('{{ nope( }}', scope());
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ExpressionError);
      expect((err as ExpressionError).expression).toBe('nope(');
    }
  });

  it('enforces the budget preemptively (infinite loop is killed)', async () => {
    await expect(
      evaluateTemplate('{{ (() => { let i = 0; while (true) i++; })() }}', scope()),
    ).rejects.toThrow(/budget/);
  }, 10_000);

  it('$vars / $env / $flow are visible in scope', async () => {
    const s = buildScope({
      vars: { name: 'مریم' },
      env: { BRAND: 'CTB' },
      flow: { id: 'f1', name: 'demo' },
    });
    expect(
      (await evaluateTemplate('{{ $vars.name }} @ {{ $env.BRAND }}/{{ $flow.name }}', s)).value,
    ).toBe('مریم @ CTB/demo');
  });

  it('$now helper formats dates (survives the worker hop)', async () => {
    const fixed = () => new Date('2026-06-10T12:34:56Z');
    const s = buildScope({ now: fixed });
    const res = await evaluateTemplate('{{ $now.format("YYYY") }}', s);
    expect(res.value).toBe('2026');
    expect((await evaluateTemplate('{{ $now.ts() }}', s)).value).toBe(fixed().getTime());
    expect(makeNowHelper(fixed).iso()).toBe('2026-06-10T12:34:56.000Z');
  });

  it('standard JS string/number/array methods work', async () => {
    expect((await evaluateTemplate('{{ $json.s.toUpperCase() }}', scope({ s: 'ok' }))).value).toBe(
      'OK',
    );
    expect(
      (
        await evaluateTemplate(
          '{{ $items.length }}',
          buildScope({ items: [{ json: {} }, { json: {} }] }),
        )
      ).value,
    ).toBe(2);
    expect((await evaluateTemplate('{{ [1,2,3].map(x => x * 2).join(",") }}', scope())).value).toBe(
      '2,4,6',
    );
  });

  it('process / require / globalThis / fetch are undefined inside expressions', async () => {
    expect((await evaluateTemplate('{{ typeof process }}', scope())).value).toBe('undefined');
    expect((await evaluateTemplate('{{ typeof require }}', scope())).value).toBe('undefined');
    expect((await evaluateTemplate('{{ typeof globalThis }}', scope())).value).toBe('undefined');
    expect((await evaluateTemplate('{{ typeof fetch }}', scope())).value).toBe('undefined');
  });

  it('scope objects are frozen (writes fail in strict mode)', async () => {
    await expect(evaluateTemplate('{{ ($vars.x = 1) }}', scope())).rejects.toThrow(
      ExpressionError,
    );
  });

  it('renderTemplate always returns a string', async () => {
    expect((await renderTemplate('{{ $json.n }}', scope({ n: 7 }))).value).toBe('7');
    expect((await renderTemplate('{{ $json.o }}', scope({ o: { a: 1 } }))).value).toBe('{"a":1}');
  });

  it('empty expression {{}} → empty string + warning', async () => {
    const res = await evaluateTemplate('x{{}}y', scope());
    expect(res.value).toBe('xy');
    expect(res.warnings[0]).toContain('empty');
  });
});
