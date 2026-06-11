import type { BotPublic } from '@ctb/shared';
import { type FormEvent, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ApiError, api } from '../api/client';
import { useI18n } from '../i18n';
import { useFlows } from '../stores/flows';

export function FlowsPage() {
  const t = useI18n((s) => s.t);
  const { botId = '' } = useParams<{ botId: string }>();
  const { flows, loading, error, load, createFlow, deleteFlow, activateFlow, deactivateFlow } =
    useFlows();
  const [bot, setBot] = useState<BotPublic | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState('');
  const [creating, setCreating] = useState(false);
  const [pageError, setPageError] = useState<string | null>(null);

  useEffect(() => {
    void load(botId);
    api
      .getBot(botId)
      .then(setBot)
      .catch(() => setBot(null));
  }, [botId, load]);

  const onCreate = async (e: FormEvent) => {
    e.preventDefault();
    setCreating(true);
    setPageError(null);
    try {
      await createFlow({ botId, name, graph: { nodes: [], edges: [] } });
      setShowForm(false);
      setName('');
    } catch (err) {
      setPageError(t('error.unknown', { detail: err instanceof Error ? err.message : '?' }));
    } finally {
      setCreating(false);
    }
  };

  const guard = async (fn: () => Promise<void>) => {
    setPageError(null);
    try {
      await fn();
    } catch (err) {
      if (err instanceof ApiError && err.body.problems) {
        setPageError(err.body.problems.join(' · '));
      } else {
        setPageError(t('error.unknown', { detail: err instanceof Error ? err.message : '?' }));
      }
    }
  };

  return (
    <div className="page">
      <div className="page-head">
        <Link className="btn ghost" to="/bots">
          {t('common.back')}
        </Link>
        <h1>{t('flows.title', { bot: bot?.name ?? '…' })}</h1>
        <button className="primary" onClick={() => setShowForm((v) => !v)}>
          {t('flows.add')}
        </button>
      </div>

      {error && <div className="alert">{error}</div>}
      {pageError && <div className="alert">{pageError}</div>}

      {showForm && (
        <form className="card" style={{ marginBottom: '1rem' }} onSubmit={onCreate}>
          <label>
            <span className="label-text">{t('flows.name')}</span>
            <input value={name} onChange={(e) => setName(e.target.value)} required />
          </label>
          <div className="form-actions">
            <button className="primary" type="submit" disabled={creating}>
              {creating ? t('flows.creating') : t('flows.create')}
            </button>
            <button type="button" className="ghost" onClick={() => setShowForm(false)}>
              {t('common.cancel')}
            </button>
          </div>
        </form>
      )}

      {loading ? (
        <div className="splash">{t('app.loading')}</div>
      ) : flows.length === 0 ? (
        <div className="empty">{t('flows.empty')}</div>
      ) : (
        <div className="row-list">
          {flows.map((flow) => (
            <div className="row" key={flow.id}>
              <div className="grow">
                <div className="title">{flow.name}</div>
                <div className="sub">{t('flows.version', { n: flow.version })}</div>
              </div>
              <span className={`badge ${flow.status === 'active' ? 'active' : 'draft'}`}>
                {t(`flows.status.${flow.status}`)}
              </span>
              {flow.status === 'active' ? (
                <button onClick={() => void guard(() => deactivateFlow(flow.id))}>
                  {t('flows.action.deactivate')}
                </button>
              ) : (
                <button onClick={() => void guard(() => activateFlow(flow.id))}>
                  {t('flows.action.activate')}
                </button>
              )}
              <Link className="btn" to={`/flows/${flow.id}`}>
                {t('flows.action.edit')}
              </Link>
              <button
                className="danger ghost"
                onClick={() => {
                  if (confirm(t('flows.delete.confirm', { name: flow.name }))) {
                    void guard(() => deleteFlow(flow.id));
                  }
                }}
              >
                {t('flows.action.delete')}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
