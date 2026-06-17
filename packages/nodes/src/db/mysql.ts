/**
 * db.mysql — a GENERIC MySQL / MariaDB node (NODES.md §Database connectors,
 * PLAN2 PB-T3). The mirror of `db.postgres`: infrastructure, not a domain
 * (invariant I2). The HOST owns the `mysql2` connection pool (invariant I3 — the
 * driver lives only in `apps/server`); this node reaches the database ONLY
 * through the injected `ctx.db` capability and passes a `credentialId` it never
 * decrypts (invariants I6/I7). It looks identical to db.postgres to a flow
 * author — only the credential type and the SQL dialect differ.
 *
 * The cardinal safety rule is identical: **values are always BOUND, never
 * concatenated.** Every operation builds a parameterized statement with `?`
 * placeholders (the MySQL convention) and hands the values to the driver, so a
 * hostile `{{ }}` expression result can never inject SQL. The only things
 * spliced into the SQL TEXT are IDENTIFIERS (table/column names), and those are
 * validated by a strict identifier regex + backtick-quoted, so they can't carry
 * an injection either.
 *
 * Dialect differences from db.postgres:
 *  - placeholders are `?` (positional, un-numbered) rather than `$1,$2,…`;
 *  - identifiers are quoted with backticks `` `col` `` rather than `"col"`;
 *  - there is no `RETURNING *` — an insert/update/delete returns the driver's
 *    OK packet which the host normalizes to `{ insertId?, affectedRows }` rows.
 *
 * Operations:
 *  - query  → a raw parameterized SQL string + a JSON-array `params`.
 *  - select → ``SELECT * FROM `table` `` + optional where/order_by/limit.
 *  - insert → ``INSERT INTO `table`(…) VALUES(…)``.
 *  - update → ``UPDATE `table` SET … WHERE …``.
 *  - delete → ``DELETE FROM `table` WHERE …`` (guarded by confirm_many).
 *
 * Runs ONCE per node run. The result is mapped per `return_mode`: `rows` → one
 * output item per result row (for a write, the host's normalized OK-packet row);
 * `single` → merge `{ rows, rowCount }` onto every input item under `save_as`
 * (default `db`).
 */
import {
  DbMysqlParamsSchema,
  fail,
  out,
  type DbMysqlParams,
  type DbValueRow,
  type DbWhereRow,
  type FlowItem,
  type NodeDef,
} from '@ctb/shared';

/**
 * A SQL identifier: a name optionally schema/table-qualified with dots, each
 * segment letters/digits/underscore and not starting with a digit. We
 * backtick-quote each segment when emitting so reserved words / mixed case work,
 * but we still validate first so nothing weird (backticks, semicolons, spaces)
 * ever reaches the SQL text.
 */
const IDENT_SEGMENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

function quoteIdent(raw: string): string {
  const name = raw.trim();
  const segments = name.split('.');
  for (const seg of segments) {
    if (!IDENT_SEGMENT.test(seg)) {
      throw new Error(`unsafe SQL identifier: ${JSON.stringify(raw)}`);
    }
  }
  return segments.map((s) => `\`${s}\``).join('.');
}

/**
 * Coerce a resolved expression STRING back to a JS value for binding. Identical
 * to db.postgres: the value rows come through as strings (the executor coerces
 * after resolving expressions); we parse obvious literals so a column typed
 * `int`/`bool` gets a real number/boolean, while leaving everything else as the
 * literal string.
 *  - "" stays "" (an empty string, not null — use the literal `null` for null)
 *  - "null" → null
 *  - "true"/"false" → boolean
 *  - a finite numeric literal → number
 *  - otherwise the string verbatim
 */
function coerceBindValue(raw: string): unknown {
  const t = raw.trim();
  if (t === 'null') return null;
  if (t === 'true') return true;
  if (t === 'false') return false;
  if (t !== '' && /^-?(\d+\.?\d*|\.\d+)$/.test(t)) {
    const n = Number(t);
    if (Number.isFinite(n)) return n;
  }
  return raw;
}

/** Parse the `params` JSON-array string for operation=query. Blank → []. */
function parseQueryParams(raw: string): unknown[] {
  const text = raw.trim();
  if (text === '') return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('params is not valid JSON');
  }
  if (!Array.isArray(parsed)) {
    throw new Error('params must be a JSON array');
  }
  return parsed;
}

const WHERE_OP_SQL: Record<string, string> = {
  eq: '=',
  ne: '<>',
  gt: '>',
  gte: '>=',
  lt: '<',
  lte: '<=',
  like: 'LIKE',
};

/**
 * Build a `WHERE` clause from rows. Returns the SQL fragment (without the
 * leading "WHERE") + the bind values. Unlike Postgres, MySQL uses positional
 * `?` placeholders, so there is no index to thread — the values array order is
 * the placeholder order.
 */
