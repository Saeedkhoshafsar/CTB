/**
 * tool.subflow — another flow of the same bot exposed as an AI Agent tool (PLAN2
 * PB-T6, the n8n "Workflow Tool"; NODES.md §"AI Agent tool nodes"). A
 * `role:'provider'` sub-node that fills an agent's `ai:tool` slot: the model can
 * call a whole CTB flow by name. The model's JSON arguments become the child
 * flow's entry `$json`; the items its `flow.return` produced become the tool
 * result. This is CTB's killer feature since flows are already pausable/
 * resumable.
 *
 * A provider is NEVER executed as a data step (PB-T1 — the executor skips
 * `role:'provider'` nodes); its params ARE its contract. The consuming agent
 * runs the child via `ctx.subflow.run` (P3-T1), which enforces same-bot
 * ownership and the recursion-depth cap (invariant I6 — the node never
 * instantiates an executor). The `execute()` below only satisfies the NodeDef
 * contract and fails loudly if a malformed graph ever routes data into it.
 */
import { fail, type NodeDef, type ToolSubflowParams } from '@ctb/shared';
import { ToolSubflowParamsSchema } from '@ctb/shared';

export const aiToolSubflow: NodeDef<ToolSubflowParams> = {
  type: 'tool.subflow',
  category: 'ai',
  role: 'provider',
  provides: 'ai:tool',
  meta: { labelKey: 'nodes.tool.subflow.label', descriptionKey: 'nodes.tool.subflow.desc', icon: 'workflow' },
  // A provider takes no data input and emits only the dashed `provider` wire.
  ports: { inputs: [], outputs: ['provider'] },
  paramsSchema: ToolSubflowParamsSchema,
  async execute() {
    return fail('tool.subflow is an agent tool provider and is not executed as a data step');
  },
};
