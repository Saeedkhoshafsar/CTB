/**
 * Value comparison shared by flow.if and flow.switch (P2-T6) — extracted from
 * flow.if so the two nodes judge values IDENTICALLY.
 *
 * Semantics (documented, deliberately forgiving — flow authors compare
 * expression results that often arrive as strings):
 *  - equals/notEquals: numeric compare when both sides parse as finite
 *    numbers ("18" equals 18), otherwise strict string compare.
 *  - gt/gte/lt/lte: numeric (non-numeric side → condition is false).
 *  - contains: string inclusion (array inclusion when value1 is an array).
 *  - regex: value2 is the pattern; invalid patterns → false, never throw.
 *  - exists: value1 !== undefined && !== null.
 *  - is_empty: '' | null | undefined | [] | {}.
 */
import type { IfOperator } from '@ctb/shared';

export function compareValues(a: unknown, operator: IfOperator, b: unknown): boolean {
  switch (operator) {
    case 'equals':
      return looseEquals(a, b);
    case 'notEquals':
      return !looseEquals(a, b);
    case 'contains': {
      if (Array.isArray(a)) return a.some((el) => looseEquals(el, b));
      return asString(a).includes(asString(b));
    }
    case 'regex': {
      try {
        return new RegExp(asString(b), 'u').test(asString(a));
      } catch {
        return false;
      }
    }
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      const na = asNumber(a);
      const nb = asNumber(b);
      if (na === undefined || nb === undefined) return false;
      if (operator === 'gt') return na > nb;
      if (operator === 'gte') return na >= nb;
      if (operator === 'lt') return na < nb;
      return na <= nb;
    }
    case 'exists':
      return a !== undefined && a !== null;
    case 'is_empty': {
      if (a === undefined || a === null || a === '') return true;
      if (Array.isArray(a)) return a.length === 0;
      if (typeof a === 'object') return Object.keys(a).length === 0;
      return false;
    }
  }
}

function looseEquals(a: unknown, b: unknown): boolean {
  const na = asNumber(a);
  const nb = asNumber(b);
  if (na !== undefined && nb !== undefined) return na === nb;
  return asString(a) === asString(b);
}

function asNumber(v: unknown): number | undefined {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  }
  if (typeof v === 'boolean') return v ? 1 : 0;
  return undefined;
}

function asString(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v === undefined || v === null) return '';
  if (typeof v === 'object') {
    try {
      return JSON.stringify(v) ?? '';
    } catch {
      return String(v);
    }
  }
  return String(v);
}
