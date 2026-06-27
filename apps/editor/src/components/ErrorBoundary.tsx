/**
 * ErrorBoundary — the cure for the "the whole screen goes black" bug.
 *
 * React unmounts the ENTIRE component tree when a render throws and nothing
 * catches it — that is exactly what produced the blank/black page when opening a
 * node's detail view. A class error boundary is the only React mechanism that
 * can stop that blast radius: it catches a render error in its subtree, shows a
 * friendly recovery card instead, and lets the user retry WITHOUT losing the
 * rest of the app (the document lives in the canvas store, untouched).
 *
 * We wrap two scopes:
 *   - the whole app (a last-resort net), and
 *   - the node-detail modal specifically (so a bad run-data payload only takes
 *     down the modal, not the canvas behind it).
 */
import { Component, type ErrorInfo, type ReactNode } from 'react';
import { useI18n, type Translate } from '../i18n';

interface Props {
  children: ReactNode;
  /** Optional reset hook — e.g. close the modal that crashed. */
  onReset?: (() => void) | undefined;
  /** Render compactly (inside a modal) rather than full-page. */
  compact?: boolean | undefined;
}

interface State {
  error: Error | null;
}

class ErrorBoundaryInner extends Component<Props & { t: Translate }, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // Surface it for debugging; never rethrow (that would re-blank the screen).
    // eslint-disable-next-line no-console
    console.error('[CTB] render error caught by ErrorBoundary:', error, info);
  }

  private reset = (): void => {
    this.setState({ error: null });
    this.props.onReset?.();
  };

  override render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    const { t, compact } = this.props;
    return (
      <div className={compact ? 'error-card error-card-compact' : 'error-card'} role="alert">
        <div className="error-card-icon" aria-hidden="true">
          ⚠️
        </div>
        <h2 className="error-card-title">{t('errorBoundary.title')}</h2>
        <p className="error-card-lead">{t('errorBoundary.lead')}</p>
        <div className="error-card-actions">
          <button type="button" className="primary" onClick={this.reset}>
            {t('errorBoundary.retry')}
          </button>
          <button type="button" className="ghost" onClick={() => window.location.reload()}>
            {t('errorBoundary.reload')}
          </button>
        </div>
        <details className="error-card-details">
          <summary>{t('errorBoundary.details')}</summary>
          <pre dir="ltr">{error.message}</pre>
        </details>
      </div>
    );
  }
}

/** Function wrapper so the boundary can use the i18n hook. */
export function ErrorBoundary({ children, onReset, compact }: Props) {
  const t = useI18n((s) => s.t);
  // `key` forces a fresh boundary instance whenever the locale changes so the
  // recovery card re-renders in the new language; harmless when no error.
  return (
    <ErrorBoundaryInner t={t} onReset={onReset} compact={compact}>
      {children}
    </ErrorBoundaryInner>
  );
}
