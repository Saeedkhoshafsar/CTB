/**
 * flow.merge — Merge (combine two branches, n8n `Merge` node spirit, P3-T2).
 *
 * Two input ports `input1` + `input2`, one output port `main`. The node fires
 * once per activation (when EITHER branch routes items to it); it uses
 * `ctx.inputsByPort` to tell which side just arrived, and `ctx.vars` (keyed by
 * `ctx.nodeId`) to remember what it has seen across activations.
 *
 * Modes:
 *  • `append`       — emit whatever just arrived, straight through, in arrival
 *                     order. No waiting, no state: each activation passes its
 *                     items on (input1 first if both somehow arrive together).
 *  • `wait_both`    — buffer the FIRST branch to arrive and emit nothing; when
 *                     the OTHER branch arrives, emit both together (input1 items
 *                     first, then input2) and clear the buffer. If only one
 *                     branch ever fires, the node emits nothing.
 *  • `choose_first` — emit the first branch to arrive; ignore every later
 *                     activation (a one-shot latch per node).
 *
 * `execute()`'s flattened `items` arg is deliberately NOT used here — a merge
 * node only makes sense in terms of WHICH branch fired, so it reads
 * `ctx.inputsByPort` exclusively. Empty ports are already filtered out by the
 * executor, so a present port always carries at least one item.
 */
import {
  FlowMergeParamsSchema,
  out,
  type FlowItem,
  type FlowMergeParams,
  type NodeDef,
} from '@ctb/shared';

/** Reserved $vars key prefix for a merge node's cross-activation state. */
export const MERGE_STATE_PREFIX = '__merge__:';

const INPUT_1 = 'input1';
const INPUT_2 = 'input2';

/** What `wait_both` buffers between activations / what `choose_first` latches. */
interface MergeState {
  /** Buffered input1 items awaiting input2 (wait_both). */
  buf1?: FlowItem[];
  /** Buffered input2 items awaiting input1 (wait_both). */
  buf2?: FlowItem[];
  /** Set once choose_first has emitted — every later activation is a no-op. */
  fired?: boolean;
}

function stateKey(nodeId: string): string {
  return `${MERGE_STATE_PREFIX}${nodeId}`;
}

function readState(raw: unknown): MergeState {
  if (raw === null || typeof raw !== 'object') return {};
  const s = raw as Partial<MergeState>;
  const state: MergeState = {};
  if (Array.isArray(s.buf1)) state.buf1 = s.buf1 as FlowItem[];
  if (Array.isArray(s.buf2)) state.buf2 = s.buf2 as FlowItem[];
  if (s.fired === true) state.fired = true;
  return state;
}

export const flowMerge: NodeDef<FlowMergeParams> = {
  type: 'flow.merge',
  category: 'flow',
  meta: {
    labelKey: 'nodes.flow.merge.label',
    descriptionKey: 'nodeDesc.flow.merge',
    icon: 'git-merge',
  },
  ports: { inputs: [INPUT_1, INPUT_2], outputs: ['main'] },
  paramsSchema: FlowMergeParamsSchema,
  async execute(ctx, params) {
    const in1 = ctx.inputsByPort[INPUT_1] ?? [];
    const in2 = ctx.inputsByPort[INPUT_2] ?? [];

    if (params.mode === 'append') {
      // Pass through whatever fired, input1 ahead of input2 if both are present.
      return out({ main: [...in1, ...in2] });
    }

    const key = stateKey(ctx.nodeId);

    if (params.mode === 'choose_first') {
      const state = readState(ctx.vars.get(key));
      if (state.fired) return out({}); // latched — ignore later branches
      ctx.vars.set(key, { fired: true } satisfies MergeState);
      // input1 wins a simultaneous arrival; otherwise emit whichever fired.
      return out({ main: in1.length > 0 ? in1 : in2 });
    }

    // ── wait_both ──
    const state = readState(ctx.vars.get(key));
    const buf1 = [...(state.buf1 ?? []), ...in1];
    const buf2 = [...(state.buf2 ?? []), ...in2];

    if (buf1.length > 0 && buf2.length > 0) {
      ctx.vars.set(key, undefined); // both sides in — release & reset
      return out({ main: [...buf1, ...buf2] });
    }

    // Only one side so far — keep buffering, emit nothing yet.
    ctx.vars.set(key, { buf1, buf2 } satisfies MergeState);
    return out({});
  },
};
