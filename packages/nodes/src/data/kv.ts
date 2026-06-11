/**
 * data.kv — Storage / KV (NODES.md §Data & code). Persistent per-user/bot/flow
 * key-value data ("points", "state") without an external DB, via the injected
 * ctx.kv capability (server backs it with the kv_store table).
 *
 * Ops:
 *  - get        → value lands in $json.<save_as> (default "value"); missing key → null
 *  - set        → stores `value` verbatim; items pass through unchanged
 *  - delete     → removes the key; items pass through unchanged
 *  - increment  → numeric read-modify-write by `value` step (default 1, "+5"
 *                 strings accepted); non-numeric stored value → fail loudly.
 *                 New total lands in $json.<save_as> too.
 *
 * The op runs ONCE per node run (not per item) — KV is execution-external
 * state, hitting it N times for N items would surprise (and increment would
 * count items, not clicks). Output mirrors input items (empty input → one
 * seeded item) with the read result merged into each item's json.
 */
import {
  DataKvParamsSchema,
  fail,
  out,
  type DataKvParams,
  type FlowItem,
  type NodeDef,
} from '@ctb/shared';

export const dataKv: NodeDef<DataKvParams> = {
  type: 'data.kv',
  category: 'data',
  meta: { labelKey: 'nodes.data.kv.label', descriptionKey: 'nodes.data.kv.desc', icon: 'database' },
  ports: { inputs: ['main'], outputs: ['main'] },
  paramsSchema: DataKvParamsSchema,
  async execute(ctx, params, items) {
    const saveAs = params.save_as ?? 'value';
    let readResult: unknown;
    let merge = false;

    switch (params.op) {
      case 'get': {
        const v = await ctx.kv.get(params.scope, params.key);
        readResult = v === undefined ? null : v;
        merge = true;
        break;
      }
      case 'set': {
        await ctx.kv.set(params.scope, params.key, params.value);
        break;
      }
      case 'delete': {
        await ctx.kv.delete(params.scope, params.key);
        break;
      }
      case 'increment': {
        const step = asNumber(params.value ?? 1);
        if (step === undefined) {
          return fail(`data.kv: increment step is not a number (${JSON.stringify(params.value)})`);
        }
        const current = await ctx.kv.get(params.scope, params.key);
        const base = current === undefined || current === null ? 0 : asNumber(current);
        if (base === undefined) {
          return fail(
            `data.kv: cannot increment non-numeric stored value for key "${params.key}" (${JSON.stringify(current)})`,
          );
        }
        const next = base + step;
        await ctx.kv.set(params.scope, params.key, next);
        readResult = next;
        merge = true;
        break;
      }
    }

    const input: FlowItem[] = items.length > 0 ? items : [{ json: {} }];
    if (!merge) return out({ main: input });
    return out({
      main: input.map((item) => {
        const next: FlowItem = { json: { ...item.json, [saveAs]: readResult } };
        if (item.binary !== undefined) next.binary = item.binary;
        return next;
      }),
    });
  },
};

function asNumber(v: unknown): number | undefined {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}
