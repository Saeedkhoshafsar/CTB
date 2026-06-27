/**
 * L-T1 (PLAN4 Phase L) — the PURE setup-checklist model.
 *
 * `computeChecklist` is a side effect-free derivation of the OPEN prerequisite
 * tasks + a `ready` flag from a crafted `SetupState`. These tests pin every
 * acceptance criterion against hand-built states (no DB, no env):
 *   • nothing configured → all prerequisites listed, ready:false;
 *   • satisfying one prerequisite removes EXACTLY that item;
 *   • all required satisfied → ready:true (recommended-only items don't block);
 *   • a fully-configured state → empty list, ready:true.
 */
import { type SetupState, SETUP_CHECKLIST_IDS } from '@ctb/shared';
import { describe, expect, it } from 'vitest';
import { computeChecklist } from '../src/engine/setup-checklist';

/** A fully-satisfied snapshot; tests knock individual facts down from here. */
const READY: SetupState = {
  hasSecret: true,
  hasOwner: true,
  nonOwnerAdminCount: 1,
  botCount: 1,
  activeFlowCount: 1,
  hasDelivery: true,
};

/** The empty/fresh snapshot. */
const EMPTY: SetupState = {
  hasSecret: false,
  hasOwner: false,
  nonOwnerAdminCount: 0,
  botCount: 0,
  activeFlowCount: 0,
  hasDelivery: false,
};

const idsOf = (s: SetupState) => computeChecklist(s).items.map((i) => i.id);

describe('computeChecklist (L-T1)', () => {
  it('lists every prerequisite and is not ready when nothing is configured', () => {
    const c = computeChecklist(EMPTY);
    expect(c.ready).toBe(false);
    expect(c.items.map((i) => i.id).sort()).toEqual([...SETUP_CHECKLIST_IDS].sort());
  });

  it('is ready with an empty list when everything is satisfied', () => {
    const c = computeChecklist(READY);
    expect(c.items).toEqual([]);
    expect(c.ready).toBe(true);
  });

  it('preserves the declared display order of open items', () => {
    expect(idsOf(EMPTY)).toEqual([...SETUP_CHECKLIST_IDS]);
  });

  it('satisfying one prerequisite removes EXACTLY that item', () => {
    expect(idsOf({ ...EMPTY, hasSecret: true })).not.toContain('secret');
    expect(idsOf({ ...EMPTY, hasOwner: true })).not.toContain('owner');
    expect(idsOf({ ...EMPTY, botCount: 2 })).not.toContain('bot');
    expect(idsOf({ ...EMPTY, activeFlowCount: 1 })).not.toContain('activeFlow');
    expect(idsOf({ ...EMPTY, hasDelivery: true })).not.toContain('delivery');
    expect(idsOf({ ...EMPTY, nonOwnerAdminCount: 1 })).not.toContain('admins');
  });

  it('the admins item is OPTIONAL — open but does not block readiness', () => {
    // Everything required satisfied, only the recommended `admins` still open.
    const s: SetupState = { ...READY, nonOwnerAdminCount: 0 };
    const c = computeChecklist(s);
    expect(c.items.map((i) => i.id)).toEqual(['admins']);
    expect(c.items[0]?.optional).toBe(true);
    expect(c.ready).toBe(true); // recommended-only items don't block
  });

  it('a missing REQUIRED item keeps ready:false even if admins is satisfied', () => {
    const s: SetupState = { ...READY, hasDelivery: false };
    const c = computeChecklist(s);
    expect(c.items.map((i) => i.id)).toEqual(['delivery']);
    expect(c.items[0]?.optional).toBe(false);
    expect(c.ready).toBe(false);
  });

  it('marks every required item with optional:false', () => {
    const c = computeChecklist(EMPTY);
    const required = c.items.filter((i) => i.id !== 'admins');
    expect(required.every((i) => i.optional === false)).toBe(true);
  });
});
