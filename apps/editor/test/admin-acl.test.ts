/**
 * PLAN4 K-T3 — pure Admins-ACL decisions (the F-T3 pattern).
 *
 * These are the behaviour users feel on the Admins page — which buttons even
 * render — proven without any React. They mirror the server's owner invariants
 * (K-T1) and role precedence (K-T2): an operator manages nobody, an admin can
 * touch any NON-owner row, the owner row is never removable / role-changeable,
 * and only the real owner (role 'owner' + a bound Telegram id) can transfer
 * ownership, and never to themselves.
 */
import type { PanelAdmin } from '@ctb/shared';
import { describe, expect, it } from 'vitest';
import {
  canChangeRole,
  canManageAdmins,
  canRemove,
  canSeeTransfer,
  canTransferTo,
} from '../src/lib/admin-acl';

const ownerRow: PanelAdmin = { tgUserId: '100', role: 'owner', label: 'Owner', createdAt: '2026-01-01T00:00:00.000Z' };
const adminRow: PanelAdmin = { tgUserId: '200', role: 'admin', label: 'Admin', createdAt: '2026-01-01T00:00:00.000Z' };
const operatorRow: PanelAdmin = { tgUserId: '300', role: 'operator', label: 'Operator', createdAt: '2026-01-01T00:00:00.000Z' };

describe('canManageAdmins', () => {
  it('is true for owner and admin, false for operator', () => {
    expect(canManageAdmins('owner')).toBe(true);
    expect(canManageAdmins('admin')).toBe(true);
    expect(canManageAdmins('operator')).toBe(false);
  });
});

describe('canRemove', () => {
  it('operator can remove nobody', () => {
    expect(canRemove('operator', adminRow)).toBe(false);
    expect(canRemove('operator', operatorRow)).toBe(false);
    expect(canRemove('operator', ownerRow)).toBe(false);
  });

  it('admin/owner can remove any non-owner', () => {
    expect(canRemove('admin', adminRow)).toBe(true);
    expect(canRemove('admin', operatorRow)).toBe(true);
    expect(canRemove('owner', adminRow)).toBe(true);
    expect(canRemove('owner', operatorRow)).toBe(true);
  });

  it('the owner row is never removable (store invariant 2)', () => {
    expect(canRemove('admin', ownerRow)).toBe(false);
    expect(canRemove('owner', ownerRow)).toBe(false);
  });
});

describe('canChangeRole', () => {
  it('mirrors canRemove: ≥admin, never the owner row', () => {
    expect(canChangeRole('operator', adminRow)).toBe(false);
    expect(canChangeRole('admin', operatorRow)).toBe(true);
    expect(canChangeRole('admin', ownerRow)).toBe(false);
    expect(canChangeRole('owner', ownerRow)).toBe(false);
  });
});

describe('canSeeTransfer', () => {
  it('only an owner WITH a bound Telegram id sees the affordance', () => {
    expect(canSeeTransfer('owner', '100')).toBe(true);
    expect(canSeeTransfer('owner', undefined)).toBe(false);
    expect(canSeeTransfer('owner', null)).toBe(false);
    expect(canSeeTransfer('admin', '200')).toBe(false);
    expect(canSeeTransfer('operator', '300')).toBe(false);
  });
});

describe('canTransferTo', () => {
  it('owner can transfer to a different non-owner row', () => {
    expect(canTransferTo('owner', '100', adminRow)).toBe(true);
    expect(canTransferTo('owner', '100', operatorRow)).toBe(true);
  });

  it('non-owners can never transfer', () => {
    expect(canTransferTo('admin', '200', operatorRow)).toBe(false);
    expect(canTransferTo('operator', '300', adminRow)).toBe(false);
  });

  it('owner without a bound id cannot transfer', () => {
    expect(canTransferTo('owner', undefined, adminRow)).toBe(false);
    expect(canTransferTo('owner', null, adminRow)).toBe(false);
  });

  it('cannot transfer to the owner row or to self', () => {
    expect(canTransferTo('owner', '100', ownerRow)).toBe(false);
    // a self row carrying the caller's own tgUserId (defensive — owner row is the
    // usual self, but guard against a mislabelled duplicate id too):
    const selfAsAdmin: PanelAdmin = { ...adminRow, tgUserId: '100' };
    expect(canTransferTo('owner', '100', selfAsAdmin)).toBe(false);
  });
});
