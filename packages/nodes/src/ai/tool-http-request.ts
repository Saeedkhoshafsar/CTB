/**
 * tool.httpRequest — an HTTP call exposed as an AI Agent tool (PLAN2 PB-T6,
 * NODES.md §"AI Agent tool nodes"). A `role:'provider'` sub-node that fills an
 * agent's `ai:tool` slot: attach it under an AI Agent and the model can call an
 * external API by name.
 *
 * A provider is NEVER executed as a data step (PB-T1 — the executor skips
 * `role:'provider'` nodes). Its params ARE its contract: the AUTHOR fixes the
 * method + url + headers/credential and DECLARES which arguments the model may
 * fill (`params` rows). The consuming agent (`resolveTools`) turns those into an
 * `AiToolSpec` and, at call time, merges the model's JSON args over the template
 * and runs the request through `ctx.http.request` (host-limited, invariant I6).
 * The decrypted credential never reaches node code (I7). The `execute()` below
 * only satisfies the NodeDef contract and fails loudly if a malformed graph ever
 * routes data into it.
 */
import { fail, type NodeDef, type ToolHttpRequestParams } from '@ctb/shared';
import { ToolHttpRequestParamsSchema } from '@ctb/shared';

export const aiToolHttpRequest: NodeDef<ToolHttpRequestParams> = {
  type: 'tool.httpRequest',
  category: 'ai',
  role: 'provider',
  provides: 'ai:tool',
  meta: {
    labelKey: 'nodes.tool.httpRequest.label',
    descriptionKey: 'nodes.tool.httpRequest.desc',
    icon: 'globe',
  },
  // A provider takes no data input and emits only the dashed `provider` wire.
  ports: { inputs: [], outputs: ['provider'] },
  paramsSchema: ToolHttpRequestParamsSchema,
  async execute() {
    return fail('tool.httpRequest is an agent tool provider and is not executed as a data step');
  },
};
