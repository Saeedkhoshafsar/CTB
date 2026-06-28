import { type InputHTMLAttributes, useId, useState } from 'react';
import { useI18n } from '../i18n';

type BaseProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'type'>;

export interface PasswordInputProps extends BaseProps {
  /** Current value (controlled). */
  value: string;
  /** Change handler receiving the raw string value. */
  onValueChange: (value: string) => void;
}

/**
 * Masked text input with a show/hide toggle. RTL-safe: the toggle is positioned
 * with logical inset (`inset-inline-end`) via the `.password-field` class.
 * Defaults to `autoComplete="off"` and `spellCheck={false}` for secret values.
 */
export function PasswordInput({ value, onValueChange, ...rest }: PasswordInputProps) {
  const t = useI18n((s) => s.t);
  const [revealed, setRevealed] = useState(false);
  const inputId = useId();

  return (
    <div className="password-field">
      <input
        id={inputId}
        type={revealed ? 'text' : 'password'}
        value={value}
        onChange={(e) => onValueChange(e.target.value)}
        autoComplete="off"
        spellCheck={false}
        {...rest}
      />
      <button
        type="button"
        className="password-toggle"
        aria-pressed={revealed}
        aria-label={revealed ? t('common.hide') : t('common.show')}
        title={revealed ? t('common.hide') : t('common.show')}
        onClick={() => setRevealed((v) => !v)}
      >
        {revealed ? '🙈' : '👁'}
      </button>
    </div>
  );
}
