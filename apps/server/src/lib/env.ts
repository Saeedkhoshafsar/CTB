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
