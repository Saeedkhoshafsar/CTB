/**
 * SqlitePanelAdminStore (K-T1, PLAN4 Phase K) — the durable, Telegram-ID-keyed
 * list of PANEL identities and their role. It is the single source of truth for
 * "who may see/operate the panel", replacing the v1 single-shared-password model.
 *
 * Panel admins are panel operators (`owner`/`admin`/`operator`), kept STRICTLY
 * separate from the per-bot end-user store (`SqliteUserStore`, invariant I2):
 * different table, different meaning. The Telegram id is the identity; there is
 * no password column (auth — K-T2 — binds a session to a listed identity).
 *
 * The OWNER INVARIANTS are enforced HERE, in the store, not just in the UI:
 *   1. There is at most ONE `owner` row at any time.
 *   2. The owner can never be removed (`remove(owner)` rejects) and can never be
 *      demoted via `setRole` (role changes target non-owners only).
 *   3. Ownership changes ONLY through `transferOwner`, which atomically promotes
 *      the target to `owner` and demotes the previous owner to `admin` — both in
 *      one transaction, so the single-owner invariant always holds.
 *   4. `add` / `setRole` accept only the manageable roles (`admin`/`operator`).
 */
import { asc, eq } from 'drizzle-orm';
import type { ManageableRole, PanelAdmin, SessionRole } from '@ctb/shared';
import type { Db } from '../db/index';
import { panelAdmins } from '../db/schema';

/** Thrown when an operation would violate an owner invariant or a precondition. */
export class PanelAdminError extends Error {
  constructor(
    readonly code:
      | 'not_found'
      | 'already_exists'
      | 'owner_immutable'
      | 'owner_exists'
      | 'owner_required'
      | 'not_owner',
    message: string,
  ) {
    super(message);
    this.name = 'PanelAdminError';
  }
}

interface AdminRow {
  tgUserId: string;
  role: SessionRole;
  label: string;
  createdAt: string;
}

export class SqlitePanelAdminStore {
  constructor(
    private readonly db: Db,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  /** All admins, oldest-first (owner is usually the first bootstrapped row). */
  list(): PanelAdmin[] {
    return this.db
      .select()
      .from(panelAdmins)
      .orderBy(asc(panelAdmins.createdAt), asc(panelAdmins.tgUserId))
      .all()
      .map(toPublic);
  }

  /** One admin by Telegram id, or null. */
  get(tgUserId: string): PanelAdmin | null {
    const row = this.db
      .select()
      .from(panelAdmins)
      .where(eq(panelAdmins.tgUserId, tgUserId))
      .get();
    return row ? toPublic(row as AdminRow) : null;
  }

  /** The current owner, or null if the table is empty (pre-bootstrap). */
  owner(): PanelAdmin | null {
    const row = this.db
      .select()
      .from(panelAdmins)
      .where(eq(panelAdmins.role, 'owner'))
      .get();
    return row ? toPublic(row as AdminRow) : null;
  }

  /** True when no admins exist yet — first bring-up (K-T2 bootstraps the owner). */
  isEmpty(): boolean {
    return this.db.select().from(panelAdmins).limit(1).all().length === 0;
  }

  /**
   * Bootstrap the FIRST owner (K-T2's first-login path). Rejects if an owner
   * already exists (invariant 1) — ownership thereafter moves only via
   * `transferOwner`. Idempotent only in the sense that a second call throws
   * rather than minting a second owner.
   */
  bootstrapOwner(tgUserId: string, label: string): PanelAdmin {
    if (this.owner()) {
      throw new PanelAdminError('owner_exists', 'an owner already exists');
    }
    if (this.get(tgUserId)) {
      throw new PanelAdminError('already_exists', `admin "${tgUserId}" already exists`);
    }
    const row: AdminRow = {
      tgUserId,
      role: 'owner',
      label,
      createdAt: this.clock().toISOString(),
    };
    this.db.insert(panelAdmins).values(row).run();
    return toPublic(row);
  }

  /** Add an admin/operator (never an owner — use `bootstrapOwner`/`transferOwner`). */
  add(tgUserId: string, role: ManageableRole, label: string): PanelAdmin {
    if (this.get(tgUserId)) {
      throw new PanelAdminError('already_exists', `admin "${tgUserId}" already exists`);
    }
    const row: AdminRow = {
      tgUserId,
      role,
      label,
      createdAt: this.clock().toISOString(),
    };
    this.db.insert(panelAdmins).values(row).run();
    return toPublic(row);
  }

  /** Remove an admin. The owner can NEVER be removed (invariant 2). */
  remove(tgUserId: string): void {
    const existing = this.get(tgUserId);
    if (!existing) throw new PanelAdminError('not_found', `admin "${tgUserId}" not found`);
    if (existing.role === 'owner') {
      throw new PanelAdminError(
        'owner_immutable',
        'the owner cannot be removed — transfer ownership first',
      );
    }
    this.db.delete(panelAdmins).where(eq(panelAdmins.tgUserId, tgUserId)).run();
  }

  /**
   * Change a NON-owner's role between `admin`/`operator`. The owner's role is
   * immutable here (invariant 2); promotion to owner happens only via
   * `transferOwner`.
   */
  setRole(tgUserId: string, role: ManageableRole): PanelAdmin {
    const existing = this.get(tgUserId);
    if (!existing) throw new PanelAdminError('not_found', `admin "${tgUserId}" not found`);
    if (existing.role === 'owner') {
      throw new PanelAdminError(
        'owner_immutable',
        'the owner role is immutable — transfer ownership to change it',
      );
    }
    this.db.update(panelAdmins).set({ role }).where(eq(panelAdmins.tgUserId, tgUserId)).run();
    return { ...existing, role };
  }

  /**
   * Transfer ownership to an EXISTING admin/operator, atomically (invariant 3).
   * `caller` must be the current owner. The target is promoted to `owner` and
   * the previous owner is demoted to `admin` — in ONE transaction, so the
   * single-owner invariant never transiently breaks.
   */
  transferOwner(callerTgUserId: string, targetTgUserId: string): { owner: PanelAdmin; previous: PanelAdmin } {
    const current = this.owner();
    if (!current) throw new PanelAdminError('owner_required', 'no owner to transfer from');
    if (current.tgUserId !== callerTgUserId) {
      throw new PanelAdminError('not_owner', 'only the current owner can transfer ownership');
    }
    const target = this.get(targetTgUserId);
    if (!target) throw new PanelAdminError('not_found', `admin "${targetTgUserId}" not found`);
    if (target.tgUserId === current.tgUserId) {
      // No-op transfer to self — nothing changes, return the current owner.
      return { owner: current, previous: current };
    }

    this.db.transaction((tx) => {
      tx.update(panelAdmins).set({ role: 'admin' }).where(eq(panelAdmins.tgUserId, current.tgUserId)).run();
      tx.update(panelAdmins).set({ role: 'owner' }).where(eq(panelAdmins.tgUserId, target.tgUserId)).run();
    });

    return {
      owner: { ...target, role: 'owner' },
      previous: { ...current, role: 'admin' },
    };
  }
}

function toPublic(row: AdminRow): PanelAdmin {
  return {
    tgUserId: row.tgUserId,
    role: row.role,
    label: row.label,
    createdAt: row.createdAt,
  };
}
