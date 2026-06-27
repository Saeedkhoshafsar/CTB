/**
 * Go-live setup checklist API (PLAN4 Phase L, L-T1).
 *
 *   GET /api/setup/checklist → SetupChecklist (admin+)
 *
 * This route is a THIN gatherer: it reads the raw facts from the real stores
 * (bot/active-flow counts from the DB, owner/admin counts from the admin store)
 * plus the env-derived booleans injected by app.ts (`hasSecret`, `hasDelivery`),
 * then hands the snapshot to the PURE `computeChecklist` (L-T1) which decides
 * what's still open. Keeping the decision pure means the behaviour is unit-tested
 * against crafted states with no DB; this layer just collects the inputs.
 *
 * The checklist is always derived from reality (principle 1) — there are no
 * stored "done" flags, so a task re-appears if its prerequisite is later undone.
 */
import { type SetupChecklist, type SetupState, SetupChecklistSchema } from '@ctb/shared';
import { count, eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Db } from '../db/index';
import { bots, flows } from '../db/schema';
import type { SqlitePanelAdminStore } from '../engine/admin-store';
import { computeChecklist } from '../engine/setup-checklist';
import type { SessionRole } from '../lib/session';

export interface SetupApiDeps {
  db: Db;
  /** Present when a DB is wired; used for owner/admin counts. */
  adminStore: SqlitePanelAdminStore;
  /** preHandler factory enforcing a minimum role (built in app.ts). */
  requireRole: (min: SessionRole) => (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  /**
   * Env-derived facts gathered at request time (app.ts owns env):
   *   • hasSecret    — CTB_SECRET is configured (sessions/credentials encryption).
   *   • hasPublicUrl — CTB_PUBLIC_URL is set (enables webhook delivery).
   * Passed as a thunk so it reflects the live env without this module importing
   * the env schema. Delivery is SATISFIED by a public URL (webhook) OR by any
   * registered bot (polling is the default no-domain fallback), so the route
   * combines this with the bot count below.
   */
  facts: () => { hasSecret: boolean; hasPublicUrl: boolean };
}

export function registerSetupApi(app: FastifyInstance, deps: SetupApiDeps): void {
  const { db, adminStore, requireRole, facts } = deps;
  const adminGuard = requireRole('admin');

  app.get('/api/setup/checklist', { preHandler: adminGuard }, async () => {
    const [botRow] = db.select({ c: count() }).from(bots).all();
    const [flowRow] = db
      .select({ c: count() })
      .from(flows)
      .where(eq(flows.status, 'active'))
      .all();

    const admins = adminStore.list();
    const hasOwner = admins.some((a) => a.role === 'owner');
    const nonOwnerAdminCount = admins.filter((a) => a.role !== 'owner').length;

    const { hasSecret, hasPublicUrl } = facts();
    const botCount = botRow?.c ?? 0;

    const state: SetupState = {
      hasSecret,
      hasOwner,
      nonOwnerAdminCount,
      botCount,
      activeFlowCount: flowRow?.c ?? 0,
      // Delivery works via webhook (public URL) OR polling (any bot, the default
      // no-domain fallback) — so a registered bot already has a delivery path.
      hasDelivery: hasPublicUrl || botCount > 0,
    };

    const checklist: SetupChecklist = computeChecklist(state);
    // Validate our own response shape (cheap, catches drift).
    return SetupChecklistSchema.parse(checklist);
  });
}
