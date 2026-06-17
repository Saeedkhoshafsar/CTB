/**
 * ai.memoryPostgres — a Postgres-backed chat-memory provider (PLAN2 PB-T4,
 * NODES.md §"Chat memory providers"). The n8n "Postgres Chat Memory" node, kept
 * generic (I2 — "Postgres" is infrastructure). A `role:'provider'` sub-node
 * satisfying the `ai:memory` slot: attach it under an AI Agent (PB-T5) to
 * persist the rolling conversation as rows in a Postgres table.
 *
 * Like `ai.memoryKv`, a provider is NEVER executed as a data step (PB-T1). Its
 * params ARE its contract — the consumer resolves them into a `ChatMemoryConfig`
 * (`{kind:'postgres', credentialId, table, sessionKey, window, autoCreate}`) and
 * drives the shared chat-memory runtime over the injected `ctx.db` capability
 * (the `pg` driver + pool live in the host, I3; the decrypted secret never
 * reaches node code, I7). The `execute()` below only satisfies the NodeDef
 * contract and fails LOUDLY if a malformed graph routes data into it.
 */
import { fail, type AiMemoryPostgresParams, type NodeDef } from '@ctb/shared';
import { AiMemoryPostgresParamsSchema } from '@ctb/shared';

export const aiMemoryPostgres: NodeDef<AiMemoryPostgresParams> = {
  type: 'ai.memoryPostgres',
  category: 'ai',
  role: 'provider',
  provides: 'ai:memory',
  meta: {
    labelKey: 'nodes.ai.memoryPostgres.label',
    descriptionKey: 'nodes.ai.memoryPostgres.desc',
    icon: 'database',
  },
  ports: { inputs: [], outputs: ['provider'] },
  paramsSchema: AiMemoryPostgresParamsSchema,
  async execute() {
    return fail('ai.memoryPostgres is a memory provider and is not executed as a data step');
  },
};
