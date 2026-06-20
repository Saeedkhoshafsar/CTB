/**
 * db.mysql contract tests (PB-T3, NODES.md §Database connectors).
 *
 * The MySQL/MariaDB mirror of db.postgres: a GENERIC primitive over the injected
 * ctx.db capability (invariants I2/I3/I6/I7 — the node never sees the DSN; it
 * passes a credentialId + a fully parameterized statement and the HOST owns the
 * `mysql2` pool). Same contract as db.postgres, with the MySQL dialect:
 *
 *   - statement building: query/select/insert/update/delete emit the expected
 *     SQL text with `?` placeholders and the matching bound values (NO RETURNING);
 *   - identifiers (table/column) are validated + backtick-quoted, unsafe ones fail;
 *   - every request carries `dialect: 'mysql'` so the host routes to mysql2;
 *   - SQL-injection safety: VALUES are always bound (never concatenated);
 *   - confirm_many guard: a broad update/delete is refused unless confirmed;
 *   - return_mode: `rows` → one item per row; `single` → merge {rows,rowCount};
 *   - no-db (ctx.db === null) + a transport error fail loudly. Runs once.
 */
import { NodeRegistry } from '@ctb/core';
import type { DbQueryRequest } from '@ctb/shared';
import { describe, expect, it } from 'vitest';
import { builtinNodes, dbMysql, registerBuiltinNodes } from '../src/index';
import { item, makeCtx, params } from './node-harness';

/** Pull the single recorded query (asserting exactly one ran). */
function onlyCall(calls: DbQueryRequest[]): DbQueryRequest {
  expect(calls).toHaveLength(1);
  return calls[0]!;
}

describe('registry (PB-T3)', () => {
  it('registers db.mysql; registry is 53 types', () => {
    const reg = registerBuiltinNodes(new NodeRegistry());
    expect(reg.has('db.mysql')).toBe(true);
    expect(builtinNodes.length).toBe(61);
  });

  it('db.mysql is a `data` node, main → main', () => {
    expect(dbMysql.category).toBe('data');
    expect(dbMysql.ports).toEqual({ inputs: ['main'], outputs: ['main'] });
  });
});

// ── params schema ────────────────────────────────────────────────────────────

describe('DbMysqlParamsSchema', () => {
  it('defaults operation=query, return_mode=rows, save_as=db', () => {
    const p = params(dbMysql, { credentialId: 'c1', query: 'SELECT 1' });
    expect(p.operation).toBe('query');
    expect(p.return_mode).toBe('rows');
    expect(p.save_as).toBe('db');
  });

  it('rejects query without SQL', () => {
    expect(() => params(dbMysql, { credentialId: 'c1', operation: 'query' })).toThrow();
  });

  it('rejects select/insert/update/delete without a table', () => {
    expect(() => params(dbMysql, { credentialId: 'c1', operation: 'select' })).toThrow();
  });

  it('rejects insert without values', () => {
    expect(() =>
      params(dbMysql, { credentialId: 'c1', operation: 'insert', table: 't' }),
    ).toThrow();
  });

  it('rejects update without values + where', () => {
    expect(() =>
      params(dbMysql, {
        credentialId: 'c1',
        operation: 'update',
        table: 't',
        values: [{ field: 'a', value: '1' }],
      }),
    ).toThrow();
  });

  it('rejects delete without where', () => {
    expect(() =>
      params(dbMysql, { credentialId: 'c1', operation: 'delete', table: 't' }),
    ).toThrow();
  });

  it('rejects an invalid save_as identifier', () => {
    expect(() =>
      params(dbMysql, { credentialId: 'c1', query: 'SELECT 1', save_as: '1bad' }),
    ).toThrow();
  });
});

// ── operation=query ────────────────────────────────────────────────────────────

