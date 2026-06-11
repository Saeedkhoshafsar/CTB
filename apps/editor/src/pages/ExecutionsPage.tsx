import { useI18n } from '../i18n';

/** Executions route — the inspector lands in P2-T5. */
export function ExecutionsPage() {
  const t = useI18n((s) => s.t);
  return (
    <div className="page">
      <h1>{t('executions.title')}</h1>
      <div className="empty" style={{ padding: '6rem 1rem' }}>
        {t('executions.placeholder')}
      </div>
    </div>
  );
}
