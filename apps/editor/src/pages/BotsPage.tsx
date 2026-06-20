import type { AiUsageSummary, BotMode } from '@ctb/shared';
import { type FormEvent, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError, ClientValidationError } from '../api/client';
import { useI18n } from '../i18n';
import { useBots } from '../stores/bots';

export function BotsPage() {
  const t = useI18n((s) => s.t);
  const { bots, loading, error, load, createBot, deleteBot, startBot, stopBot } = useBots();
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState('');
  const [token, setToken] = useState('');
  const [mode, setMode] = useState<BotMode>('polling');
  const [creating, setCreating] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [rowError, setRowError] = useState<string | null>(null);

  useEffect(() => {
    void load();
  }, [load]);

  const onCreate = async (e: FormEvent) => {
    e.preventDefault();
    setCreating(true);
    setFormError(null);
    try {
      await createBot({ name, token, mode, settings: {} });
      setShowForm(false);
      setName('');
      setToken('');
    } catch (err) {
      if (err instanceof ClientValidationError || (err instanceof ApiError && err.status === 400)) {
        setFormError(t('error.validation'));
      } else {
        setFormError(t('error.unknown', { detail: err instanceof Error ? err.message : '?' }));
      }
    } finally {
      setCreating(false);
    }
  };

  const guard = async (fn: () => Promise<void>) => {
    setRowError(null);
    try {
      await fn();
    } catch (err) {
      setRowError(t('error.unknown', { detail: err instanceof Error ? err.message : '?' }));
    }
  };

  const [budgetFor, setBudgetFor] = useState<string | null>(null);
  const [usage, setUsage] = useState<AiUsageSummary | null>(null);
  const [maxCallsPerDay, setMaxCallsPerDay] = useState(0);
  const [maxTokensPerDay, setMaxTokensPerDay] = useState(0);
  const [maxTokensPerRun, setMaxTokensPerRun] = useState(0);

  const openBudget = async (botId: string) => {
    setRowError(null);
    if (budgetFor === botId) {
      setBudgetFor(null);
      return;
    }
    try {
      const u = await api.getBotAiUsage(botId);
      setUsage(u);
      setMaxCallsPerDay(u.budget.maxCallsPerDay);
      setMaxTokensPerDay(u.budget.maxTokensPerDay);
      setMaxTokensPerRun(u.budget.maxTokensPerRun);
      setBudgetFor(botId);
    } catch (err) {
      setRowError(t('error.unknown', { detail: err instanceof Error ? err.message : '?' }));
    }
  };

  const saveBudget = async (botId: string) => {
    await guard(async () => {
      await api.setBotAiBudget(botId, { maxCallsPerDay, maxTokensPerDay, maxTokensPerRun });
      setUsage(await api.getBotAiUsage(botId));
    });
  };

  return (
    <div className="page">
      <div className="page-head">
        <h1>{t('bots.title')}</h1>
        <button className="primary" onClick={() => setShowForm((v) => !v)}>
          {t('bots.add')}
        </button>
      </div>

      {error && <div className="alert">{error}</div>}
      {rowError && <div className="alert">{rowError}</div>}

      {showForm && (
        <form className="card" style={{ marginBottom: '1rem' }} onSubmit={onCreate}>
          {formError && <div className="alert">{formError}</div>}
          <label>
            <span className="label-text">{t('bots.name')}</span>
            <input value={name} onChange={(e) => setName(e.target.value)} required />
          </label>
          <label>
            <span className="label-text">{t('bots.token')}</span>
            <input dir="ltr" value={token} onChange={(e) => setToken(e.target.value)} required />
            <span className="hint">{t('bots.token.hint')}</span>
          </label>
          <label>
            <span className="label-text">{t('bots.mode')}</span>
            <select value={mode} onChange={(e) => setMode(e.target.value as BotMode)}>
              <option value="polling">{t('bots.mode.polling')}</option>
              <option value="webhook">{t('bots.mode.webhook')}</option>
            </select>
          </label>
          <div className="form-actions">
            <button className="primary" type="submit" disabled={creating}>
              {creating ? t('bots.creating') : t('bots.create')}
            </button>
            <button type="button" className="ghost" onClick={() => setShowForm(false)}>
              {t('common.cancel')}
            </button>
          </div>
        </form>
      )}

      {loading ? (
        <div className="splash">{t('app.loading')}</div>
      ) : bots.length === 0 ? (
        <div className="empty">{t('bots.empty')}</div>
      ) : (
        <div className="row-list">
          {bots.map((bot) => (
            <div className="row" key={bot.id}>
              <div className="grow">
                <div className="title">{bot.name}</div>
                <div className="sub">{bot.tokenHint}</div>
              </div>
              <span className={`badge ${bot.status === 'active' ? 'active' : bot.status === 'error' ? 'error' : ''}`}>
                {t(`bots.status.${bot.status}`)}
              </span>
              {bot.status === 'active' ? (
                <button onClick={() => void guard(() => stopBot(bot.id))}>
                  {t('bots.action.stop')}
                </button>
              ) : (
                <button onClick={() => void guard(() => startBot(bot.id))}>
                  {t('bots.action.start')}
                </button>
              )}
              <Link className="btn" to={`/bots/${bot.id}/flows`}>
                {t('bots.action.flows')}
              </Link>
              <Link className="btn ghost" to={`/bots/${bot.id}/users`}>
                {t('bots.action.users')}
              </Link>
              <Link className="btn ghost" to={`/bots/${bot.id}/collections`}>
                {t('bots.action.collections')}
              </Link>
              <button className="btn ghost" onClick={() => void openBudget(bot.id)}>
                {t('bots.action.aiBudget')}
              </button>
              <button
                className="danger ghost"
                onClick={() => {
                  if (confirm(t('bots.delete.confirm', { name: bot.name }))) {
                    void guard(() => deleteBot(bot.id));
                  }
                }}
              >
                {t('bots.action.delete')}
              </button>
              {budgetFor === bot.id && usage && (
                <div className="card" style={{ flexBasis: '100%', marginTop: '0.5rem' }}>
                  <div className="title">{t('bots.aiBudget.title')}</div>
                  <div className="sub">
                    {t('bots.aiBudget.today', { calls: usage.today.calls, tokens: usage.today.totalTokens })}
                    {' · '}
                    {t('bots.aiBudget.allTime', { calls: usage.allTime.calls, tokens: usage.allTime.totalTokens })}
                  </div>
                  <label>
                    <span className="label-text">{t('bots.aiBudget.maxCallsPerDay')}</span>
                    <input dir="ltr" type="number" min={0} value={maxCallsPerDay}
                      onChange={(e) => setMaxCallsPerDay(Number(e.target.value))} />
                  </label>
                  <label>
                    <span className="label-text">{t('bots.aiBudget.maxTokensPerDay')}</span>
                    <input dir="ltr" type="number" min={0} value={maxTokensPerDay}
                      onChange={(e) => setMaxTokensPerDay(Number(e.target.value))} />
                  </label>
                  <label>
                    <span className="label-text">{t('bots.aiBudget.maxTokensPerRun')}</span>
                    <input dir="ltr" type="number" min={0} value={maxTokensPerRun}
                      onChange={(e) => setMaxTokensPerRun(Number(e.target.value))} />
                  </label>
                  <span className="hint">{t('bots.aiBudget.hint')}</span>
                  {usage.byCredential.length > 0 && (
                    <div className="sub" style={{ marginTop: '0.5rem' }}>
                      {usage.byCredential.map((c) => (
                        <div key={c.credentialId} dir="ltr">
                          {c.credentialId.slice(0, 8)}… — {c.calls} / {c.totalTokens}
                        </div>
                      ))}
                    </div>
                  )}
                  <div className="form-actions">
                    <button className="primary" onClick={() => void saveBudget(bot.id)}>
                      {t('bots.aiBudget.save')}
                    </button>
                    <button type="button" className="ghost" onClick={() => setBudgetFor(null)}>
                      {t('common.cancel')}
                    </button>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
