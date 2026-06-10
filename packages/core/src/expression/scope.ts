/**
 * Expression scope builder (ARCHITECTURE §6).
 * Assembles the `$`-variables visible inside `{{ … }}` from execution context.
 * Pure data + tiny frozen helpers — no I/O capability lives here (invariant I6).
 */
import type { FlowItem } from '@ctb/shared';

export interface ScopeInput {
  /** Current item's json — `$json`. */
  json?: Record<string, unknown>;
  /** All input items — `$items`. */
  items?: FlowItem[];
  /** Execution variables — `$vars`. */
  vars?: Record<string, unknown>;
  /** CTB user record — `$user`. */
  user?: Record<string, unknown> | null;
  /** Telegram chat info — `$chat`. */
  chat?: Record<string, unknown> | null;
  /** `$execution` = { id, startedAt }. */
  execution?: { id: string; startedAt: number } | null;
  /** `$flow` = { id, name }. */
  flow?: { id: string; name: string } | null;
  /** Whitelisted instance settings — `$env`. */
  env?: Record<string, string>;
  /** Clock override for tests. */
  now?: () => Date;
}

export interface ExpressionScope {
  readonly [key: string]: unknown;
  readonly $json: Record<string, unknown>;
  readonly $items: FlowItem[];
  readonly $vars: Record<string, unknown>;
  readonly $user: Record<string, unknown> | null;
  readonly $chat: Record<string, unknown> | null;
  readonly $execution: { id: string; startedAt: number } | null;
  readonly $flow: { id: string; name: string } | null;
  readonly $env: Record<string, string>;
  readonly $now: NowHelper;
}

export interface NowHelper {
  /** Epoch ms. */
  ts(): number;
  /** ISO-8601 string. */
  iso(): string;
  /** Tiny formatter: YYYY MM DD HH mm ss tokens. */
  format(pattern: string): string;
  /** The underlying Date. */
  date(): Date;
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

export function makeNowHelper(clock: () => Date = () => new Date()): NowHelper {
  return Object.freeze({
    ts: () => clock().getTime(),
    iso: () => clock().toISOString(),
    date: () => clock(),
    format: (pattern: string) => {
      const d = clock();
      return pattern
        .replace(/YYYY/g, String(d.getFullYear()))
        .replace(/MM/g, pad(d.getMonth() + 1))
        .replace(/DD/g, pad(d.getDate()))
        .replace(/HH/g, pad(d.getHours()))
        .replace(/mm/g, pad(d.getMinutes()))
        .replace(/ss/g, pad(d.getSeconds()));
    },
  });
}

/** Shallow-freeze a copy so expressions can't mutate scope containers. */
function frozenCopy<T extends Record<string, unknown>>(obj: T | undefined | null): T {
  return Object.freeze({ ...(obj ?? {}) }) as T;
}

export function buildScope(input: ScopeInput = {}): ExpressionScope {
  return Object.freeze({
    $json: frozenCopy(input.json),
    $items: Object.freeze([...(input.items ?? [])]) as unknown as FlowItem[],
    $vars: frozenCopy(input.vars),
    $user: input.user ? frozenCopy(input.user) : null,
    $chat: input.chat ? frozenCopy(input.chat) : null,
    $execution: input.execution ? Object.freeze({ ...input.execution }) : null,
    $flow: input.flow ? Object.freeze({ ...input.flow }) : null,
    $env: frozenCopy(input.env),
    $now: makeNowHelper(input.now),
  });
}
