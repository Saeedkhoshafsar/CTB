/**
 * data.dateTime — Date & Time (NODES.md §Date & Time; PLAN2 PA-T7).
 *
 * Parse / format / add-subtract / diff a date, with IANA timezones and Jalali
 * (Persian) calendar output. Pure: the only "now" comes from the injected
 * `ctx.now()` clock, and the Gregorian↔Jalali conversion is the hand-written
 * dependency-free algorithm in ../lib/jalali. Runs per item; the result is
 * merged under `save_as` onto a clone of each input item (never mutated).
 *
 * Operations:
 *   format → { formatted, iso, epoch }  (formatted in the chosen calendar/tz)
 *   add    → { iso, epoch }             (the source instant shifted by amount·unit)
 *   diff   → { diff, unit }             (source minus to_value, in diff_unit)
 *
 * Fails loudly on an unparseable date or an invalid timezone.
 */
import {
  DataDateTimeParamsSchema,
  fail,
  out,
  type DataDateTimeParams,
  type FlowItem,
  type NodeCtx,
  type NodeDef,
} from '@ctb/shared';
import { gregorianToJalali, JALALI_MONTHS_FA } from '../lib/jalali';

const PERSIAN_DIGITS = ['۰', '۱', '۲', '۳', '۴', '۵', '۶', '۷', '۸', '۹'];
const MS = { seconds: 1000, minutes: 60_000, hours: 3_600_000, days: 86_400_000 } as const;

export const dataDateTime: NodeDef<DataDateTimeParams> = {
  type: 'data.dateTime',
  category: 'data',
  meta: {
    labelKey: 'nodes.data.dateTime.label',
    descriptionKey: 'nodes.data.dateTime.desc',
    icon: 'calendar',
  },
  ports: { inputs: ['main'], outputs: ['main'] },
  paramsSchema: DataDateTimeParamsSchema,
  async execute(ctx, params, items) {
    // Validate the timezone once (an invalid tz must fail the whole node).
    if (params.timezone) {
      try {
        new Intl.DateTimeFormat('en-US', { timeZone: params.timezone });
      } catch {
        return fail(`data.dateTime: invalid timezone "${params.timezone}"`);
      }
    }

    const list = items.length > 0 ? items : [{ json: {} } as FlowItem];
    const result: FlowItem[] = [];

    for (const item of list) {
      const base = await resolveDate(ctx, params, params.source, params.value, item);
      if (base === null) {
        return fail(`data.dateTime: could not parse the source date`);
      }

      let payload: Record<string, unknown>;
      if (params.operation === 'add') {
        const shifted = addToDate(base, params.amount ?? 0, params.unit);
        payload = { iso: shifted.toISOString(), epoch: shifted.getTime() };
      } else if (params.operation === 'diff') {
        const other = await resolveDate(ctx, params, 'value', params.to_value, item);
        if (other === null) {
          return fail(`data.dateTime: could not parse to_value`);
        }
        payload = { diff: diffDates(base, other, params.diff_unit), unit: params.diff_unit };
      } else {
        // format
        const formatted = formatDate(base, params);
        payload = { formatted, iso: base.toISOString(), epoch: base.getTime() };
      }

      const json = { ...(item.json as Record<string, unknown>), [params.save_as]: payload };
      result.push({ ...item, json });
    }

    return out({ main: result });
  },
};

// ── date resolution ───────────────────────────────────────────────────────────

async function resolveDate(
  ctx: NodeCtx,
  _params: DataDateTimeParams,
  source: 'now' | 'value',
  raw: string | undefined,
  item: FlowItem,
): Promise<Date | null> {
  if (source === 'now') return ctx.now();
  if (raw === undefined || raw.trim() === '') return null;

  // Resolve {{ }} expressions through the host evaluator first.
  let text = raw;
  if (raw.includes('{{')) {
    text = (await ctx.eval(raw, item.json as Record<string, unknown>)).trim();
  }
  return parseDate(text);
}