describe('db.mysql — query', () => {
  it('forwards raw SQL + JSON-array params verbatim (parameterized, dialect=mysql)', async () => {
    const ctx = makeCtx({ db: { result: { rows: [{ id: 1 }], rowCount: 1 } } });
    const p = params(dbMysql, {
      credentialId: 'cred1',
      operation: 'query',
      query: 'SELECT * FROM users WHERE id = ? AND active = ?',
      params: '[7, true]',
      return_mode: 'rows',
    });
    const res = await dbMysql.execute(ctx, p, [item({})]);

    const call = onlyCall(ctx.dbCalls);
    expect(call.credentialId).toBe('cred1');
    expect(call.dialect).toBe('mysql');
    expect(call.sql).toBe('SELECT * FROM users WHERE id = ? AND active = ?');
    expect(call.params).toEqual([7, true]);
    if (res.kind !== 'items') throw new Error('expected items');
    expect(res.outputs.main).toEqual([{ json: { id: 1 } }]);
  });

  it('treats a blank params as []', async () => {
    const ctx = makeCtx({});
    const p = params(dbMysql, { credentialId: 'c1', operation: 'query', query: 'SELECT 1', params: '  ' });
    await dbMysql.execute(ctx, p, [item({})]);
    expect(onlyCall(ctx.dbCalls).params).toEqual([]);
  });

  it('fails loudly on non-array / non-JSON params', async () => {
    const ctx = makeCtx({});
    const p = params(dbMysql, { credentialId: 'c1', operation: 'query', query: 'SELECT 1', params: '{"a":1}' });
    const res = await dbMysql.execute(ctx, p, [item({})]);
    expect(res.kind).toBe('error');
    expect(ctx.dbCalls).toHaveLength(0);
  });
});

// ── operation=select ───────────────────────────────────────────────────────────

describe('db.mysql — select', () => {
  it('builds SELECT * with parameterized WHERE, ORDER BY and LIMIT (backtick idents)', async () => {
    const ctx = makeCtx({ db: { result: { rows: [{ id: 3 }, { id: 2 }], rowCount: 2 } } });
    const p = params(dbMysql, {
      credentialId: 'c1',
      operation: 'select',
      table: 'app.orders',
      where: [{ field: 'status', op: 'eq', value: 'open' }],
      order_by: 'created_at',
      order_dir: 'desc',
      limit: 10,
    });
    const res = await dbMysql.execute(ctx, p, [item({})]);

    const call = onlyCall(ctx.dbCalls);
    expect(call.sql).toBe(
      'SELECT * FROM `app`.`orders` WHERE `status` = ? ORDER BY `created_at` DESC LIMIT 10',
    );
    expect(call.params).toEqual(['open']);
    if (res.kind !== 'items') throw new Error('expected items');
    expect(res.outputs.main).toHaveLength(2); // one item per row
  });

  it('uses positional ? across multiple where rows + handles in/is_null', async () => {
    const ctx = makeCtx({});
    const p = params(dbMysql, {
      credentialId: 'c1',
      operation: 'select',
      table: 't',
      where: [
        { field: 'tier', op: 'in', value: 'gold, silver' },
        { field: 'age', op: 'gte', value: '18' },
        { field: 'deleted_at', op: 'is_null', value: '' },
      ],
    });
    await dbMysql.execute(ctx, p, [item({})]);
    const call = onlyCall(ctx.dbCalls);
    expect(call.sql).toBe(
      'SELECT * FROM `t` WHERE `tier` IN (?, ?) AND `age` >= ? AND `deleted_at` IS NULL',
    );
    expect(call.params).toEqual(['gold', 'silver', 18]);
  });
});

// ── operation=insert ───────────────────────────────────────────────────────────

describe('db.mysql — insert', () => {
  it('builds INSERT … VALUES(…) with bound values (NO RETURNING)', async () => {
    const ctx = makeCtx({ db: { result: { rows: [{ insertId: 99, affectedRows: 1 }], rowCount: 1 } } });
    const p = params(dbMysql, {
      credentialId: 'c1',
      operation: 'insert',
      table: 'users',
      values: [
        { field: 'name', value: 'Sara' },
        { field: 'age', value: '30' },
        { field: 'active', value: 'true' },
      ],
    });
    const res = await dbMysql.execute(ctx, p, [item({})]);
    const call = onlyCall(ctx.dbCalls);
    expect(call.sql).toBe('INSERT INTO `users` (`name`, `age`, `active`) VALUES (?, ?, ?)');
    expect(call.params).toEqual(['Sara', 30, true]);
    if (res.kind !== 'items') throw new Error('expected items');
    // the host's normalized OK-packet row flows through as a result row
    expect(res.outputs.main).toEqual([{ json: { insertId: 99, affectedRows: 1 } }]);
  });
});

// ── operation=update / delete (+ confirm_many guard) ────────────────────────────

