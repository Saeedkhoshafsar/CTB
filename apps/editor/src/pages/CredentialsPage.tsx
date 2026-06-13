/**
 * Credentials page (P3-T4) — list + create/delete stored secrets used by nodes
 * (HTTP Request auth in v1). The secret is write-only from the UI's point of
 * view: rows show only the masked `hint` the server returns (invariant I7),
 * and there is no "reveal". To rotate a secret, delete + recreate.
 */
import {
  CREDENTIAL_TYPE_LABELS,
  type CredentialData,
  type CredentialType,
} from '@ctb/shared';
import { type FormEvent, useEffect, useState } from 'react';
import { ApiError, ClientValidationError } from '../api/client';
import { useI18n } from '../i18n';
import { useCredentials } from '../stores/credentials';

const TYPES: CredentialType[] = ['httpHeaderAuth', 'httpBearerAuth', 'httpBasicAuth'];

export function CredentialsPage() {
  const t = useI18n((s) => s.t);
  const { credentials, loading, error, load, createCredential, deleteCredential } =
    useCredentials();
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState('');
  const [type, setType] = useState<CredentialType>('httpHeaderAuth');
  // Per-type secret fields — only the ones for the active type are submitted.
  const [headerName, setHeaderName] = useState('X-API-Key');
  const [headerValue, setHeaderValue] = useState('');
  const [token, setToken] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [creating, setCreating] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [rowError, setRowError] = useState<string | null>(null);

  useEffect(() => {
    void load();
  }, [load]);

  const reset = () => {
    setName('');
    setHeaderName('X-API-Key');
    setHeaderValue('');
    setToken('');
    setUsername('');
    setPassword('');
  };

  const buildData = (): CredentialData => {
    switch (type) {
      case 'httpHeaderAuth':
        return { type, headerName, headerValue };
      case 'httpBearerAuth':
        return { type, token };
      case 'httpBasicAuth':
        return { type, username, password };
    }
  };

  const onCreate = async (e: FormEvent) => {
    e.preventDefault();
    setCreating(true);
    setFormError(null);
    try {
      await createCredential({ name, data: buildData() });
      setShowForm(false);
      reset();
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

  return (
    <div className="page">
      <div className="page-head">
        <h1>{t('credentials.title')}</h1>
        <button className="primary" onClick={() => setShowForm((v) => !v)}>
          {t('credentials.add')}
        </button>
      </div>

      {error && <div className="alert">{error}</div>}
      {rowError && <div className="alert">{rowError}</div>}

      {showForm && (
        <form className="card" style={{ marginBottom: '1rem' }} onSubmit={onCreate}>
          {formError && <div className="alert">{formError}</div>}
          <label>
            <span className="label-text">{t('credentials.name')}</span>
            <input value={name} onChange={(e) => setName(e.target.value)} required />
          </label>
          <label>
            <span className="label-text">{t('credentials.type')}</span>
            <select value={type} onChange={(e) => setType(e.target.value as CredentialType)}>
              {TYPES.map((ty) => (
                <option key={ty} value={ty}>
                  {t(`credentials.type.${ty}`)}
                </option>
              ))}
            </select>
          </label>

          {type === 'httpHeaderAuth' && (
            <>
              <label>
                <span className="label-text">{t('credentials.field.headerName')}</span>
                <input
                  dir="ltr"
                  value={headerName}
                  onChange={(e) => setHeaderName(e.target.value)}
                  required
                />
              </label>
              <label>
                <span className="label-text">{t('credentials.field.headerValue')}</span>
                <input
                  dir="ltr"
                  type="password"
                  value={headerValue}
                  onChange={(e) => setHeaderValue(e.target.value)}
                  required
                />
              </label>
            </>
          )}

          {type === 'httpBearerAuth' && (
            <label>
              <span className="label-text">{t('credentials.field.token')}</span>
              <input
                dir="ltr"
                type="password"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                required
              />
            </label>
          )}

          {type === 'httpBasicAuth' && (
            <>
              <label>
                <span className="label-text">{t('credentials.field.username')}</span>
                <input
                  dir="ltr"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  required
                />
              </label>
              <label>
                <span className="label-text">{t('credentials.field.password')}</span>
                <input
                  dir="ltr"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                />
              </label>
            </>
          )}

          <span className="hint">{t('credentials.secret.hint')}</span>
          <div className="form-actions">
            <button className="primary" type="submit" disabled={creating}>
              {creating ? t('credentials.creating') : t('credentials.create')}
            </button>
            <button type="button" className="ghost" onClick={() => setShowForm(false)}>
              {t('common.cancel')}
            </button>
          </div>
        </form>
      )}

      {loading ? (
        <div className="splash">{t('app.loading')}</div>
      ) : credentials.length === 0 ? (
        <div className="empty">{t('credentials.empty')}</div>
      ) : (
        <div className="row-list">
          {credentials.map((cred) => (
            <div className="row" key={cred.id}>
              <div className="grow">
                <div className="title">{cred.name}</div>
                <div className="sub" dir="ltr">
                  {cred.hint}
                </div>
              </div>
              <span className="badge">{CREDENTIAL_TYPE_LABELS[cred.type]}</span>
              <button
                className="danger ghost"
                onClick={() => {
                  if (confirm(t('credentials.delete.confirm', { name: cred.name }))) {
                    void guard(() => deleteCredential(cred.id));
                  }
                }}
              >
                {t('credentials.action.delete')}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
