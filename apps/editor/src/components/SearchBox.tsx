import { useId } from 'react';
import { useI18n } from '../i18n';

export interface SearchBoxProps {
  value: string;
  onValueChange: (value: string) => void;
  /** Localized placeholder; falls back to a generic "Search…". */
  placeholder?: string;
}

/**
 * Client-side list filter input with a clear button (PLAN5 P3-T6 / issue C7).
 * RTL-safe (the clear button uses logical positioning). Purely controlled — the
 * page owns the query string and does the filtering.
 */
export function SearchBox({ value, onValueChange, placeholder }: SearchBoxProps) {
  const t = useI18n((s) => s.t);
  const id = useId();
  const ph = placeholder ?? t('common.search');

  return (
    <div className="search-box">
      <span className="search-icon" aria-hidden="true">
        🔍
      </span>
      <input
        id={id}
        type="search"
        value={value}
        placeholder={ph}
        aria-label={ph}
        onChange={(e) => onValueChange(e.target.value)}
      />
      {value && (
        <button
          type="button"
          className="search-clear"
          aria-label={t('common.clear')}
          title={t('common.clear')}
          onClick={() => onValueChange('')}
        >
          ✕
        </button>
      )}
    </div>
  );
}