describe('db.mysql — update', () => {
  it('builds UPDATE … SET … WHERE … with positional ? (NO RETURNING)', async () => {
    const ctx = makeCtx({});
    const p = params(dbMysql, {
      credentialId: 'c1',
      operation: 'update',
      table: 'users',
      values: [{ field: 'name', value: 'Ali' }],
      where: [{ field: 'id', op: 'eq', value: '7' }],
    });
    await dbMysql.execute(ctx, p, [item({})]);
    const call = onlyCall(ctx.dbCalls);
    expect(call.sql).toBe('UPDATE `users` SET `name` = ? WHERE `id` = ?');
    expect(call.params).toEqual(['Ali', 7]);
  });

  it('allows a single-eq WHERE without confirm_many', async () => {
    const ctx = makeCtx({});
    const p = params(dbMysql, {
      credentialId: 'c1',
      operation: 'update',
      table: 't',
      values: [{ field: 'a', value: '1' }],
      where: [{ field: 'id', op: 'eq', value: '5' }],
    });
    const res = await dbMysql.execute(ctx, p, [item({})]);
    expect(res.kind).toBe('items');
    expect(ctx.dbCalls).toHaveLength(1);
  });

  it('refuses a broad WHERE (non-eq) without confirm_many', async () => {
    const ctx = makeCtx({});
    const p = params(dbMysql, {
      credentialId: 'c1',
      operation: 'update',
      table: 't',
      values: [{ field: 'a', value: '1' }],
      where: [{ field: 'age', op: 'gte', value: '18' }],
    });
    const res = await dbMysql.execute(ctx, p, [item({})]);
    expect(res.kind).toBe('error');
    if (res.kind !== 'error') throw new Error('expected error');
    expect(res.message).toMatch(/confirm_many/);
    expect(ctx.dbCalls).toHaveLength(0); // never reached the DB
  });

  it('allows a broad WHERE when confirm_many is set', async () => {
    const ctx = makeCtx({});
    const p = params(dbMysql, {
      credentialId: 'c1',
      operation: 'update',
      table: 't',
      values: [{ field: 'a', value: '1' }],
      where: [{ field: 'age', op: 'gte', value: '18' }],
      confirm_many: true,
    });
    const res = await dbMysql.execute(ctx, p, [item({})]);
    expect(res.kind).toBe('items');
    expect(ctx.dbCalls).toHaveLength(1);
  });
});

describe('db.mysql — delete', () => {
  it('builds DELETE … WHERE … with bound values (NO RETURNING)', async () => {
    const ctx = makeCtx({});
    const p = params(dbMysql, {
      credentialId: 'c1',
      operation: 'delete',
      table: 'sessions',
      where: [{ field: 'id', op: 'eq', value: 'abc' }],
    });
    await dbMysql.execute(ctx, p, [item({})]);
    const call = onlyCall(ctx.dbCalls);
    expect(call.sql).toBe('DELETE FROM `sessions` WHERE `id` = ?');
    expect(call.params).toEqual(['abc']);
  });

  it('refuses a multi-condition delete without confirm_many', async () => {
    const ctx = makeCtx({});
    const p = params(dbMysql, {
      credentialId: 'c1',
      operation: 'delete',
      table: 't',
      where: [
        { field: 'a', op: 'eq', value: '1' },
        { field: 'b', op: 'eq', value: '2' },
      ],
    });
    const res = await dbMysql.execute(ctx, p, [item({})]);
    expect(res.kind).toBe('error');
    expect(ctx.dbCalls).toHaveLength(0);
  });
});

// ── SQL-injection safety (identifiers validated + backtick-quoted) ──────────────

describe('db.mysql — identifier safety', () => {
  it('fails loudly on an unsafe table identifier', async () => {
    const ctx = makeCtx({});
    const p = params(dbMysql, {
      credentialId: 'c1',
      operation: 'select',
      table: 'users; DROP TABLE users; --',
    });
    const res = await dbMysql.execute(ctx, p, [item({})]);
    expect(res.kind).toBe('error');
    if (res.kind !== 'error') throw new Error('expected error');
    expect(res.message).toMatch(/unsafe SQL identifier/i);
    expect(ctx.dbCalls).toHaveLength(0);
  });

  it('fails loudly on a backtick-bearing identifier', async () => {
    const ctx = makeCtx({});
    const p = params(dbMysql, {
      credentialId: 'c1',
      operation: 'select',
      table: '`users`',
    });
    const res = await dbMysql.execute(ctx, p, [item({})]);
    expect(res.kind).toBe('error');
    expect(ctx.dbCalls).toHaveLength(0);
  });

  it('fails loudly on an unsafe column identifier in where', async () => {
    const ctx = makeCtx({});
    const p = params(dbMysql, {
      credentialId: 'c1',
      operation: 'select',
      table: 't',
      where: [{ field: 'id = 1 OR 1=1', op: 'eq', value: 'x' }],
    });
    const res = await dbMysql.execute(ctx, p, [item({})]);
    expect(res.kind).toBe('error');
    expect(ctx.dbCalls).toHaveLength(0);
  });

  it('keeps a hostile VALUE bound (never concatenated) so it cannot inject', async () => {
    const ctx = makeCtx({});
    const evil = "x'); DROP TABLE users; --";
    const p = params(dbMysql, {
      credentialId: 'c1',
      operation: 'insert',
      table: 'users',
      values: [{ field: 'name', value: evil }],
    });
    await dbMysql.execute(ctx, p, [item({})]);
    const call = onlyCall(ctx.dbCalls);
    expect(call.sql).toBe('INSERT INTO `users` (`name`) VALUES (?)');
    expect(call.params).toEqual([evil]); // the payload is data, not SQL
  });
});

