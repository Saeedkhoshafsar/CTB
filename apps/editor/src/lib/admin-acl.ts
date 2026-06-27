/**
 * Admin-ACL decisions (PLAN4 K-T3) — the PURE, DOM-free core of the Admins
 * page's role-gated controls (the F-T3 pattern used by `test-run.ts`).
 *
 * The server's `SqlitePanelAdminStore` is the real authority — it enforces the
 * owner invariants in the store (K-T1) and the admins API re-checks role on
 * every call (K-T2). This module is the UI's matching defence-in-depth layer:
 * it decides which buttons to even render, so an `operator` never sees admin
 * controls, an `admin` never sees a Remove/role control on the owner row, and
 * only the real `owner` sees "Transfer ownership". Keeping it pure means these
 * decisions — the behaviour users feel — are unit-tested with no React.
 *
 * Mirrors the server precedence (`roleAtLeast`, owner ⊇ admin ⊇ operator) but
 * is deliberately self-contained (no server import) so a wrong call here can
 * never silently widen what the server already forbids.
 */
import { type PanelAdmin, type SessionRole, roleAtLeast } from '@ctb/shared';

/** Can `myRole` reach the Admins page / management surface at all? (≥ admin). */
export function canManageAdmins(myRole: SessionRole): boolean {
  return roleAtLeast(myRole, 'admin');
}

/**
 * Can the current user REMOVE `target`? An admin (or owner) may remove any
 * NON-owner; the owner row is never removable (store invariant 2). An operator
 * can never remove anyone.
 */
export function canRemove(myRole: SessionRole, target: PanelAdmin): boolean {
  if (!roleAtLeast(myRole, 'admin')) return false;
  return target.role !== 'owner';
}

/**
 * Can the current user CHANGE `target`'s role (admin↔operator)? Same rule as
 * remove: ≥admin, and never the owner (the owner's role is immutable except via
 * transfer — store invariant 2).
 */
export function canChangeRole(myRole: SessionRole, target: PanelAdmin): boolean {
  if (!roleAtLeast(myRole, 'admin')) return false;
  return target.role !== 'owner';
}

/**
 * Can the current user TRANSFER ownership TO `target`? ONLY the real owner can,
 * and only to a different, existing non-owner row. "Real owner" means the
 * session's role is `owner` AND its bound Telegram id matches `target` is NOT
 * the caller (you can't transfer to yourself). `myTgUserId` is the session's
 * `tgUserId`; when absent the session has no Telegram identity and cannot be the
 * store owner, so transfer is refused (matches the server's 403 `not_owner`).
 */
export function canTransferTo(
  myRole: SessionRole,
  myTgUserId: string | null | undefined,
  target: PanelAdmin,
): boolean {
  if (myRole !== 'owner') return false;
  if (!myTgUserId) return false;
  if (target.role === 'owner') return false; // already the owner
  if (target.tgUserId === myTgUserId) return false; // can't transfer to self
  return true;
}

/** Does the current user see the "Transfer ownership" affordance at all? (owner + a bound id). */
export function canSeeTransfer(myRole: SessionRole, myTgUserId: string | null | undefined): boolean {
  return myRole === 'owner' && !!myTgUserId;
}
