/**
 * data.setFields — Set Fields (NODES.md §Data & code).
 * Rows of `name = value` applied to each item's $json (immutably — input items
 * are never mutated) or to the execution's $vars (once per node run, not per
 * item). Dotted names create nested objects (`user.level` → `{user:{level}}`).
 * op=remove deletes the path. `keep_only_set` drops every json key that was
 * not set by this node's json-target rows.
 *
 * Empty input still emits one shaped item, so a Set Fields placed right after
 * a trigger that produced nothing can seed the pipeline.
 */
import {
  DataSetFieldsParamsSchema,
  out,
  type DataSetFieldsParams,
  type FlowItem,
  type NodeDef,
} from '@ctb/shared';

export const dataSetFields: NodeDef<DataSetFieldsParams> = {
  type: 'data.setFields',
  category: 'data',
  meta: { labelKey: 'nodes.data.setFields.label', descriptionKey: 'nodes.data.setFields.desc', icon: 'pencil' },
  ports: { inputs: ['main'], outputs: ['main'] },
  paramsSchema: DataSetFieldsParamsSchema,
  async execute(ctx, params, items) {
    const jsonRows = params.fields.filter((f) => f.target === 'json');
    const varsRows = params.fields.filter((f) => f.target === 'vars');

    // $vars rows apply once per node run — they are execution-scoped, not item-scoped.
    for (const row of varsRows) {
      if (row.op === 'remove') ctx.vars.set(row.name, undefined);
      else ctx.vars.set(row.name, row.value);
    }

    const input: FlowItem[] = items.length > 0 ? items : [{ json: {} }];
    const output: FlowItem[] = input.map((item) => {
      let json: Record<string, unknown> = params.keep_only_set
        ? {}
        : (structuredClone(item.json) as Record<string, unknown>);
      for (const row of jsonRows) {
        json = row.op === 'remove' ? removePath(json, row.name) : setPath(json, row.name, row.value);
      }
      const next: FlowItem = { json };
      if (item.binary !== undefined) next.binary = item.binary;
      return next;
    });

    return out({ main: output });
  },
};

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
