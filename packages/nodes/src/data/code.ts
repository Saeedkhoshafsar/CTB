/**
 * data.code — Code (JavaScript), the escape hatch (NODES.md §Data & code,
 * ARCHITECTURE §8). Runs user JavaScript inside the @ctb/sandbox worker pool
 * via the injected `ctx.code.run` capability (invariants I3/I6 — `nodes` never
 * imports the sandbox; every limit is enforced host-side in wire.ts).
 *
 * Modes (NODES.md §Code):
 *  - run_once  → the program runs ONCE; its scope sees `$items` (all input
 *                items) and `$json` = items[0].json. `return` shapes the whole
 *                output. Empty input still runs once (with `$items: []`), so a
 *                Code node right after a trigger can seed the pipeline.
 *  - per_item  → the program runs ONCE PER input item; each run's scope sees
 *                that item as `$json` (and `$items: [item]`). Outputs concat in
 *                input order. Empty input → no runs → empty output.
 *
 * Return normalization (n8n-style, see normalizeReturn):
 *  - undefined / null         → input items pass through unchanged
 *  - a FlowItem-shaped object  ({json}) → that single item
 *  - a plain object            → wrapped as { json: obj }
 *  - an array                  → each element normalized (objects → {json},
 *                                already-{json} kept), flattened
 *  - a primitive               → { json: { value: primitive } }
 *
 * `code` is listed in `rawParamKeys` (Decision Log #16): the executor must not
 * expression-resolve it, because `{{ }}` is valid JavaScript and must reach the
 * sandbox verbatim.
 *
 * Limits: per-run wall-clock budget from the `timeout` param, capped at
 * CODE_TIMEOUT_CAP_MS (10s, NODES.md). console.* output captured by the sandbox
 * is forwarded to the execution log as debug rows.
 */
import {
  DataCodeParamsSchema,
  fail,
  out,
  type DataCodeParams,
  type FlowItem,
  type NodeDef,
} from '@ctb/shared';
import { parseDuration } from '../lib/duration';

/** Hard wall-clock ceiling for a single sandbox run (NODES.md: 10s). */
export const CODE_TIMEOUT_CAP_MS = 10_000;

export const dataCode: NodeDef<DataCodeParams> = {
  type: 'data.code',
  category: 'data',
  meta: { labelKey: 'nodes.data.code.label', descriptionKey: 'nodes.data.code.desc', icon: 'code' },
  ports: { inputs: ['main'], outputs: ['main'] },
  // `code` is a JS program, not a {{ }} template — keep it verbatim (DL #16).
  rawParamKeys: ['code'],
  paramsSchema: DataCodeParamsSchema,
  async execute(ctx, params, items) {
    const timeoutMs = resolveTimeout(params.timeout);

    try {
      if (params.mode === 'per_item') {
        // One sandbox run per item; outputs concat in input order.
        const output: FlowItem[] = [];
        for (const item of items) {
          const { value, logs } = await ctx.code.run(params.code, [item], { timeoutMs });
          forwardLogs(ctx, logs);
          output.push(...normalizeReturn(value, [item]));
        }
        return out({ main: output });
      }

      // run_once: a single run over all input items (empty input still runs).
      const { value, logs } = await ctx.code.run(params.code, items, { timeoutMs });
      forwardLogs(ctx, logs);
      return out({ main: normalizeReturn(value, items) });
    } catch (err) {
      return fail(`data.code: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
};

/** Param duration → ms, clamped to the 10s host cap (default = cap). */
function resolveTimeout(timeout: string | undefined): number {
  if (timeout === undefined) return CODE_TIMEOUT_CAP_MS;
  return Math.min(parseDuration(timeout), CODE_TIMEOUT_CAP_MS);
}

/** Forward captured console output to the execution log (debug level). */
function forwardLogs(ctx: Parameters<NodeDef['execute']>[0], logs: string[]): void {
  for (const line of logs) ctx.log('debug', line);
}

/**
 * Normalize a Code node's `return` value into FlowItem[] (n8n-style).
 * `inputItems` is what passes through when the program returns nothing.
 */
export function normalizeReturn(value: unknown, inputItems: FlowItem[]): FlowItem[] {
  if (value === undefined || value === null) return inputItems;
  if (Array.isArray(value)) return value.map(toItem);
  return [toItem(value)];
}

/** A single returned element → FlowItem. Already-{json} objects are kept. */
function toItem(value: unknown): FlowItem {
  if (isFlowItem(value)) {
    const item: FlowItem = { json: value.json };
    if (value.binary !== undefined) item.binary = value.binary;
    return item;
  }
  if (value !== null && typeof value === 'object') {
    return { json: value as Record<string, unknown> };
  }
  // primitive (string/number/boolean) → wrap so $json stays an object.
  return { json: { value } };
}

function isFlowItem(value: unknown): value is FlowItem {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    'json' in value &&
    (value as { json: unknown }).json !== null &&
    typeof (value as { json: unknown }).json === 'object' &&
    !Array.isArray((value as { json: unknown }).json)
  );
}
