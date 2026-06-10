import { SandboxError } from '@ctb/shared';
import { afterAll, describe, expect, it } from 'vitest';
import { SandboxPool } from '../src/pool';

const pool = new SandboxPool({ maxWorkers: 4 });
afterAll(async () => {
  await pool.destroy();
});

describe('SandboxPool (P1-T2)', () => {
  it('returns a value from script mode (return)', async () => {
    const res = await pool.run('return 1 + 2;');
    expect(res.value).toBe(3);
  });

  it('returns the raw value in expression mode (number, object, string)', async () => {
    expect((await pool.run('21 * 2', {}, { mode: 'expression' })).value).toBe(42);
    expect((await pool.run('({ a: 1 })', {}, { mode: 'expression' })).value).toEqual({ a: 1 });
    expect((await pool.run('"سلام".toUpperCase()', {}, { mode: 'expression' })).value).toBe('سلام');
  });

  it('scope values are visible inside the realm', async () => {
    const res = await pool.run('return $json.name + "/" + $vars.n;', {
      $json: { name: 'علی' },
      $vars: { n: 7 },
    });
    expect(res.value).toBe('علی/7');
  });

  it('process / require / fs access are undefined inside', async () => {
    const res = await pool.run(
      'return [typeof process, typeof require, typeof globalThis, typeof fetch, typeof Buffer];',
    );
    expect(res.value).toEqual(['undefined', 'undefined', 'undefined', 'undefined', 'undefined']);
  });

  it('eval and Function-from-string are blocked (codeGeneration: strings:false)', async () => {
    await expect(pool.run('return [].constructor.constructor("return 1")();')).rejects.toThrow(
      SandboxError,
    );
  });

  it('scope objects are deep-frozen (strict-mode write throws)', async () => {
    await expect(
      pool.run('$json.user.name = "hack"; return 1;', { $json: { user: { name: 'x' } } }),
    ).rejects.toThrow(/read only|not extensible|Cannot assign/i);
  });

  it('while(true) is killed at timeout and the pool survives', async () => {
    await expect(pool.run('while (true) {}', {}, { timeoutMs: 200 })).rejects.toThrow(/timeout/i);
    // pool must still serve new work
    const after = await pool.run('return "alive";');
    expect(after.value).toBe('alive');
  });

  it('async hang is hard-killed by the host and the pool survives', async () => {
    await expect(
      pool.run('await new Promise(() => {}); return 1;', {}, { timeoutMs: 200 }),
    ).rejects.toThrow(/timeout/i);
    const after = await pool.run('return "alive2";');
    expect(after.value).toBe('alive2');
  });

  it('capability call ($kv.get stub) round-trips over MessagePort', async () => {
    const store = new Map<string, unknown>([['points', 99]]);
    const res = await pool.run(
      'const v = await $kv.get("points"); await $kv.set("points", v + 1); return v;',
      {},
      {
        capabilities: {
          $kv: {
            get: async (key) => store.get(String(key)),
            set: async (key, value) => void store.set(String(key), value),
          },
        },
      },
    );
    expect(res.value).toBe(99);
    expect(store.get('points')).toBe(100);
  });

  it('capability errors propagate as catchable errors inside the realm', async () => {
    const res = await pool.run(
      'try { await $http.get("https://blocked"); return "no-error"; } catch (e) { return "cap: " + e.message; }',
      {},
      { capabilities: { $http: { get: async () => { throw new Error('host says no'); } } } },
    );
    expect(res.value).toBe('cap: host says no');
  });

  it('undeclared capability method does not exist inside the realm', async () => {
    await expect(
      pool.run('return await $kv.drop("x");', {}, { capabilities: { $kv: { get: async () => 1 } } }),
    ).rejects.toThrow(/not a function/);
  });

  it('console output is captured into logs', async () => {
    const res = await pool.run(
      'console.log("hello", { a: 1 }); console.warn("careful"); return 0;',
    );
    expect(res.logs).toEqual(['hello {"a":1}', '[warn] careful']);
  });

  it('thrown errors become SandboxError with the message', async () => {
    await expect(pool.run('throw new Error("boom");')).rejects.toThrow(SandboxError);
    await expect(pool.run('throw new Error("boom");')).rejects.toThrow(/boom/);
  });

  it('20 parallel runs do not deadlock', async () => {
    const runs = Array.from({ length: 20 }, (_, i) =>
      pool.run(`return ${i} * 2;`, {}, { timeoutMs: 5000 }),
    );
    const results = await Promise.all(runs);
    expect(results.map((r) => r.value)).toEqual(Array.from({ length: 20 }, (_, i) => i * 2));
  });

  it('parallel mix of good + timing-out runs leaves the pool healthy', async () => {
    const mixed = await Promise.allSettled([
      pool.run('return "ok1";'),
      pool.run('while (true) {}', {}, { timeoutMs: 150 }),
      pool.run('return "ok2";'),
      pool.run('await new Promise(() => {});', {}, { timeoutMs: 150 }),
    ]);
    expect(mixed[0]).toMatchObject({ status: 'fulfilled' });
    expect(mixed[1]).toMatchObject({ status: 'rejected' });
    expect(mixed[2]).toMatchObject({ status: 'fulfilled' });
    expect(mixed[3]).toMatchObject({ status: 'rejected' });
    expect((await pool.run('return "healthy";')).value).toBe('healthy');
  });

  it('destroyed pool rejects new work', async () => {
    const p2 = new SandboxPool();
    await p2.destroy();
    await expect(p2.run('return 1;')).rejects.toThrow(/destroyed/);
  });
});
