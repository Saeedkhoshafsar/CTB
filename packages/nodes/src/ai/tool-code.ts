/**
 * tool.code — a sandboxed-JavaScript snippet exposed as an AI Agent tool (PLAN2
 * PB-T6, NODES.md §"AI Agent tool nodes"). A `role:'provider'` sub-node that
 * fills an agent's `ai:tool` slot: the model can run the author's program by
 * name, with the model's JSON arguments visible as `$json` and the program's
 * `return` value handed back as the tool result.
 *
 * A provider is NEVER executed as a data step (PB-T1 — the executor skips
 * `role:'provider'` nodes); its params ARE its contract. The consuming agent
 * runs the program through `ctx.code.run` (the @ctb/sandbox worker pool, I3/I6)
 * under the same 10s host cap as `data.code`. Like `data.code`, the `code` param
 * is RAW (never `{{ }}`-resolved — Decision Log #16) so it reaches the sandbox
 * verbatim. The `execute()` below only satisfies the NodeDef contract and fails
 * loudly if a malformed graph ever routes data into it.
 */
import { fail, type NodeDef, type ToolCodeParams } from '@ctb/shared';
import { ToolCodeParamsSchema } from '@ctb/shared';

export const aiToolCode: NodeDef<ToolCodeParams> = {
  type: 'tool.code',
  category: 'ai',
  role: 'provider',
  provides: 'ai:tool',
  meta: { labelKey: 'nodes.tool.code.label', descriptionKey: 'nodes.tool.code.desc', icon: 'code' },
  // `code` is a JS program, not a {{ }} template — keep it verbatim (DL #16).
  rawParamKeys: ['code'],
  // A provider takes no data input and emits only the dashed `provider` wire.
  ports: { inputs: [], outputs: ['provider'] },
  paramsSchema: ToolCodeParamsSchema,
  async execute() {
    return fail('tool.code is an agent tool provider and is not executed as a data step');
  },
};
