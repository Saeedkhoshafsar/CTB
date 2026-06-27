/** Environment configuration, validated with zod. Server refuses to boot on bad env. */
import { z } from 'zod';

const EnvSchema = z.object({
  CTB_SECRET: z.string().min(16, 'CTB_SECRET must be at least 16 characters'),
  CTB_DB_PATH: z.string().default('data/ctb.sqlite'),
  CTB_PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  CTB_HOST: z.string().default('0.0.0.0'),
  CTB_ADMIN_USER: z.string().default('admin'),
  CTB_ADMIN_PASS: z.string().optional(),
  /**
   * Operator (the "manager") login — sees ONLY the Collections Data section
   * (records/files), never bots/flows/executions (P3.5-T2, ARCHITECTURE §13.5).
   * Optional: unset ⇒ no operator account. Both must be set to enable it.
   */
  CTB_OPERATOR_USER: z.string().default('operator'),
  CTB_OPERATOR_PASS: z.string().optional(),
  /**
   * Bootstrap-owner Telegram user id (K-T2, PLAN4 Phase K). On FIRST bring-up —
   * when the `panel_admins` table is empty — a successful env-credential login
   * (CTB_ADMIN_USER/PASS) creates the singleton OWNER row keyed by this Telegram
   * id, binding the panel to a real Telegram identity. Optional: unset ⇒ the
   * legacy env-only login still works (no owner row is minted) so existing
   * deployments are byte-compatible. A numeric string (ids exceed 2^53 → keep
   * textual). Once an owner exists this is ignored.
   */
  CTB_OWNER_TG_ID: z
    .string()
    .trim()
    .regex(/^\d{1,20}$/, 'CTB_OWNER_TG_ID must be a numeric Telegram user id')
    .optional(),
  /**
   * Local data dir for uploaded files (the `files` table stores a path under
   * `${CTB_DATA_DIR}/files`). Defaults beside the DB-style `data/`.
   */
  CTB_DATA_DIR: z.string().default('data'),
  /** Public base URL (https://bot.example.com) — required only for webhook-mode bots. */
  CTB_PUBLIC_URL: z.string().url().optional(),
  /**
   * Comma-separated host allow-list for the Code node's $http (ARCH §11),
   * e.g. "api.example.com,.trusted.io" (dot-prefix = any subdomain).
   * Unset/empty ⇒ unrestricted (single-admin v1 default).
   */
  CTB_CODE_HTTP_ALLOWLIST: z.string().optional(),
  /**
   * Per-expression evaluation budget in ms (forwarded to the executor's
   * expression evaluator). Each `{{ }}` runs in a sandbox worker with a hard
   * time budget (default 50ms — strict by design). On a slow/contended host
   * the worker's COLD START alone can exceed 50ms and error an otherwise-correct
   * flow; such deployments can raise this. Omitted ⇒ the strict 50ms default.
   */
  CTB_EXPRESSION_BUDGET_MS: z.coerce.number().int().min(1).optional(),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
});
export type Env = z.infer<typeof EnvSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const res = EnvSchema.safeParse(source);
  if (!res.success) {
    const lines = res.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid environment configuration:\n${lines.join('\n')}`);
  }
  return res.data;
}
