/**
 * SqliteExecutionStore — runs the shared ExecutionStore contract suite
 * (packages/core/test/store-contract.ts) against the real Drizzle/SQLite
 * implementation, so memory & SQLite semantics can never drift (P1-T3, I4).
 */
import { executionStoreContractTests } from '../../../packages/core/test/store-contract';
import { openDb, schema } from '../src/db/index';
import { runMigrations } from '../src/db/migrate';
import { SqliteExecutionStore } from '../src/engine/sqlite-store';

let tick = 0;

executionStoreContractTests('SqliteExecutionStore', () => {
  const { db } = openDb(':memory:');
  runMigrations(db);
  // FK targets — executions.flow_id → flows.id → bots.id
  const now = new Date().toISOString();
  db.insert(schema.bots)
    .values({ id: 'bot1', name: 'b', tokenEnc: 'enc.x.y', createdAt: now, updatedAt: now })
    .run();
  db.insert(schema.flows)
    .values({ id: 'flow1', botId: 'bot1', name: 'f', graph: { nodes: [], edges: [] }, updatedAt: now })
    .run();
  // monotonic clock → deterministic updatedAt ordering in list queries
  const store = new SqliteExecutionStore(db, () => new Date(1750000000000 + tick++ * 1000));
  return { store, flowId: 'flow1', botId: 'bot1' };
});