function buildWhere(rows: DbWhereRow[]): { sql: string; params: unknown[] } {
  const parts: string[] = [];
  const params: unknown[] = [];
  for (const row of rows) {
    const col = quoteIdent(row.field);
    switch (row.op) {
      case 'is_null':
        parts.push(`${col} IS NULL`);
        break;
      case 'not_null':
        parts.push(`${col} IS NOT NULL`);
        break;
      case 'in': {
        const list = row.value
          .split(',')
          .map((s) => s.trim())
          .filter((s) => s !== '');
        if (list.length === 0) throw new Error(`where "in" on ${row.field} has no values`);
        const placeholders = list.map(() => '?');
        for (const v of list) params.push(coerceBindValue(v));
        parts.push(`${col} IN (${placeholders.join(', ')})`);
        break;
      }
      default: {
        const opSql = WHERE_OP_SQL[row.op];
        parts.push(`${col} ${opSql} ?`);
        params.push(coerceBindValue(row.value));
      }
    }
  }
  return { sql: parts.join(' AND '), params };
}

/** Build a parameterized statement from the node's params (MySQL dialect). */
function buildStatement(params: DbMysqlParams): { sql: string; values: unknown[] } {
  switch (params.operation) {
    case 'query': {
      return { sql: params.query, values: parseQueryParams(params.params) };
    }
    case 'select': {
      const table = quoteIdent(params.table);
      let sql = `SELECT * FROM ${table}`;
      const values: unknown[] = [];
      if (params.where.length > 0) {
        const w = buildWhere(params.where);
        sql += ` WHERE ${w.sql}`;
        values.push(...w.params);
      }
      if (params.order_by.trim() !== '') {
        sql += ` ORDER BY ${quoteIdent(params.order_by)} ${params.order_dir === 'desc' ? 'DESC' : 'ASC'}`;
      }
      if (params.limit !== undefined) {
        sql += ` LIMIT ${params.limit}`; // integer from the schema — safe to inline
      }
      return { sql, values };
    }
    case 'insert': {
      const table = quoteIdent(params.table);
      const cols = params.values.map((r: DbValueRow) => quoteIdent(r.field));
      const placeholders = params.values.map(() => '?');
      const values = params.values.map((r) => coerceBindValue(r.value));
      const sql = `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${placeholders.join(', ')})`;
      return { sql, values };
    }
    case 'update': {
      const table = quoteIdent(params.table);
      const setParts: string[] = [];
      const values: unknown[] = [];
      for (const r of params.values) {
        setParts.push(`${quoteIdent(r.field)} = ?`);
        values.push(coerceBindValue(r.value));
      }
      const w = buildWhere(params.where);
      values.push(...w.params);
      const sql = `UPDATE ${table} SET ${setParts.join(', ')} WHERE ${w.sql}`;
      return { sql, values };
    }
    case 'delete': {
      const table = quoteIdent(params.table);
      const w = buildWhere(params.where);
      const sql = `DELETE FROM ${table} WHERE ${w.sql}`;
      return { sql, values: w.params };
    }
  }
}

export const dbMysql: NodeDef<DbMysqlParams> = {
  type: 'db.mysql',
  category: 'data',
  meta: { labelKey: 'nodes.db.mysql.label', descriptionKey: 'nodes.db.mysql.desc', icon: 'database' },
  ports: { inputs: ['main'], outputs: ['main'] },
  paramsSchema: DbMysqlParamsSchema,
  async execute(ctx, params, items) {
    if (!ctx.db) {
      return fail('db.mysql: database service is not available in this context');
    }

    // A multi-row write must be opted into (mirrors db.postgres' confirm_many
    // guard) — an UPDATE/DELETE whose WHERE matches many rows is a common
    // footgun. We can't know the match count up front, so the guard is a hard
    // requirement that the author acknowledged a possibly-broad write.
    if ((params.operation === 'update' || params.operation === 'delete') && !params.confirm_many) {
      const single = params.where.length === 1 && params.where[0]!.op === 'eq';
      if (!single) {
        return fail(
          `db.mysql: op "${params.operation}" may affect multiple rows — set confirm_many to allow it`,
        );
      }
    }

    let statement: { sql: string; values: unknown[] };
    try {
      statement = buildStatement(params);
    } catch (err) {
      return fail(`db.mysql: ${err instanceof Error ? err.message : String(err)}`);
    }

    let result: { rows: Record<string, unknown>[]; rowCount: number };
    try {
      result = await ctx.db.query({
        credentialId: params.credentialId,
        dialect: 'mysql',
        sql: statement.sql,
        params: statement.values,
      });
    } catch (err) {
      return fail(`db.mysql: ${err instanceof Error ? err.message : String(err)}`);
    }

    if (params.return_mode === 'rows') {
      // One output item per result row. A write yields the host's normalized
      // OK-packet row(s) (e.g. { insertId, affectedRows }) or none.
      return out({
        main: result.rows.map((row) => ({ json: { ...row } })),
      });
    }

    // single: merge { rows, rowCount } onto every input item under save_as.
    const saveAs = params.save_as ?? 'db';
    const value = { rows: result.rows, rowCount: result.rowCount };
    const input: FlowItem[] = items.length > 0 ? items : [{ json: {} }];
    return out({
      main: input.map((item) => {
        const next: FlowItem = { json: { ...item.json, [saveAs]: value } };
        if (item.binary !== undefined) next.binary = item.binary;
        return next;
      }),
    });
  },
};
