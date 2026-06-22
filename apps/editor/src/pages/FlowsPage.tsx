import type { BotPublic, FlowTemplateInfo } from '@ctb/shared';
import { type FormEvent, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ApiError, api } from '../api/client';
import { FlowsEmptyState } from '../components/EmptyState';
import { type MessageKey, useI18n } from '../i18n';
import type { EmptyStateActionId } from '../lib/empty-state';
import { downloadFlowExport } from '../lib/flow-export';
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

  // P3-T7 — import + template gallery
  const [showImport, setShowImport] = useState(false);
  const [importText, setImportText] = useState('');
  const [importing, setImporting] = useState(false);
  const [showTemplates, setShowTemplates] = useState(false);
  const [templates, setTemplates] = useState<FlowTemplateInfo[]>([]);
  const [usingTemplate, setUsingTemplate] = useState<string | null>(null);

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

  // Export: fetch the envelope and trigger a browser download (no identity).
  const onExport = (flowId: string, flowName: string) =>
    guard(async () => {
      try {
        const envelope = await api.exportFlow(flowId);
        downloadFlowExport(envelope, flowName);
      } catch (err) {
        setPageError(t('flows.export.failed', { detail: err instanceof Error ? err.message : '?' }));
      }
    });

  const onImport = async () => {
    setImporting(true);
    setPageError(null);
    try {
      let parsed: unknown;
      try {
        parsed = JSON.parse(importText);
      } catch {
        setPageError(t('flows.import.invalid'));
        return;
      }
      const flow = await api.importFlow({ botId, export: parsed });
      // refresh list (importFlow doesn't go through the store)
      await load(botId);
      setShowImport(false);
      setImportText('');
      void flow;
    } catch (err) {
      if (err instanceof ApiError && err.body.error === 'invalid_export') {
        setPageError(t('flows.import.invalid'));
      } else {
        setPageError(t('error.unknown', { detail: err instanceof Error ? err.message : '?' }));
      }
    } finally {
      setImporting(false);
    }
  };

  const onPickFile = (e: FormEvent<HTMLInputElement>) => {
    const file = e.currentTarget.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => setImportText(String(reader.result ?? ''));
    reader.readAsText(file);
  };

  const openTemplates = () =>
    guard(async () => {
      if (templates.length === 0) setTemplates(await api.listFlowTemplates());
      setShowTemplates((v) => !v);
    });

  const onUseTemplate = (templateId: string) =>
    guard(async () => {
      setUsingTemplate(templateId);
      try {
        await api.importTemplate({ botId, templateId });
        await load(botId);
        setShowTemplates(false);
      } finally {
        setUsingTemplate(null);
      }
    });

  // F-T1 — the guided empty state's three CTAs each just OPEN an affordance the
  // page already owns (the template gallery / import panel / new-flow form), so
  // there's no second flow-creation path to keep in sync.
  const onEmptyAction = (id: EmptyStateActionId) => {
    if (id === 'template') {
      void openTemplates();
    } else if (id === 'import') {
      setShowImport(true);
    } else {
      setShowForm(true);
    }
  };

  return (
    <div className="page">
      <div className="page-head">
        <Link className="btn ghost" to="/bots">
          {t('common.back')}
        </Link>
        <h1>{t('flows.title', { bot: bot?.name ?? '…' })}</h1>
        <button className="ghost" onClick={() => void openTemplates()}>
          {t('flows.templates')}
        </button>
        <button className="ghost" onClick={() => setShowImport((v) => !v)}>
          {t('flows.import')}
        </button>
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

      {showImport && (
        <div className="card" style={{ marginBottom: '1rem' }}>
          <h2 style={{ marginTop: 0 }}>{t('flows.import.title')}</h2>
          <p className="sub">{t('flows.import.hint')}</p>
          <label>
            <span className="label-text">{t('flows.import.file')}</span>
            <input type="file" accept="application/json,.json" onChange={onPickFile} />
          </label>
          <label>
            <span className="label-text">{t('flows.import.paste')}</span>
            <textarea
              rows={6}
              value={importText}
              onChange={(e) => setImportText(e.target.value)}
              style={{ width: '100%', fontFamily: 'monospace' }}
            />
          </label>
          <div className="form-actions">
            <button
              className="primary"
              disabled={importing || importText.trim() === ''}
              onClick={() => void onImport()}
            >
              {importing ? t('flows.import.importing') : t('flows.import.submit')}
            </button>
            <button type="button" className="ghost" onClick={() => setShowImport(false)}>
              {t('common.cancel')}
            </button>
          </div>
        </div>
      )}

      {showTemplates && (
        <div className="card" style={{ marginBottom: '1rem' }}>
          <h2 style={{ marginTop: 0 }}>{t('flows.templates.title')}</h2>
          <p className="sub">{t('flows.templates.hint')}</p>
          <div className="row-list">
            {templates.map((tpl) => (
              <div className="row" key={tpl.id}>
                <div className="grow">
                  <div className="title">{t(tpl.labelKey as MessageKey)}</div>
                  <div className="sub">{t(tpl.descriptionKey as MessageKey)}</div>
                  <div className="sub">{t('flows.templates.nodeCount', { n: tpl.nodeCount })}</div>
                </div>
                <button
                  className="primary"
                  disabled={usingTemplate !== null}
                  onClick={() => void onUseTemplate(tpl.id)}
                >
                  {usingTemplate === tpl.id ? t('flows.templates.using') : t('flows.templates.use')}
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {loading ? (
        <div className="splash">{t('app.loading')}</div>
      ) : flows.length === 0 ? (
        <FlowsEmptyState onAction={onEmptyAction} />
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
              <button className="ghost" onClick={() => void onExport(flow.id, flow.name)}>
                {t('flows.action.export')}
              </button>
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
