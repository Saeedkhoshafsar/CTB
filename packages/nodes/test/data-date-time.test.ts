/**
 * PA-T7 contract tests — data.dateTime (Date & Time).
 *
 * A pure node: parse / format / add-subtract / diff a date, with IANA
 * timezones and Jalali (Persian) calendar output. The only clock is the
 * injected ctx.now(), so everything below is deterministic.
 *
 * We also unit-test the underlying Gregorian↔Jalali conversion (lib/jalali)
 * directly — including round-trips and known anchor dates verified against
 * the platform's Intl Persian calendar.
 */
import { NodeRegistry } from '@ctb/core';
import { describe, expect, it } from 'vitest';
import { builtinNodes, dataDateTime, parseDate, registerBuiltinNodes } from '@ctb/nodes';
import {
  gregorianToJalali,
  jalaliToGregorian,
  isJalaliLeapYear,
  JALALI_MONTHS_FA,
} from '../src/lib/jalali';
import { item, makeCtx, params } from './node-harness';

type J = Record<string, unknown>;
const j = (it: { json: unknown }) => it.json as J;

// A fixed clock for the node tests. 2026-06-11T10:00Z ≈ Jalali 1405/03/21.
const NOW = new Date('2026-06-11T10:00:00.000Z');

// ── registry ──────────────────────────────────────────────────────────────────

describe('data.dateTime — registry', () => {
  it('registers the node; registry is 42 types', () => {
    const reg = registerBuiltinNodes(new NodeRegistry());
    expect(reg.has('data.dateTime')).toBe(true);
    expect(dataDateTime.category).toBe('data');
    expect(builtinNodes.length).toBe(55);
  });

  it('has main→main ports', () => {
    expect(dataDateTime.ports.inputs).toEqual(['main']);
    expect(dataDateTime.ports.outputs).toEqual(['main']);
  });
});

// ── lib/jalali: Gregorian ↔ Jalali ──────────────────────────────────────────

describe('lib/jalali — conversion', () => {
  it('converts known anchor dates (verified vs Intl Persian calendar)', () => {
    expect(gregorianToJalali({ year: 2026, month: 6, day: 11 })).toEqual({
      year: 1405,
      month: 3,
      day: 21,
    });
    // PLAN2's worked example: 2025-06-14 → ۱۴۰۴/۰۳/۲۴.
    expect(gregorianToJalali({ year: 2025, month: 6, day: 14 })).toEqual({
      year: 1404,
      month: 3,
      day: 24,
    });
    // Nowruz (Persian new year) — Farvardin 1.
    expect(gregorianToJalali({ year: 2024, month: 3, day: 20 })).toEqual({
      year: 1403,
      month: 1,
      day: 1,
    });
  });

  it('round-trips Gregorian → Jalali → Gregorian', () => {
    for (const g of [
      { year: 2026, month: 6, day: 11 },
      { year: 2000, month: 1, day: 1 },
      { year: 2024, month: 2, day: 29 }, // Gregorian leap day
      { year: 2050, month: 12, day: 31 },
    ]) {
      expect(jalaliToGregorian(gregorianToJalali(g))).toEqual(g);
    }
  });

  it('knows Jalali leap years', () => {
    // 1403 is a leap year (has Esfand 30); 1404 is not.
    expect(isJalaliLeapYear(1403)).toBe(true);
    expect(isJalaliLeapYear(1404)).toBe(false);
  });

  it('exposes 12 Persian month names, Farvardin first', () => {
    expect(JALALI_MONTHS_FA).toHaveLength(12);
    expect(JALALI_MONTHS_FA[0]).toBe('فروردین');
    expect(JALALI_MONTHS_FA[11]).toBe('اسفند');
  });
});

// ── parseDate ─────────────────────────────────────────────────────────────────

describe('parseDate', () => {
  it('parses epoch millis, ISO and YYYY/MM/DD; rejects junk', () => {
    expect(parseDate('0')?.toISOString()).toBe('1970-01-01T00:00:00.000Z');
    expect(parseDate('2026-06-11T10:00:00.000Z')?.toISOString()).toBe('2026-06-11T10:00:00.000Z');
    expect(parseDate('2026/06/11')?.toISOString()).toBe('2026-06-11T00:00:00.000Z');
    expect(parseDate('not a date')).toBeNull();
    expect(parseDate('   ')).toBeNull();
  });
});

// ── format ──────────────────────────────────────────────────────────────────

