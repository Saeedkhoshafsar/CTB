/**
 * ai.memoryKv — the DEFAULT chat-memory provider (PLAN2 PB-T4, NODES.md
 * §"Chat memory providers"). A `role:'provider'` sub-node that satisfies the
 * `ai:memory` slot: attach it under an AI Agent (PB-T5) to give the agent a
 * rolling conversation memory backed by the existing KV store — so a bot with
 * no database still remembers the last N turns.
 *
 * A provider is NEVER executed as a data step (PB-T1 — the executor skips
 * `role:'provider'` nodes). Its params ARE its contract: the consumer resolves
 * them into a `ChatMemoryConfig` (`{kind:'kv', sessionKey, window}`) and drives
 * the shared chat-memory runtime (`loadChatHistory`/`appendChatTurn`). The
 * `execute()` below therefore only exists to satisfy the NodeDef contract and
 * fails LOUDLY if a malformed graph ever routes data into it.
 */
import { fail, type AiMemoryKvParams, type NodeDef } from '@ctb/shared';
import { AiMemoryKvParamsSchema } from '@ctb/shared';

export const aiMemoryKv: NodeDef<AiMemoryKvParams> = {
  type: 'ai.memoryKv',
  category: 'ai',
  role: 'provider',
  provides: 'ai:memory',
  meta: { labelKey: 'nodes.ai.memoryKv.label', descriptionKey: 'nodes.ai.memoryKv.desc', icon: 'database' },
  // A provider takes no data input and emits only the dashed `provider` wire.
  ports: { inputs: [], outputs: ['provider'] },
  paramsSchema: AiMemoryKvParamsSchema,
  async execute() {
    // Defensive: providers are resolved as config, never run. If the cursor
    // ever parks here, fail loudly rather than pretend to produce items.
    return fail('ai.memoryKv is a memory provider and is not executed as a data step');
  },
};
