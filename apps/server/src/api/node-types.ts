/**
 * GET /api/node-types (P2-T2) — exposes the node registry to the editor:
 * palette metadata, ports, and each node's param schema as JSON Schema.
 *
 * The registry is the SAME instance the executor runs (engine/wire.ts), so
 * the palette can never advertise a node the engine can't execute. Computed
 * once at route registration — node defs are static for a process lifetime.
 */
import type { NodeTypeInfo } from '@ctb/shared';
import type { NodeRegistry } from '@ctb/core';
import type { FastifyInstance } from 'fastify';
import { z, type ZodType } from 'zod';

export function nodeTypeInfos(registry: NodeRegistry): NodeTypeInfo[] {
  return registry.list().map((def) => ({
    type: def.type,
    category: def.category,
    meta: def.meta,
    ports: { inputs: [...def.ports.inputs], outputs: [...def.ports.outputs] },
    paramsJsonSchema: z.toJSONSchema(def.paramsSchema as ZodType, {
      // Node param schemas may use transforms/defaults; emit the INPUT shape —
      // that is what the editor form collects and the server re-validates.
      io: 'input',
      unrepresentable: 'any',
    }) as Record<string, unknown>,
  }));
}

export function registerNodeTypesApi(app: FastifyInstance, registry: NodeRegistry): void {
  const payload = { nodeTypes: nodeTypeInfos(registry) };
  app.get('/api/node-types', async () => payload);
}