describe('data.dateTime — format', () => {
  it('formats "now" in Gregorian by default (happy)', async () => {
    const ctx = makeCtx({ now: NOW });
    const p = params(dataDateTime, { operation: 'format', source: 'now' });
    const res = await dataDateTime.execute(ctx, p, [item({ id: 1 })]);
    if (res.kind !== 'items') throw new Error('expected items');
    const dt = j(res.outputs.main![0]!).datetime as J;
    expect(dt.formatted).toBe('2026-06-11');
    expect(dt.iso).toBe('2026-06-11T10:00:00.000Z');
    expect(dt.epoch).toBe(NOW.getTime());
    // input fields are preserved.
    expect(j(res.outputs.main![0]!).id).toBe(1);
  });

  it('formats in the Jalali calendar', async () => {
    const ctx = makeCtx({ now: NOW });
    const p = params(dataDateTime, {
      operation: 'format',
      source: 'now',
      calendar: 'jalali',
      format: 'YYYY/MM/DD',
    });
    const res = await dataDateTime.execute(ctx, p, [item({})]);
    if (res.kind !== 'items') throw new Error('expected items');
    expect((j(res.outputs.main![0]!).datetime as J).formatted).toBe('1405/03/21');
  });

  it('renders Jalali with Persian month name and Persian digits', async () => {
    const ctx = makeCtx({ now: NOW });
    const p = params(dataDateTime, {
      operation: 'format',
      source: 'value',
      value: '2025-06-14',
      calendar: 'jalali',
      digits: 'persian',
      format: 'DD MMMM YYYY',
    });
    const res = await dataDateTime.execute(ctx, p, [item({})]);
    if (res.kind !== 'items') throw new Error('expected items');
    // 2025-06-14 → 1404/03/24 → "۲۴ خرداد ۱۴۰۴".
    expect((j(res.outputs.main![0]!).datetime as J).formatted).toBe('۲۴ خرداد ۱۴۰۴');
  });

  it('formats time tokens HH:mm:ss in a timezone', async () => {
    const ctx = makeCtx({ now: NOW });
    const p = params(dataDateTime, {
      operation: 'format',
      source: 'now',
      timezone: 'Asia/Tehran', // UTC+03:30 → 13:30
      format: 'HH:mm:ss',
    });
    const res = await dataDateTime.execute(ctx, p, [item({})]);
    if (res.kind !== 'items') throw new Error('expected items');
    expect((j(res.outputs.main![0]!).datetime as J).formatted).toBe('13:30:00');
  });

  it('timezone can push the Jalali day to the next one', async () => {
    const ctx = makeCtx({ now: new Date('2026-06-11T22:00:00.000Z') });
    const p = params(dataDateTime, {
      operation: 'format',
      source: 'now',
      timezone: 'Asia/Tehran', // 01:30 next local day
      calendar: 'jalali',
      format: 'YYYY/MM/DD',
    });
    const res = await dataDateTime.execute(ctx, p, [item({})]);
    if (res.kind !== 'items') throw new Error('expected items');
    expect((j(res.outputs.main![0]!).datetime as J).formatted).toBe('1405/03/22');
  });

  it('honours a custom save_as key', async () => {
    const ctx = makeCtx({ now: NOW });
    const p = params(dataDateTime, { operation: 'format', source: 'now', save_as: 'stamp' });
    const res = await dataDateTime.execute(ctx, p, [item({})]);
    if (res.kind !== 'items') throw new Error('expected items');
    expect(j(res.outputs.main![0]!).stamp).toBeDefined();
    expect(j(res.outputs.main![0]!).datetime).toBeUndefined();
  });

  it('runs once on an empty input list (source=now)', async () => {
    const ctx = makeCtx({ now: NOW });
    const p = params(dataDateTime, { operation: 'format', source: 'now' });
    const res = await dataDateTime.execute(ctx, p, []);
    if (res.kind !== 'items') throw new Error('expected items');
    expect(res.outputs.main!).toHaveLength(1);
    expect((j(res.outputs.main![0]!).datetime as J).formatted).toBe('2026-06-11');
  });
});

// ── add / subtract ──────────────────────────────────────────────────────────