/** Lenient parse: epoch millis, ISO-8601, or YYYY-MM-DD / YYYY/MM/DD. */
export function parseDate(text: string): Date | null {
  const t = text.trim();
  if (t === '') return null;

  // Pure-integer string → epoch millis.
  if (/^-?\d+$/.test(t)) {
    const d = new Date(Number(t));
    return Number.isNaN(d.getTime()) ? null : d;
  }

  // Normalise YYYY/MM/DD → YYYY-MM-DD so Date parses it as ISO (UTC midnight).
  const slash = /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/.exec(t);
  const iso = slash ? `${slash[1]}-${pad(slash[2]!)}-${pad(slash[3]!)}` : t;

  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

// ── add / diff ──────────────────────────────────────────────────────────────

function addToDate(base: Date, amount: number, unit: DataDateTimeParams['unit']): Date {
  const d = new Date(base.getTime());
  switch (unit) {
    case 'years':
      d.setUTCFullYear(d.getUTCFullYear() + amount);
      return d;
    case 'months':
      d.setUTCMonth(d.getUTCMonth() + amount);
      return d;
    case 'days':
      return new Date(base.getTime() + amount * MS.days);
    case 'hours':
      return new Date(base.getTime() + amount * MS.hours);
    case 'minutes':
      return new Date(base.getTime() + amount * MS.minutes);
    case 'seconds':
      return new Date(base.getTime() + amount * MS.seconds);
  }
}

/** Difference `a - b` expressed in `unit` (may be fractional). */
function diffDates(a: Date, b: Date, unit: DataDateTimeParams['diff_unit']): number {
  const ms = a.getTime() - b.getTime();
  switch (unit) {
    case 'seconds':
      return ms / MS.seconds;
    case 'minutes':
      return ms / MS.minutes;
    case 'hours':
      return ms / MS.hours;
    case 'days':
      return ms / MS.days;
    case 'months':
      return (a.getUTCFullYear() - b.getUTCFullYear()) * 12 + (a.getUTCMonth() - b.getUTCMonth());
    case 'years':
      return a.getUTCFullYear() - b.getUTCFullYear();
  }
}

// ── formatting ────────────────────────────────────────────────────────────────

/**
 * Format `base` in the chosen timezone + calendar with a token pattern.
 * Tokens: YYYY, MM, DD, HH, mm, ss, MMMM (month name). Unknown chars pass
 * through verbatim. Jalali converts the timezone-local wall-clock Y/M/D.
 */
function formatDate(base: Date, params: DataDateTimeParams): string {
  const tz = params.timezone || undefined;
  const wall = wallClockParts(base, tz);

  let year = wall.year;
  let month = wall.month;
  let day = wall.day;
  let monthName: string;

  if (params.calendar === 'jalali') {
    const j = gregorianToJalali({ year: wall.year, month: wall.month, day: wall.day });
    year = j.year;
    month = j.month;
    day = j.day;
    monthName = JALALI_MONTHS_FA[j.month - 1] ?? String(j.month);
  } else {
    monthName = GREGORIAN_MONTHS_EN[wall.month - 1] ?? String(wall.month);
  }

  const out = params.format
    .replace(/YYYY/g, pad4(year))
    .replace(/MMMM/g, monthName)
    .replace(/MM/g, pad(month))
    .replace(/DD/g, pad(day))
    .replace(/HH/g, pad(wall.hour))
    .replace(/mm/g, pad(wall.minute))
    .replace(/ss/g, pad(wall.second));

  return params.digits === 'persian' ? toPersianDigits(out) : out;
}

const GREGORIAN_MONTHS_EN = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

interface WallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

/** Extract wall-clock fields of `date` in the given IANA timezone. */
function wallClockParts(date: Date, timeZone: string | undefined): WallClock {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const parts = fmt.formatToParts(date);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? '0');
  let hour = get('hour');
  if (hour === 24) hour = 0; // Intl can emit "24" for midnight in some engines
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour,
    minute: get('minute'),
    second: get('second'),
  };
}

// ── helpers ───────────────────────────────────────────────────────────────────

function pad(n: number | string): string {
  return String(n).padStart(2, '0');
}

function pad4(n: number): string {
  return String(n).padStart(4, '0');
}

function toPersianDigits(s: string): string {
  return s.replace(/\d/g, (d) => PERSIAN_DIGITS[Number(d)]!);
}
