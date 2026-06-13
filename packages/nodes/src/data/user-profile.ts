/**
 * data.userProfile — User Profile (NODES.md §User Profile, P3-T5). Reads or
 * updates the CTB end-user record (the `users` table) via the injected
 * `ctx.users` capability. A GENERIC CRM-ish primitive (invariant I2): it only
 * touches `profile` (a free-form bag the flow author defines) and `tags`
 * (string labels) — it never knows any domain field; the host owns the table.
 *
 * Ops:
 *  - get          → reads the record (no write); merged into $json.<save_as>
 *  - set_profile  → writes `fields` (dotted names → nested) into profile,
 *                   merge (default) or replace; read-back merged
 *  - add_tags     → adds `tags` (de-duplicated); read-back merged
 *  - remove_tags  → removes `tags`; read-back merged
 *
 * Targets the execution's OWN user by default; an explicit `user` param (a tg
 * user id, expression-resolved upstream) addresses a different one. The op runs
 * ONCE per node run (the user record is execution-external state — like data.kv,
 * hitting it per item would surprise). Output mirrors input items (empty input
 * → one seeded item) with the resulting record merged into each item's json
 * under `save_as` (default "user").
 */
import {
  UserProfileParamsSchema,
  fail,
  out,
  type CtbUser,
  type FlowItem,
  type NodeDef,
  type UserProfileParams,
} from '@ctb/shared';

export const dataUserProfile: NodeDef<UserProfileParams> = {
  type: 'data.userProfile',
  category: 'data',
  meta: {
    labelKey: 'nodes.data.userProfile.label',
    descriptionKey: 'nodes.data.userProfile.desc',
    icon: 'user',
  },
  ports: { inputs: ['main'], outputs: ['main'] },
  paramsSchema: UserProfileParamsSchema,
  async execute(ctx, params, items) {
    if (!ctx.users) {
      return fail('data.userProfile: user store is not available on this instance');
    }

    // Resolve the target user id: explicit `user` param wins, else the host
    // defaults to the execution's own user (ctx.users handles undefined).
    let targetId: number | undefined;
    if (params.user !== undefined && params.user !== '') {
      const n = Number(params.user);
      if (!Number.isInteger(n)) {
        return fail(`data.userProfile: "user" is not a valid tg user id (${JSON.stringify(params.user)})`);
      }
      targetId = n;
    }

    const saveAs = params.save_as ?? 'user';
    let record: CtbUser | null;

    try {
      switch (params.op) {
        case 'get': {
          record = await ctx.users.get(targetId);
          break;
        }
        case 'set_profile': {
          const bag: Record<string, unknown> = {};
          for (const row of params.fields ?? []) setAtPath(bag, row.field, row.value);
          record = await ctx.users.setProfile(bag, {
            mode: params.mode,
            ...(targetId !== undefined ? { tgUserId: targetId } : {}),
          });
          break;
        }
        case 'add_tags': {
          record = await ctx.users.addTags(params.tags ?? [], targetId);
          break;
        }
        case 'remove_tags': {
          record = await ctx.users.removeTags(params.tags ?? [], targetId);
          break;
        }
      }
    } catch (err) {
      return fail(`data.userProfile: ${err instanceof Error ? err.message : String(err)}`);
    }

    const input: FlowItem[] = items.length > 0 ? items : [{ json: {} }];
    return out({
      main: input.map((item) => {
        const next: FlowItem = { json: { ...item.json, [saveAs]: record } };
        if (item.binary !== undefined) next.binary = item.binary;
        return next;
      }),
    });
  },
};

/** Set `value` at a dotted `path` inside `obj`, creating nested objects (immutable-ish). */
function setAtPath(obj: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.').filter((p) => p !== '');
  if (parts.length === 0) return;
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i]!;
    const existing = cur[key];
    if (typeof existing !== 'object' || existing === null || Array.isArray(existing)) {
      cur[key] = {};
    }
    cur = cur[key] as Record<string, unknown>;
  }
  cur[parts[parts.length - 1]!] = value;
}
