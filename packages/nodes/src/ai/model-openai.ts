/**
 * ai.modelOpenai — the OpenAI chat-model PROVIDER (PLAN2 PB-T5, NODES.md
 * §"AI model providers"). A `role:'provider'` sub-node that satisfies the
 * REQUIRED `ai:model` slot of an AI Agent (`ai.agent`): attach it under an
 * agent to tell the agent WHICH OpenAI-compatible model to call and with WHICH
 * credential — the n8n "OpenAI Chat Model" sub-node.
 *
 * A provider is NEVER executed as a data step (PB-T1 — the executor skips
 * `role:'provider'` nodes). Its params ARE its contract: the consuming agent
 * reads them from `ctx.slots['ai:model'][0]` to know the model name + credential
 * id, then calls the LLM through the injected `ctx.ai` capability (I3/I6 — the
 * driver lives only in the host; this node never touches the network and never
 * decrypts the credential, I7). The `execute()` below only exists to satisfy the
 * NodeDef contract and fails LOUDLY if a malformed graph routes data into it.
 */
import { fail, type AiModelOpenaiParams, type NodeDef } from '@ctb/shared';
import { AiModelOpenaiParamsSchema } from '@ctb/shared';

export const aiModelOpenai: NodeDef<AiModelOpenaiParams> = {
  type: 'ai.modelOpenai',
  category: 'ai',
  role: 'provider',
  provides: 'ai:model',
  meta: { labelKey: 'nodes.ai.modelOpenai.label', descriptionKey: 'nodes.ai.modelOpenai.desc', icon: 'sparkles' },
  // A provider takes no data input and emits only the dashed `provider` wire.
  ports: { inputs: [], outputs: ['provider'] },
  paramsSchema: AiModelOpenaiParamsSchema,
  async execute() {
    // Defensive: providers are resolved as config, never run. If the cursor
    // ever parks here, fail loudly rather than pretend to produce items.
    return fail('ai.modelOpenai is a model provider and is not executed as a data step');
  },
};
