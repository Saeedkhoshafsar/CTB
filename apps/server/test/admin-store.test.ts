/**
 * K-T1 — SqlitePanelAdminStore round-trip + owner-invariant tests against the
 * real Drizzle/SQLite `panel_admins` table. Covers every acceptance criterion:
 *   • add / list / get / setRole round-trip
 *   • single-owner enforced: bootstrapOwner twice rejects; add never mints owner
 *   • owner immutable: remove(owner) rejects; setRole(owner) rejects
 *   • transferOwner swaps roles ATOMICALLY (old owner → admin, target → owner)
 *   • transferOwner guards: caller must be owner; target must exist
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, schema as tables } from '../src/db/index';
import { runMigrations } from '../src/db/migrate';
import { PanelAdminError, SqlitePanelAdminStore } from '../src/engine/admin-store';

function freshStore() {
  const { db } = openDb(':memory:');
  runMigrations(db);
  let tick = 0;
  const store = new SqlitePanelAdminStore(db, () => new Date(1750000000000 + tick++ * 1000));
  return { store, db };
}

describe('SqlitePanelAdminStore (K-T1)', () => {
  let store: SqlitePanelAdminStore;
  beforeEach(() => {
    ({ store } = freshStore());
  });

  it('starts empty and reports isEmpty / no owner', () => {
    expect(store.isEmpty()).toBe(true);
    expect(store.list()).toEqual([]);
    expect(store.owner()).toBeNull();
  });

  it('bootstraps the first owner, then add/get/list round-trips', () => {
    const owner = store.bootstrapOwner('100', 'Founder');
    expect(owner).toMatchObject({ tgUserId: '100', role: 'owner', label: 'Founder' });
    expect(store.isEmpty()).toBe(false);
    expect(store.owner()?.tgUserId).toBe('100');

    store.add('200', 'admin', 'Alice');
    store.add('300', 'operator', 'Bob');

    expect(store.get('200')).toMatchObject({ role: 'admin', label: 'Alice' });
    expect(store.get('999')).toBeNull();
    // oldest-first (bootstrapped owner created first)
    expect(store.list().map((a) => a.tgUserId)).toEqual(['100', '200', '300']);
  });

  it('enforces a single owner: a second bootstrap rejects', () => {
    store.bootstrapOwner('100', 'Founder');
    expect(() => store.bootstrapOwner('200', 'Usurper')).toThrowError(PanelAdminError);
    try {
      store.bootstrapOwner('200', 'Usurper');
    } catch (e) {
      expect((e as PanelAdminError).code).toBe('owner_exists');
    }
    expect(store.list().filter((a) => a.role === 'owner')).toHaveLength(1);
  });

  it('rejects duplicate ids on add and bootstrap', () => {
    store.bootstrapOwner('100', 'Founder');
    store.add('200', 'admin', 'Alice');
    expect(() => store.add('200', 'operator', 'Alice2')).toThrowError(/already exists/);
    expect(() => store.bootstrapOwner('100', 'X')).toThrowError(PanelAdminError); // owner_exists wins
  });

  it('setRole changes a non-owner between admin/operator', () => {
    store.bootstrapOwner('100', 'Founder');
    store.add('200', 'admin', 'Alice');
    const updated = store.setRole('200', 'operator');
    expect(updated.role).toBe('operator');
    expect(store.get('200')?.role).toBe('operator');
  });

  it('owner is immutable: remove(owner) and setRole(owner) reject', () => {
    store.bootstrapOwner('100', 'Founder');
    expect(() => store.remove('100')).toThrowError(/cannot be removed/);
    try {
      store.setRole('100', 'admin');
    } catch (e) {
      expect((e as PanelAdminError).code).toBe('owner_immutable');
    }
    // still the owner, untouched
    expect(store.owner()?.tgUserId).toBe('100');
  });

  it('remove deletes a non-owner; missing id rejects', () => {
    store.bootstrapOwner('100', 'Founder');
    store.add('200', 'admin', 'Alice');
    store.remove('200');
    expect(store.get('200')).toBeNull();
    expect(() => store.remove('200')).toThrowError(/not found/);
  });

  it('transferOwner atomically promotes target and demotes old owner', () => {
    store.bootstrapOwner('100', 'Founder');
    store.add('200', 'admin', 'Alice');

    const { owner, previous } = store.transferOwner('100', '200');
    expect(owner).toMatchObject({ tgUserId: '200', role: 'owner' });
    expect(previous).toMatchObject({ tgUserId: '100', role: 'admin' });

    // the table reflects exactly one owner, and it's the new one
    const owners = store.list().filter((a) => a.role === 'owner');
    expect(owners).toHaveLength(1);
    expect(owners[0]!.tgUserId).toBe('200');
    expect(store.get('100')?.role).toBe('admin');
  });

  it('transferOwner requires the caller to BE the current owner', () => {
    store.bootstrapOwner('100', 'Founder');
    store.add('200', 'admin', 'Alice');
    store.add('300', 'admin', 'Bob');
    try {
      store.transferOwner('200', '300'); // 200 is not the owner
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as PanelAdminError).code).toBe('not_owner');
    }
    // nothing moved
    expect(store.owner()?.tgUserId).toBe('100');
  });

  it('transferOwner rejects an unknown target', () => {
    store.bootstrapOwner('100', 'Founder');
    try {
      store.transferOwner('100', '999');
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as PanelAdminError).code).toBe('not_found');
    }
  });

  it('transferOwner to self is a no-op', () => {
    store.bootstrapOwner('100', 'Founder');
    const { owner } = store.transferOwner('100', '100');
    expect(owner.tgUserId).toBe('100');
    expect(store.owner()?.tgUserId).toBe('100');
    expect(store.list().filter((a) => a.role === 'owner')).toHaveLength(1);
  });
});
