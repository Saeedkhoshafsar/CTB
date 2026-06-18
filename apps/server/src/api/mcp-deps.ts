/**
 * Dependencies the MCP server router (PC-T3) needs. Split into its own module so
 * `mcp.ts` and `v1.ts` (which mounts it inside its bearer-auth scope) share the
 * exact type without a circular import.
 *
 * The MCP surface deliberately reuses the SAME engine handles the REST v1 router
 * uses (db / flowSource / executor / registry / gateway / collectionStore), so a
 * flow built or triggered over MCP behaves identically to one built over REST
 * (I5 — no surface drift). `tokenBotId` carries the authenticated token's bot
 * scope (null = instance-wide) so each tool can enforce the same bot boundary as
 * `tokenAllowsBot` does for REST.
 */
import type { Executor, NodeRegistry } from '@ctb/core';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Db } from '../db/index';
import type { SqliteCollectionStore } from '../collections/store';
import type { SqliteFlowSource } from '../engine/flow-source';
import type { TelegramGateway } from '../telegram/gateway';

export interface McpDeps {
  /** The already-bearer-authenticated Fastify scope to register the route on. */
  scope: FastifyInstance;
  db: Db;
  flowSource: SqliteFlowSource;
  executor: Executor;
  registry: NodeRegistry;
  gateway: TelegramGateway;
  /** Optional — when absent, `query_collection` returns `collections_not_available`. */
  collectionStore?: SqliteCollectionStore | undefined;
  /**
   * Read the authenticated token's bot scope FROM THE REQUEST (null =
   * instance-wide). Per-request because the auth preHandler stamps a fresh
   * token on each call; the v1 router passes its own `tokenAllowsBot` source.
   */
  tokenBotId: (req: FastifyRequest) => string | null;
  /** Current timestamp (injectable clock, mirrors the REST router). */
  now: () => string;
  /** Symmetry hook with REST; MCP tools never toggle the active set (see mcp.ts). */
  onFlowsChanged?: (() => void) | undefined;
}