// ── return_mode = single ────────────────────────────────────────────────────────

describe('db.mysql — return_mode=single', () => {
  it('merges { rows, rowCount } under save_as onto every input item', async () => {
    const ctx = makeCtx({ db: { result: { rows: [{ id: 1 }, { id: 2 }], rowCount: 2 } } });
    const p = params(dbMysql, {
      credentialId: 'c1',
      operation: 'query',
      query: 'SELECT id FROM t',
      return_mode: 'single',
    });
    const res = await dbMysql.execute(ctx, p, [item({ a: 1 }), item({ a: 2 })]);
    if (res.kind !== 'items') throw new Error('expected items');
    expect(res.outputs.main).toHaveLength(2);
    expect(res.outputs.main![0]!.json).toEqual({
      a: 1,
      db: { rows: [{ id: 1 }, { id: 2 }], rowCount: 2 },
    });
    expect(res.outputs.main![1]!.json).toEqual({
      a: 2,
      db: { rows: [{ id: 1 }, { id: 2 }], rowCount: 2 },
    });
  });

  it('honours a custom save_as and still emits one item on empty input', async () => {
    const ctx = makeCtx({ db: { result: { rows: [], rowCount: 0 } } });
    const p = params(dbMysql, {
      credentialId: 'c1',
      operation: 'query',
      query: 'SELECT 1',
      return_mode: 'single',
      save_as: 'my',
    });
    const res = await dbMysql.execute(ctx, p, []);
    if (res.kind !== 'items') throw new Error('expected items');
    expect(res.outputs.main).toHaveLength(1);
    expect(res.outputs.main![0]!.json).toEqual({ my: { rows: [], rowCount: 0 } });
  });

  it('preserves binary on passthrough items', async () => {
    const ctx = makeCtx({});
    const p = params(dbMysql, {
      credentialId: 'c1',
      operation: 'query',
      query: 'SELECT 1',
      return_mode: 'single',
    });
    const withBinary = { json: { a: 1 }, binary: { file: { kind: 'tg_file_id' as const, fileId: 'f1' } } };
    const res = await dbMysql.execute(ctx, p, [withBinary]);
    if (res.kind !== 'items') throw new Error('expected items');
    expect(res.outputs.main![0]!.binary).toEqual(withBinary.binary);
  });
});

// ── runs once + failure modes ───────────────────────────────────────────────────

describe('db.mysql — once + failures', () => {
  it('runs once per node run regardless of item count', async () => {
    const ctx = makeCtx({});
    const p = params(dbMysql, { credentialId: 'c1', operation: 'query', query: 'SELECT 1' });
    await dbMysql.execute(ctx, p, [item({ a: 1 }), item({ a: 2 }), item({ a: 3 })]);
    expect(ctx.dbCalls).toHaveLength(1);
  });

  it('fails loudly when ctx.db is null (no driver in this instance)', async () => {
    const ctx = makeCtx({ db: null });
    const p = params(dbMysql, { credentialId: 'c1', operation: 'query', query: 'SELECT 1' });
    const res = await dbMysql.execute(ctx, p, [item({})]);
    expect(res.kind).toBe('error');
    if (res.kind !== 'error') throw new Error('expected error');
    expect(res.message).toMatch(/not available/i);
  });

  it('surfaces a DB/transport error from ctx.db.query', async () => {
    const ctx = makeCtx({ db: { error: 'connection refused' } });
    const p = params(dbMysql, { credentialId: 'c1', operation: 'query', query: 'SELECT 1' });
    const res = await dbMysql.execute(ctx, p, [item({})]);
    expect(res.kind).toBe('error');
    if (res.kind !== 'error') throw new Error('expected error');
    expect(res.message).toMatch(/connection refused/);
  });
});
