/**
 * flow.loop — Loop Over Items (n8n `splitInBatches` style, NODES.md §Flow, P3-T2).
 *
 * Two output ports:
 *  • `loop` — the current batch. Wire your per-batch work off this port, then
 *             loop that work's output BACK into this node's `main` input.
 *  • `done` — fires once, after the final batch, carrying ALL original items.
 *
 * How the cycle works (n8n semantics):
 *  - First entry (no saved state, or `reset`): stash every input item, emit the
 *    first batch on `loop`. Empty input → go straight to `done` with [].
 *  - Loop-back entry (state exists): the items coming back in are the processed
 *    batch — we IGNORE them (the originals are stashed) and emit the next batch
 *    on `loop`, advancing the cursor. When no batch is left, clear the state and
 *    emit the stashed originals on `done`.
 *
 * State lives in $vars under a per-node key so two loop nodes never collide; the
 * presence of that key is exactly what distinguishes a loop-back from a fresh
 * entry. The executor's maxSteps budget is the backstop against a missing
 * `done` wiring spinning forever.
 */
import {
  FlowLoopParamsSchema,
  out,
  type FlowItem,
  type FlowLoopParams,
  type NodeDef,
} from '@ctb/shared';

/** Reserved $vars key prefix for a loop node's batch state (per-node id). */
export const LOOP_STATE_PREFIX = '__loop__:';

interface LoopState {
  /** All original items, captured on the first entry. */
  all: FlowItem[];
  /** Index of the next item to emit (how many have been handed out so far). */
  cursor: number;
}

function stateKey(nodeId: string): string {
  return `${LOOP_STATE_PREFIX}${nodeId}`;
}

function readState(raw: unknown): LoopState | null {
  if (raw === null || typeof raw !== 'object') return null;
  const s = raw as Partial<LoopState>;
  if (!Array.isArray(s.all) || typeof s.cursor !== 'number') return null;
  return { all: s.all as FlowItem[], cursor: s.cursor };
}

export const flowLoop: NodeDef<FlowLoopParams> = {
  type: 'flow.loop',
  category: 'flow',
  meta: { labelKey: 'nodes.flow.loop.label', descriptionKey: 'nodeDesc.flow.loop', icon: 'repeat' },
  ports: { inputs: ['main'], outputs: ['loop', 'done'] },
  paramsSchema: FlowLoopParamsSchema,
  async execute(ctx, params, items) {
    const key = stateKey(ctx.nodeId);
    const existing = params.reset ? null : readState(ctx.vars.get(key));

    if (!existing) {
      // ── fresh entry ──
      if (items.length === 0) {
        // Nothing to iterate — emit an empty `done` and keep no state.
        ctx.vars.set(key, undefined);
        return out({ done: [] });
      }
      const batch = items.slice(0, params.batch_size);
      ctx.vars.set(key, { all: items, cursor: batch.length } satisfies LoopState);
      return out({ loop: batch });
    }

    // ── loop-back entry: the incoming items are the processed batch; ignore
    //    them and hand out the next slice of the stashed originals. ──
    if (existing.cursor >= existing.all.length) {
      ctx.vars.set(key, undefined); // loop complete — clear state
      return out({ done: existing.all });
    }
    const batch = existing.all.slice(existing.cursor, existing.cursor + params.batch_size);
    ctx.vars.set(key, { all: existing.all, cursor: existing.cursor + batch.length } satisfies LoopState);
    return out({ loop: batch });
  },
};
