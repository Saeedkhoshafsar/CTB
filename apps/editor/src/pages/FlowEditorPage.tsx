import type { FlowPublic } from '@ctb/shared';
import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api/client';
import { useI18n } from '../i18n';

/** Flow editor route — the React Flow canvas replaces the placeholder in P2-T2. */
export function FlowEditorPage() {
  const t = useI18n((s) => s.t);
  const { flowId = '' } = useParams<{ flowId: string }>();
  const [flow, setFlow] = useState<FlowPublic | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .getFlow(flowId)
      .then(setFlow)
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, [flowId]);

  if (error) return <div className="page"><div className="alert">{error}</div></div>;
  if (!flow) return <div className="splash">{t('app.loading')}</div>;

  return (
    <div className="page">
      <div className="page-head">
        <Link className="btn ghost" to={`/bots/${flow.botId}/flows`}>
          {t('common.back')}
        </Link>
        <h1>{t('editor.title', { name: flow.name })}</h1>
      </div>
      <div className="empty" style={{ padding: '6rem 1rem' }}>
        {t('editor.canvas.placeholder')}
        <div className="sub" style={{ marginTop: '0.5rem' }}>
          nodes: {flow.graph.nodes.length} · edges: {flow.graph.edges.length} ·{' '}
          {t('flows.version', { n: flow.version })}
        </div>
      </div>
    </div>
  );
}
