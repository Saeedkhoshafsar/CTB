/**
 * i18n scaffold (P2-T1) — fa/en, fa default, RTL-aware (CLAUDE §7).
 *
 * Deliberately tiny: a flat key→string map per locale and a `t()` lookup with
 * `{name}` interpolation. No runtime dependency; if the catalog outgrows this
 * we swap in a library behind the same `t()` signature.
 */
import { create } from 'zustand';
import { en } from './en';
import { fa } from './fa';

export type Locale = 'fa' | 'en';
export type MessageKey = keyof typeof fa;
/** The translate function signature — reusable by components that take `t` as a prop. */
export type Translate = (key: MessageKey, vars?: Record<string, string | number>) => string;

const catalogs: Record<Locale, Record<MessageKey, string>> = { fa, en };

export const DIR: Record<Locale, 'rtl' | 'ltr'> = { fa: 'rtl', en: 'ltr' };

const STORAGE_KEY = 'ctb.locale';

function initialLocale(): Locale {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === 'fa' || saved === 'en') return saved;
  } catch {
    /* SSR / tests without localStorage */
  }
  return 'fa';
}

interface I18nState {
  locale: Locale;
  dir: 'rtl' | 'ltr';
  setLocale: (locale: Locale) => void;
  t: Translate;
}

export const useI18n = create<I18nState>((set, get) => ({
  locale: initialLocale(),
  dir: DIR[initialLocale()],
  setLocale: (locale) => {
    try {
      localStorage.setItem(STORAGE_KEY, locale);
    } catch {
      /* ignore */
    }
    document.documentElement.lang = locale;
    document.documentElement.dir = DIR[locale];
    set({ locale, dir: DIR[locale] });
  },
  t: (key, vars) => {
    const { locale } = get();
    let msg = catalogs[locale][key] ?? catalogs.fa[key] ?? key;
    if (vars) {
      for (const [name, value] of Object.entries(vars)) {
        msg = msg.replaceAll(`{${name}}`, String(value));
      }
    }
    return msg;
  },
}));

/** Pure lookup for non-React code (toasts, errors). */
export function t(key: MessageKey, vars?: Record<string, string | number>): string {
  return useI18n.getState().t(key, vars);
}
