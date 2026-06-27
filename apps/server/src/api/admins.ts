/**
 * Panel-admin management API (K-T2, PLAN4 Phase K) — the REST surface over the
 * durable `SqlitePanelAdminStore` (K-T1) that lets the panel manage WHO may see
 * and operate it, keyed by Telegram user id.
 *
 *   GET    /api/admins                  → PanelAdminList (admin+)
 *   POST   /api/admins                  → add an admin/operator (admin+)
 *   DELETE /api/admins/:id              → remove a non-owner (admin+)
 *   PATCH  /api/admins/:id/role         → change a non-owner's role (admin+)
 *   POST   /api/admins/transfer-owner   → owner-only; demotes the old owner
 *
 * The OWNER INVARIANTS are enforced in the STORE (K-T1) — exactly one owner,
 * never removable/demotable, ownership moves only via an atomic transfer. This
 * layer adds the PERMISSION gate on top:
 *   • add / remove / setRole require at least `admin` (operators can't manage
 *     admins);
 *   • transfer-owner requires the caller to be the `owner` (defence-in-depth —
 *     the store also rejects a non-owner caller).
 *
 * Panel admins are panel identities, kept strictly separate from the per-bot
 * end-user store (invariant I2).
 */
import {
  AddPanelAdminBodySchema,
  SetPanelAdminRoleBodySchema,
  TransferOwnerBodySchema,
  type PanelAdminList,
} from '@ctb/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { PanelAdminError, type SqlitePanelAdminStore } from '../engine/admin-store';
import type { SessionRole } from '../lib/session';

export interface AdminsApiDeps {
  store: SqlitePanelAdminStore;
  /**
   * preHandler factory enforcing a minimum role (built in app.ts from the
   * session guard + the pure `roleAtLeast`). Injected so this module stays
   * unaware of cookie/secret details.
   */
  requireRole: (min: SessionRole) => (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  /** Reads the authenticated caller's Telegram id from the session, if any. */
  callerTgUserId: (req: FastifyRequest) => string | null;
}

/** Map a store error code → HTTP status. */
function statusFor(code: PanelAdminError['code']): number {
  switch (code) {
    case 'not_found':
      return 404;
    case 'already_exists':
      return 409;
    case 'owner_immutable':
    case 'owner_exists':
    case 'owner_required':
      return 409;
    case 'not_owner':
      return 403;
    default:
      return 400;
  }
}

export function registerAdminsApi(app: FastifyInstance, deps: AdminsApiDeps): void {
  const { store, requireRole, callerTgUserId } = deps;
  const adminGuard = requireRole('admin');
  const ownerGuard = requireRole('owner');

  app.get('/api/admins', { preHandler: adminGuard }, async () => {
    const body: PanelAdminList = { admins: store.list() };
    return body;
  });

  app.post('/api/admins', { preHandler: adminGuard }, async (req, reply) => {
    const parsed = AddPanelAdminBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_body', issues: parsed.error.issues });
    }
    const { tgUserId, role, label } = parsed.data;
    try {
      const admin = store.add(tgUserId, role, label);
      return reply.code(201).send({ admin });
    } catch (err) {
      if (err instanceof PanelAdminError) {
        return reply.code(statusFor(err.code)).send({ error: err.code, message: err.message });
      }
      throw err;
    }
  });

  app.delete('/api/admins/:id', { preHandler: adminGuard }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      store.remove(id);
      return { ok: true };
    } catch (err) {
      if (err instanceof PanelAdminError) {
        return reply.code(statusFor(err.code)).send({ error: err.code, message: err.message });
      }
      throw err;
    }
  });

  app.patch('/api/admins/:id/role', { preHandler: adminGuard }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = SetPanelAdminRoleBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_body', issues: parsed.error.issues });
    }
    try {
      const admin = store.setRole(id, parsed.data.role);
      return { admin };
    } catch (err) {
      if (err instanceof PanelAdminError) {
        return reply.code(statusFor(err.code)).send({ error: err.code, message: err.message });
      }
      throw err;
    }
  });

  app.post('/api/admins/transfer-owner', { preHandler: ownerGuard }, async (req, reply) => {
    const parsed = TransferOwnerBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_body', issues: parsed.error.issues });
    }
    const caller = callerTgUserId(req);
    if (!caller) {
      // An owner-role session that isn't bound to a Telegram identity can't be
      // the store owner — refuse rather than guess.
      return reply.code(403).send({ error: 'not_owner', message: 'session has no Telegram identity' });
    }
    try {
      const result = store.transferOwner(caller, parsed.data.tgUserId);
      return result;
    } catch (err) {
      if (err instanceof PanelAdminError) {
        return reply.code(statusFor(err.code)).send({ error: err.code, message: err.message });
      }
      throw err;
    }
  });
}
