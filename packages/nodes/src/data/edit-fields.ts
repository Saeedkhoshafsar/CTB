/**
 * data.editFields — Edit Fields (Set) (NODES.md §Data & code; PLAN2 PA-T3).
 *
 * The n8n "Edit Fields / Set" power node — a richer sibling of data.setFields.
 * Rows of assignments applied to each item's $json (immutably — input items are
 * never mutated) or to the execution's $vars (once per node run). Each row adds
 * three powers over the basic Set node:
 *   • op `rename` — move a value from one dotted path (`name`) to another
 *     (`value`, the destination path), deleting the source.
 *   • `value_mode: 'json'` — interpret a STRING `value` as raw JSON
 *     (`"[1,2]"` → a real array; a non-string value passes through unchanged).
 *   • `enabled` — a disabled row is skipped entirely (kept in config, not run).
 *
 * Dotted names create nested objects (`user.level` → `{user:{level}}`).
 * `keep_only_set` makes the output $json start empty, holding only the fields
 * this node's json-target rows set/rename into it. Empty input still emits one
 * shaped item so an Edit Fields placed right after a trigger can seed the run.
 */
import {
  DataEditFieldsParamsSchema,
  fail,
  out,
  type DataEditFieldsParams,
  type EditFieldRow,
  type FlowItem,
  type NodeDef,
} from '@ctb/shared';

export const dataEditFields: NodeDef<DataEditFieldsParams> = {
  type: 'data.editFields',
  category: 'data',
  meta: { labelKey: 'nodes.data.editFields.label', descriptionKey: 'nodes.data.editFields.desc', icon: 'pencil' },
  ports: { inputs: ['main'], outputs: ['main'] },
  paramsSchema: DataEditFieldsParamsSchema,
  async execute(ctx, params, items) {
    const active = params.fields.filter((f) => f.enabled);
    const jsonRows = active.filter((f) => f.target === 'json');
    const varsRows = active.filter((f) => f.target === 'vars');

    // Resolve each row's effective value + rename destination up front so a bad
    // json-mode value or an empty rename target fails the whole run loudly here
    // (rather than throwing mid-item-map). Both are deterministic per row.
    let jsonPlan: PlannedRow[];
    let varsPlan: PlannedRow[];
    try {
      jsonPlan = jsonRows.map(planRow);
      varsPlan = varsRows.map(planRow);
    } catch (err) {
      return fail(`data.editFields: ${(err as Error).message}`);
    }

    // $vars rows apply once per node run — execution-scoped, not item-scoped.
    for (const { row, value, dest } of varsPlan) {
      if (row.op === 'remove') ctx.vars.set(row.name, undefined);
      else if (row.op === 'rename') {
        const cur = ctx.vars.get(row.name);
        ctx.vars.set(row.name, undefined);
        ctx.vars.set(dest!, cur);
      } else ctx.vars.set(row.name, value);
    }

    const input: FlowItem[] = items.length > 0 ? items : [{ json: {} }];
    const output: FlowItem[] = input.map((item) => {
      const source = item.json as Record<string, unknown>;
      let json: Record<string, unknown> = params.keep_only_set
        ? {}
        : (structuredClone(source) as Record<string, unknown>);
      for (const { row, value, dest } of jsonPlan) {
        if (row.op === 'remove') {
          json = removePath(json, row.name);
        } else if (row.op === 'rename') {
          // In keep_only_set mode the source path may live only on the original
          // item, so read it from there; otherwise from the working copy.
          const moved = getPath(params.keep_only_set ? source : json, row.name);
          json = removePath(json, row.name);
          json = setPath(json, dest!, moved);
        } else {
          json = setPath(json, row.name, value);
        }
      }
      const next: FlowItem = { json };
      if (item.binary !== undefined) next.binary = item.binary;
      return next;
    });

    return out({ main: output });
  },
};

/** A row with its effective value (set) / destination path (rename) resolved. */
interface PlannedRow {
  row: EditFieldRow;
  value: unknown;
  dest?: string;
}

/**
 * Validate + resolve a single row up front (throws on a bad json value or an
 * empty rename destination, so execute() can fail the whole run loudly). For
 * `set` it applies value_mode='json'; for `rename` it resolves the dest path.
 */
function planRow(row: EditFieldRow): PlannedRow {
  if (row.op === 'rename') {
    const dest = typeof row.value === 'string' ? row.value.trim() : '';
    if (dest === '') throw new Error(`rename of "${row.name}": destination path is empty`);
    return { row, value: undefined, dest };
  }
  if (row.op === 'set' && row.value_mode === 'json' && typeof row.value === 'string') {
    try {
      return { row, value: JSON.parse(row.value) };
    } catch {
      throw new Error(`field "${row.name}": value is not valid JSON`);
    }
  }
  return { row, value: row.value };
}

/** Read the value at a dotted path; undefined when any segment is missing. */
function getPath(obj: Record<string, unknown>, path: string): unknown {
  let cur: unknown = obj;
  for (const seg of path.split('.')) {
    if (cur === null || typeof cur !== 'object' || Array.isArray(cur)) return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

/** Immutable deep-set along a dotted path; intermediate non-objects are replaced. */
function setPath(
  obj: Record<string, unknown>,
  path: string,
  value: unknown,
): Record<string, unknown> {
  const [head, ...rest] = path.split('.');
  if (head === undefined || head === '') return obj;
  const copy = { ...obj };
  if (rest.length === 0) {
    copy[head] = value;
    return copy;
  }
  const child = copy[head];
  const childObj =
    child !== null && typeof child === 'object' && !Array.isArray(child)
      ? ({ ...(child as Record<string, unknown>) })
      : {};
  copy[head] = setPath(childObj, rest.join('.'), value);
  return copy;
}

/** Immutable deep-delete along a dotted path; missing segments are a no-op. */
function removePath(obj: Record<string, unknown>, path: string): Record<string, unknown> {
  const [head, ...rest] = path.split('.');
  if (head === undefined || head === '' || !(head in obj)) return obj;
  const copy = { ...obj };
  if (rest.length === 0) {
    delete copy[head];
    return copy;
  }
  const child = copy[head];
  if (child === null || typeof child !== 'object' || Array.isArray(child)) return obj;
  copy[head] = removePath(child as Record<string, unknown>, rest.join('.'));
  return copy;
}
