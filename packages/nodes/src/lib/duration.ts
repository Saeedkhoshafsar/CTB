/**
 * Duration strings → milliseconds ("30s", "15m", "2h", "7d", "500ms").
 * Shape is validated by DurationStringSchema (shared) at param time;
 * this parser is the single runtime interpretation.
 */
const UNIT_MS: Record<string, number> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

export function parseDuration(input: string): number {
  const m = /^(\d+)\s*(ms|s|m|h|d)$/.exec(input.trim());
  if (!m) throw new Error(`invalid duration "${input}" (expected e.g. "30s", "15m", "2h", "7d")`);
  return Number(m[1]) * UNIT_MS[m[2]!]!;
}

/** ISO deadline = now + duration. */
export function deadlineFrom(now: Date, duration: string): string {
  return new Date(now.getTime() + parseDuration(duration)).toISOString();
}
