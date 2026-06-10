import { expect, it } from 'vitest';
import { MemoryExecutionStore } from '../src/store/memory';
import { executionStoreContractTests } from './store-contract';

let tick = 0;
executionStoreContractTests('MemoryExecutionStore', () => ({
  // monotonically-increasing clock so updatedAt ordering is deterministic
  store: new MemoryExecutionStore(() => new Date(1750000000000 + tick++ * 1000)),
  flowId: 'flow1',
  botId: 'bot1',
}));

it('memory store: loaded objects are copies (no shared mutable state)', async () => {
  const store = new MemoryExecutionStore();
  const state = { cursor: 'n1', items: { main: [{ json: { a: 1 } }] }, vars: {}, steps: 0 };
  await store.create({ id: 'e1', flowId: 'f', botId: 'b', state });
  const a = await store.load('e1');
  (a!.state.vars as Record<string, unknown>).hacked = true;
  const b = await store.load('e1');
  expect(b!.state.vars).toEqual({});
});
