import type { AiUsageSummary, BotMode } from '@ctb/shared';
import { type FormEvent, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError, ClientValidationError } from '../api/client';
import { ActionMenu } from '../components/ActionMenu';
import { PasswordInput } from '../components/PasswordInput';
import { SearchBox } from '../components/SearchBox';
import { SetupChecklist } from '../components/SetupChecklist';
import { SkeletonList } from '../components/Skeleton';
import { confirmDialog } from '../stores/confirm';
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

  const [query, setQuery] = useState('');
  const visibleBots = bots.filter((b) =>
    b.name.toLowerCase().includes(query.trim().toLowerCase()),
  );

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

      {/* First-run go-live checklist (L-T2) — self-hides when ready/dismissed/operator. */}
      <SetupChecklist />

      {error && <div className="alert">{error}</div>}
      {rowError && <div className="alert">{rowError}</div>}

      {showForm && (
        <form className="card u-mb-1" onSubmit={onCreate}>
          {formError && <div className="alert">{formError}</div>}
          <label>
            <span className="label-text">{t('bots.name')}</span>
            <input value={name} onChange={(e) => setName(e.target.value)} required />
          </label>
          <label>
            <span className="label-text">{t('bots.token')}</span>
            <PasswordInput dir="ltr" value={token} onValueChange={setToken} required />
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
        <SkeletonList rows={4} label={t('app.loading')} />
      ) : bots.length === 0 ? (
        <div className="empty">{t('bots.empty')}</div>
      ) : (
        <>
          {bots.length > 5 && <SearchBox value={query} onValueChange={setQuery} />}
          {visibleBots.length === 0 ? (
            <div className="empty">{t('common.noResults')}</div>
          ) : (
            <div className="row-list">
              {visibleBots.map((bot) => (
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
              <ActionMenu
                items={[
                  { key: 'users', to: `/bots/${bot.id}/users`, icon: '👥', label: t('bots.action.users') },
                  {
                    key: 'collections',
                    to: `/bots/${bot.id}/collections`,
                    icon: '🗂',
                    label: t('bots.action.collections'),
                  },
                  {
                    key: 'aiBudget',
                    onClick: () => void openBudget(bot.id),
                    icon: '💰',
                    label: t('bots.action.aiBudget'),
                  },
                  {
                    key: 'delete',
                    danger: true,
                    icon: '🗑',
                    label: t('bots.action.delete'),
                    onClick: () => {
                      void (async () => {
                        if (
                          await confirmDialog({
                            message: t('bots.delete.confirm', { name: bot.name }),
                            danger: true,
                          })
                        ) {
                          await guard(() => deleteBot(bot.id));
                        }
                      })();
                    },
                  },
                ]}
              />
              {budgetFor === bot.id && usage && (
                <div className="card u-full u-mt-half">
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
                    <div className="sub u-mt-half">
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
        </>
      )}
    </div>
  );
}
