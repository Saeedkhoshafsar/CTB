/**
 * Gregorian ↔ Jalali (Persian / Solar Hijri) calendar conversion.
 *
 * A small, pure, dependency-free implementation of the well-known Jalaali
 * algorithm (Kazimierz M. Borkowski's method, as popularised by the
 * `jalaali-js` project). We keep it in `@ctb/nodes` rather than adding a
 * runtime dependency because it is tiny, exact for the supported range
 * (1178–1633 Jalali ≈ 1799–2255 Gregorian), and easy to unit-test.
 *
 * All functions work on plain calendar field numbers (year/month/day) — they
 * never touch Date objects or timezones. The caller is responsible for first
 * extracting the wall-clock Y/M/D in the desired timezone.
 */

/** A calendar date as plain fields (month is 1-based). */
export interface CalendarDate {
  year: number;
  month: number;
  day: number;
}

/** Persian (Jalali) month names, index 0 = Farvardin. */
export const JALALI_MONTHS_FA = [
  'فروردین',
  'اردیبهشت',
  'خرداد',
  'تیر',
  'مرداد',
  'شهریور',
  'مهر',
  'آبان',
  'آذر',
  'دی',
  'بهمن',
  'اسفند',
] as const;

/** Convert a Gregorian date (1-based month) to Jalali. */
export function gregorianToJalali(g: CalendarDate): CalendarDate {
  return d2j(g2d(g.year, g.month, g.day));
}

/** Convert a Jalali date (1-based month) to Gregorian. */
export function jalaliToGregorian(j: CalendarDate): CalendarDate {
  return d2g(j2d(j.year, j.month, j.day));
}

/** Is the given Jalali year a leap year (366 days)? */
export function isJalaliLeapYear(jy: number): boolean {
  return jalCal(jy).leap === 0;
}

// ── internals (Borkowski algorithm) ───────────────────────────────────────────

interface JalCal {
  leap: number; // 0 → leap year
  gy: number; // Gregorian year of the Jalali year's start
  march: number; // March day of Farvardin 1
}

/**
 * Computes leap-year and other calendar data for a Jalali year `jy`.
 * Returns { leap, gy, march }.
 */
function jalCal(jy: number): JalCal {
  const breaks = [
    -61, 9, 38, 199, 426, 686, 756, 818, 1111, 1181, 1210, 1635, 2060, 2097, 2192, 2262, 2324,
    2394, 2456, 3178,
  ];
  const bl = breaks.length;
  const gy = jy + 621;
  let leapJ = -14;
  let jp = breaks[0]!;

  if (jy < jp || jy >= breaks[bl - 1]!) {
    throw new RangeError(`Jalali year ${jy} is out of the supported range`);
  }

  let jump = 0;
  for (let i = 1; i < bl; i += 1) {
    const jm = breaks[i]!;
    jump = jm - jp;
    if (jy < jm) break;
    leapJ = leapJ + div(jump, 33) * 8 + div(mod(jump, 33), 4);
    jp = jm;
  }
  let n = jy - jp;

  leapJ = leapJ + div(n, 33) * 8 + div(mod(n, 33) + 3, 4);
  if (mod(jump, 33) === 4 && jump - n === 4) leapJ += 1;

  const leapG = div(gy, 4) - div((div(gy, 100) + 1) * 3, 4) - 150;
  const march = 20 + leapJ - leapG;

  if (jump - n < 6) n = n - jump + div(jump + 4, 33) * 33;
  let leap = mod(mod(n + 1, 33) - 1, 4);
  if (leap === -1) leap = 4;

  return { leap, gy, march };
}

/** Jalali date → Julian Day Number. */
function j2d(jy: number, jm: number, jd: number): number {
  const r = jalCal(jy);
  return g2d(r.gy, 3, r.march) + (jm - 1) * 31 - div(jm, 7) * (jm - 7) + jd - 1;
}

/** Julian Day Number → Jalali date. */
function d2j(jdn: number): CalendarDate {
  const gy = d2g(jdn).year; // Gregorian year of the JDN
  let jy = gy - 621;
  const r = jalCal(jy);
  const jdn1f = g2d(gy, 3, r.march);
  let k = jdn - jdn1f;

  if (k >= 0) {
    if (k <= 185) {
      const jm = 1 + div(k, 31);
      const jd = mod(k, 31) + 1;
      return { year: jy, month: jm, day: jd };
    }
    k -= 186;
  } else {
    jy -= 1;
    k += 179;
    if (r.leap === 1) k += 1;
  }
  const jm = 7 + div(k, 30);
  const jd = mod(k, 30) + 1;
  return { year: jy, month: jm, day: jd };
}

/** Gregorian date → Julian Day Number. */
function g2d(gy: number, gm: number, gd: number): number {
  let d =
    div((gy + div(gm - 8, 6) + 100100) * 1461, 4) +
    div(153 * mod(gm + 9, 12) + 2, 5) +
    gd -
    34840408;
  d = d - div(div(gy + 100100 + div(gm - 8, 6), 100) * 3, 4) + 752;
  return d;
}

/** Julian Day Number → Gregorian date. */
function d2g(jdn: number): CalendarDate {
  let j = 4 * jdn + 139361631;
  j = j + div(div(4 * jdn + 183187720, 146097) * 3, 4) * 4 - 3908;
  const i = div(mod(j, 1461), 4) * 5 + 308;
  const gd = div(mod(i, 153), 5) + 1;
  const gm = mod(div(i, 153), 12) + 1;
  const gy = div(j, 1461) - 100100 + div(8 - gm, 6);
  return { year: gy, month: gm, day: gd };
}

function div(a: number, b: number): number {
  return ~~(a / b);
}

function mod(a: number, b: number): number {
  return a - ~~(a / b) * b;
}
