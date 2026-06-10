/**
 * Reusable ExecutionStore contract suite (P1-T3). Runs against ANY
 * implementation so SQLite and memory semantics can never drift apart.
 */
import type { ExecutionState, WaitSpec } from '@ctb/shared';
import { describe, expect, it } from 'vitest';
import type { ExecutionStore } from '../src/store/types';

export interface StoreFactoryResult {
  store: ExecutionStore;
  /** Pre-created FK targets (SQLite enforces them; memory ignores). */
  flowId: string;
  botId: string;
}

const richState: ExecutionState = {
  cursor: 'ask_age',
  items: {
    main: [
      { json: { name: 'علی', n: 42, nested: { deep: [1, 2, 3] }, fa: 'متن فارسی' } },
      { json: { ok: true }, binary: { file: { kind: 'tg_file_id', fileId: 'AAA', mime: 'image/jpeg' } } },
    ],
  },
  vars: { points: 7, tags: ['a', 'b'] },
  steps: 5,
};

const replyWait = (timeoutAt: string | null): WaitSpec => ({
  kind: 'reply',
  nodeId: 'ask_age',
  expect: 'number',
  retriesLeft: 2,
  timeoutAt,
});

export function executionStoreContractTests(
  name: string,
  makeStore: () => Promise<StoreFactoryResult> | StoreFactoryResult,
): void {
  describe(`ExecutionStore contract — ${name}`, () => {
    it('serialization round-trip: create → wait-save → load → deep-equal (I4)', async () => {
      const { store, flowId, botId } = await makeStore();
      await store.create({ id: 'e1', flowId, botId, chatId: 100, userId: 'u1', state: richState });
      const wait = replyWait('2026-06-11T00:00:00.000Z');
      await store.save({ id: 'e1', status: 'waiting', state: richState, wait });

      const loaded = await store.load('e1');
      expect(loaded).not.toBeNull();
      expect(loaded!.state).toEqual(richState);
      expect(loaded!.wait).toEqual(wait);
      expect(loaded!.status).toBe('waiting');
      expect(loaded!.chatId).toBe(100);
    });

    it('load of unknown id → null; save of unknown id → throws', async () => {
      const { store } = await makeStore();
      expect(await store.load('nope')).toBeNull();
      await expect(
        store.save({ id: 'nope', status: 'done', state: richState }),
      ).rejects.toThrow(/not found/);
    });

    it('checkpoint persists state without touching status/wait', async () => {
      const { store, flowId, botId } = await makeStore();
      await store.create({ id: 'e1', flowId, botId, chatId: 1, state: richState });
      await store.save({ id: 'e1', status: 'waiting', state: richState, wait: replyWait(null) });
      const next = { ...richState, steps: 6, vars: { points: 8 } };
      await store.checkpoint('e1', next);
      const loaded = await store.load('e1');
      expect(loaded!.state.steps).toBe(6);
      expect(loaded!.status).toBe('waiting');
      expect(loaded!.wait?.kind).toBe('reply');
    });

    it('findWaiting honors bot/chat/kind filters and only returns waiting', async () => {
      const { store, flowId, botId } = await makeStore();
      // waiting reply in chat 1
      await store.create({ id: 'w1', flowId, botId, chatId: 1, state: richState });
      await store.save({ id: 'w1', status: 'waiting', state: richState, wait: replyWait(null) });
      // waiting callback in chat 1
      await store.create({ id: 'w2', flowId, botId, chatId: 1, state: richState });
      await store.save({
        id: 'w2', status: 'waiting', state: richState,
        wait: { kind: 'callback', nodeId: 'menu1', keys: ['yes', 'no'], timeoutAt: null },
      });
      // other chat + finished execution → must not match
      await store.create({ id: 'other', flowId, botId, chatId: 2, state: richState });
      await store.save({ id: 'other', status: 'waiting', state: richState, wait: replyWait(null) });
      await store.create({ id: 'done', flowId, botId, chatId: 1, state: richState });
      await store.save({ id: 'done', status: 'done', state: richState, wait: null });

      const all = await store.findWaiting({ botId, chatId: 1 });
      expect(all.map((e) => e.id).sort()).toEqual(['w1', 'w2']);
      const replies = await store.findWaiting({ botId, chatId: 1, kind: 'reply' });
      expect(replies.map((e) => e.id)).toEqual(['w1']);
      expect(await store.findWaiting({ botId: 'ghost-bot', chatId: 1 })).toEqual([]);
    });

    it('listTimedOut returns only waiting executions past their deadline (reply + delay)', async () => {
      const { store, flowId, botId } = await makeStore();
      const past = '2026-06-10T00:00:00.000Z';
      const future = '2030-01-01T00:00:00.000Z';
      await store.create({ id: 'late', flowId, botId, chatId: 1, state: richState });
      await store.save({ id: 'late', status: 'waiting', state: richState, wait: replyWait(past) });
      await store.create({ id: 'fresh', flowId, botId, chatId: 2, state: richState });
      await store.save({ id: 'fresh', status: 'waiting', state: richState, wait: replyWait(future) });
      await store.create({ id: 'nodeadline', flowId, botId, chatId: 3, state: richState });
      await store.save({ id: 'nodeadline', status: 'waiting', state: richState, wait: replyWait(null) });
      await store.create({ id: 'sleeper', flowId, botId, chatId: 4, state: richState });
      await store.save({
        id: 'sleeper', status: 'waiting', state: richState,
        wait: { kind: 'delay', nodeId: 'wait1', resumeAt: past },
      });

      const due = await store.listTimedOut(new Date('2026-06-10T12:00:00.000Z'));
      expect(due.map((e) => e.id).sort()).toEqual(['late', 'sleeper']);
    });

    it('resume clears the wait and the execution leaves the waiting set', async () => {
      const { store, flowId, botId } = await makeStore();
      await store.create({ id: 'e1', flowId, botId, chatId: 9, state: richState });
      await store.save({ id: 'e1', status: 'waiting', state: richState, wait: replyWait('2026-06-10T00:00:00.000Z') });
      // resume: back to running, wait cleared
      await store.save({ id: 'e1', status: 'running', state: richState, wait: null });
      expect(await store.findWaiting({ botId, chatId: 9 })).toEqual([]);
      expect(await store.listTimedOut(new Date('2030-01-01T00:00:00.000Z'))).toEqual([]);
      // finish with error path
      await store.save({ id: 'e1', status: 'error', state: richState, error: 'boom' });
      const loaded = await store.load('e1');
      expect(loaded!.status).toBe('error');
      expect(loaded!.error).toBe('boom');
    });
  });
}
