/**
 * data.userProfile contract tests (P3-T5). Generic CRM-ish primitive over the
 * injected ctx.users capability: get / set_profile (merge|replace, dotted) /
 * add_tags / remove_tags, defaulting to the execution's own user, with a
 * read-back record merged into each item's json. ≥3 cases per op family.
 */
import { NodeRegistry } from '@ctb/core';
import type { CtbUser } from '@ctb/shared';
import { describe, expect, it } from 'vitest';
import { builtinNodes, dataUserProfile, registerBuiltinNodes } from '../src/index';
import { item, makeCtx, params } from './node-harness';

describe('registry (P3-T5)', () => {
  it('data.userProfile is registered; registry is now 26 types', () => {
    const reg = registerBuiltinNodes(new NodeRegistry());
    expect(reg.has('data.userProfile')).toBe(true);
    // +2 in P3.5-T5: data.collection + collection.recordChanged.
    // +2 in P4-T1: webhook.trigger + flow.respondToWebhook.
    // +1 in P5-T1: ai.llmChat.
    expect(builtinNodes.length).toBe(38);
  });
});

const seed = (over: Partial<CtbUser> = {}): CtbUser => ({
  tgUserId: 777,
  profile: { first_name: 'علی' },
  tags: ['vip'],
  firstSeen: '2026-06-01T00:00:00.000Z',
  lastSeen: '2026-06-01T00:00:00.000Z',
  ...over,
});

describe('data.userProfile', () => {
  it('get reads the execution\'s own user and merges into $json.<save_as> (happy)', async () => {
    const ctx = makeCtx({ seedUsers: [seed()] });
    const res = await dataUserProfile.execute(ctx, params(dataUserProfile, { op: 'get' }), [
      item({ chat_id: 777 }),
    ]);
    if (res.kind !== 'items') throw new Error('expected items');
    expect(res.outputs.main![0]!.json.chat_id).toBe(777);
    const u = res.outputs.main![0]!.json.user as CtbUser;
    expect(u.tags).toEqual(['vip']);
    expect(u.profile).toEqual({ first_name: 'علی' });
  });

  it('get on an unseen user returns null record (edge)', async () => {
    const ctx = makeCtx();
    const res = await dataUserProfile.execute(
      ctx,
      params(dataUserProfile, { op: 'get', save_as: 'me' }),
      [],
    );
    if (res.kind !== 'items') throw new Error('expected items');
    expect(res.outputs.main![0]!.json.me).toBeNull();
  });

  it('set_profile merges dotted fields, keeping untouched keys (happy)', async () => {
    const ctx = makeCtx({ seedUsers: [seed()] });
    const p = params(dataUserProfile, {
      op: 'set_profile',
      fields: [
        { field: 'city', value: 'تهران' },
        { field: 'address.zip', value: '12345' },
      ],
    });
    const res = await dataUserProfile.execute(ctx, p, [item({})]);
    if (res.kind !== 'items') throw new Error('expected items');
    const u = res.outputs.main![0]!.json.user as CtbUser;
    expect(u.profile).toEqual({
      first_name: 'علی',
      city: 'تهران',
      address: { zip: '12345' },
    });
    // store mutated too
    expect(ctx.usersBag.get(777)!.profile).toMatchObject({ city: 'تهران' });
  });

  it('set_profile replace swaps the whole profile bag (edge)', async () => {
    const ctx = makeCtx({ seedUsers: [seed()] });
    const p = params(dataUserProfile, {
      op: 'set_profile',
      mode: 'replace',
      fields: [{ field: 'only', value: 'this' }],
    });
    const res = await dataUserProfile.execute(ctx, p, [item({})]);
    if (res.kind !== 'items') throw new Error('expected items');
    expect((res.outputs.main![0]!.json.user as CtbUser).profile).toEqual({ only: 'this' });
  });

  it('add_tags de-duplicates; remove_tags drops (happy)', async () => {
    const ctx = makeCtx({ seedUsers: [seed()] });
    const add = await dataUserProfile.execute(
      ctx,
      params(dataUserProfile, { op: 'add_tags', tags: ['vip', 'paid'] }),
      [item({})],
    );
    if (add.kind !== 'items') throw new Error('expected items');
    expect((add.outputs.main![0]!.json.user as CtbUser).tags).toEqual(['vip', 'paid']);

    const rem = await dataUserProfile.execute(
      ctx,
      params(dataUserProfile, { op: 'remove_tags', tags: ['vip'] }),
      [item({})],
    );
    if (rem.kind !== 'items') throw new Error('expected items');
    expect((rem.outputs.main![0]!.json.user as CtbUser).tags).toEqual(['paid']);
  });

  it('explicit `user` param targets a different user (edge)', async () => {
    const ctx = makeCtx({
      selfUserId: 777,
      seedUsers: [seed(), seed({ tgUserId: 999, tags: [], profile: {} })],
    });
    const res = await dataUserProfile.execute(
      ctx,
      params(dataUserProfile, { op: 'add_tags', tags: ['guest'], user: '999' }),
      [item({})],
    );
    if (res.kind !== 'items') throw new Error('expected items');
    expect((res.outputs.main![0]!.json.user as CtbUser).tgUserId).toBe(999);
    expect(ctx.usersBag.get(777)!.tags).toEqual(['vip']); // self untouched
  });

  it('fails loudly when ctx.users is null (error)', async () => {
    const ctx = makeCtx({ users: null });
    const res = await dataUserProfile.execute(ctx, params(dataUserProfile, { op: 'get' }), []);
    expect(res.kind).toBe('error');
    if (res.kind === 'error') expect(res.message).toMatch(/user store is not available/);
  });

  it('rejects invalid user id, and missing fields/tags (error)', async () => {
    const ctx = makeCtx({ seedUsers: [seed()] });
    const res = await dataUserProfile.execute(
      ctx,
      params(dataUserProfile, { op: 'get', user: 'not-a-number' }),
      [],
    );
    expect(res.kind).toBe('error');
    // schema-level: set_profile needs fields, add_tags needs tags
    expect(() => params(dataUserProfile, { op: 'set_profile' })).toThrow(/invalid params/);
    expect(() => params(dataUserProfile, { op: 'add_tags' })).toThrow(/invalid params/);
  });
});