describe('data.dateTime — add', () => {
  it('adds days', async () => {
    const ctx = makeCtx({ now: NOW });
    const p = params(dataDateTime, { operation: 'add', source: 'now', amount: 5, unit: 'days' });
    const res = await dataDateTime.execute(ctx, p, [item({})]);
    if (res.kind !== 'items') throw new Error('expected items');
    expect((j(res.outputs.main![0]!).datetime as J).iso).toBe('2026-06-16T10:00:00.000Z');
  });

  it('subtracts hours (negative amount)', async () => {
    const ctx = makeCtx({ now: NOW });
    const p = params(dataDateTime, { operation: 'add', source: 'now', amount: -12, unit: 'hours' });
    const res = await dataDateTime.execute(ctx, p, [item({})]);
    if (res.kind !== 'items') throw new Error('expected items');
    expect((j(res.outputs.main![0]!).datetime as J).iso).toBe('2026-06-10T22:00:00.000Z');
  });

  it('adds calendar months (UTC)', async () => {
    const ctx = makeCtx({ now: NOW });
    const p = params(dataDateTime, { operation: 'add', source: 'now', amount: 2, unit: 'months' });
    const res = await dataDateTime.execute(ctx, p, [item({})]);
    if (res.kind !== 'items') throw new Error('expected items');
    expect((j(res.outputs.main![0]!).datetime as J).iso).toBe('2026-08-11T10:00:00.000Z');
  });

  it('coerces a string amount through the schema', async () => {
    const ctx = makeCtx({ now: NOW });
    const p = params(dataDateTime, { operation: 'add', source: 'now', amount: '3', unit: 'days' });
    const res = await dataDateTime.execute(ctx, p, [item({})]);
    if (res.kind !== 'items') throw new Error('expected items');
    expect((j(res.outputs.main![0]!).datetime as J).iso).toBe('2026-06-14T10:00:00.000Z');
  });
});

// ── diff ──────────────────────────────────────────────────────────────────────

describe('data.dateTime — diff', () => {
  it('diffs now − to_value in days', async () => {
    const ctx = makeCtx({ now: NOW });
    const p = params(dataDateTime, {
      operation: 'diff',
      source: 'now',
      to_value: '2026-06-01T10:00:00.000Z',
      diff_unit: 'days',
    });
    const res = await dataDateTime.execute(ctx, p, [item({})]);
    if (res.kind !== 'items') throw new Error('expected items');
    const dt = j(res.outputs.main![0]!).datetime as J;
    expect(dt.diff).toBe(10);
    expect(dt.unit).toBe('days');
  });

  it('diffs two explicit values in hours (fractional)', async () => {
    const ctx = makeCtx({ now: NOW });
    const p = params(dataDateTime, {
      operation: 'diff',
      source: 'value',
      value: '2026-06-11T12:30:00.000Z',
      to_value: '2026-06-11T10:00:00.000Z',
      diff_unit: 'hours',
    });
    const res = await dataDateTime.execute(ctx, p, [item({})]);
    if (res.kind !== 'items') throw new Error('expected items');
    expect((j(res.outputs.main![0]!).datetime as J).diff).toBe(2.5);
  });
});

// ── expression resolution + errors ──────────────────────────────────────────

describe('data.dateTime — expressions & errors', () => {
  it('resolves a {{ }} expression in value via ctx.eval', async () => {
    // The harness ctx.eval echoes its template; we stub a resolving one.
    const ctx = makeCtx({ now: NOW });
    ctx.eval = async () => '2025-06-14';
    const p = params(dataDateTime, {
      operation: 'format',
      source: 'value',
      value: '{{ $json.when }}',
      calendar: 'jalali',
      format: 'YYYY/MM/DD',
    });
    const res = await dataDateTime.execute(ctx, p, [item({ when: '2025-06-14' })]);
    if (res.kind !== 'items') throw new Error('expected items');
    expect((j(res.outputs.main![0]!).datetime as J).formatted).toBe('1404/03/24');
  });

  it('fails loudly on an unparseable source date', async () => {
    const ctx = makeCtx({ now: NOW });
    const p = params(dataDateTime, { operation: 'format', source: 'value', value: 'garbage' });
    const res = await dataDateTime.execute(ctx, p, [item({})]);
    expect(res.kind).toBe('error');
  });

  it('fails loudly on an invalid timezone', async () => {
    const ctx = makeCtx({ now: NOW });
    const p = params(dataDateTime, { operation: 'format', source: 'now', timezone: 'Mars/Olympus' });
    const res = await dataDateTime.execute(ctx, p, [item({})]);
    expect(res.kind).toBe('error');
  });

  it('schema rejects value source with no value', () => {
    expect(() => params(dataDateTime, { operation: 'format', source: 'value' })).toThrow();
  });

  it('schema rejects add with no amount', () => {
    expect(() => params(dataDateTime, { operation: 'add', source: 'now' })).toThrow();
  });

  it('schema rejects diff with no to_value', () => {
    expect(() => params(dataDateTime, { operation: 'diff', source: 'now' })).toThrow();
  });

  it('schema rejects a non-identifier save_as', () => {
    expect(() =>
      params(dataDateTime, { operation: 'format', source: 'now', save_as: '9bad' }),
    ).toThrow();
  });
});
