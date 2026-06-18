/**
 * tool.think — the "Think" tool exposed as an AI Agent tool (PLAN2 PB-T6, the
 * screenshot's "Think"; NODES.md §"AI Agent tool nodes"). A `role:'provider'`
 * sub-node that fills an agent's `ai:tool` slot with a NO-OP scratchpad: calling
 * it does nothing but echo the model's own `thought` back. It gives the model a
 * place to reason step-by-step mid-loop, which measurably improves multi-step
 * tool use — the purest possible tool (it needs NO capability and never touches
 * the world).
 *
 * A provider is NEVER executed as a data step (PB-T1 — the executor skips
 * `role:'provider'` nodes); its params ARE its contract. The consuming agent
 * turns it into a one-argument (`thought`) tool whose runner returns the thought
 * unchanged. The `execute()` below only satisfies the NodeDef contract and fails
 * loudly if a malformed graph ever routes data into it.
 */
import { fail, type NodeDef, type ToolThinkParams } from '@ctb/shared';
import { ToolThinkParamsSchema } from '@ctb/shared';

export const aiToolThink: NodeDef<ToolThinkParams> = {
  type: 'tool.think',
  category: 'ai',
  role: 'provider',
  provides: 'ai:tool',
  meta: { labelKey: 'nodes.tool.think.label', descriptionKey: 'nodes.tool.think.desc', icon: 'brain' },
  // A provider takes no data input and emits only the dashed `provider` wire.
  ports: { inputs: [], outputs: ['provider'] },
  paramsSchema: ToolThinkParamsSchema,
  async execute() {
    return fail('tool.think is an agent tool provider and is not executed as a data step');
  },
};
