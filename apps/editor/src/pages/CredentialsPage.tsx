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
import { SkeletonList } from '../components/Skeleton';
import { confirmDialog } from '../stores/confirm';
import { useI18n } from '../i18n';
import { useCredentials } from '../stores/credentials';

const TYPES: CredentialType[] = [
  'httpHeaderAuth',
  'httpBearerAuth',
  'httpBasicAuth',
  'openAiApi',
  'mcpServer',
  'postgres',
  'mysql',
  'voiceConnection',
];

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
  const [baseUrl, setBaseUrl] = useState('https://api.openai.com/v1');
  const [apiKey, setApiKey] = useState('');
  const [mcpUrl, setMcpUrl] = useState('https://mcp.example.com/mcp');
  const [mcpApiKey, setMcpApiKey] = useState('');
  // Postgres: either a single connectionString OR discrete host/port/db/user/pass.
  const [pgHost, setPgHost] = useState('localhost');
  const [pgPort, setPgPort] = useState('5432');
  const [pgDatabase, setPgDatabase] = useState('');
  const [pgUser, setPgUser] = useState('postgres');
  const [pgPassword, setPgPassword] = useState('');
  const [pgSsl, setPgSsl] = useState(false);
  // PD-T1 hardening (string-bound so the number inputs stay controlled).
  const [pgPoolMax, setPgPoolMax] = useState('5');
  const [pgStmtTimeout, setPgStmtTimeout] = useState('30000');
  const [pgReadOnly, setPgReadOnly] = useState(false);
  // MySQL / MariaDB: either a single connectionString OR discrete fields (PB-T3).
  const [myHost, setMyHost] = useState('localhost');
  const [myPort, setMyPort] = useState('3306');
  const [myDatabase, setMyDatabase] = useState('');
  const [myUser, setMyUser] = useState('root');
  const [myPassword, setMyPassword] = useState('');
  const [mySsl, setMySsl] = useState(false);
  const [myPoolMax, setMyPoolMax] = useState('5');
  const [myStmtTimeout, setMyStmtTimeout] = useState('30000');
  const [myReadOnly, setMyReadOnly] = useState(false);
  // Voice connection (Phase E / PE-T1) — userbot first; companion/external forward-shaped.
  const [vcKind, setVcKind] = useState<'userbot' | 'companion' | 'external'>('userbot');
  const [vcApiId, setVcApiId] = useState('');
  const [vcApiHash, setVcApiHash] = useState('');
  const [vcSession, setVcSession] = useState('');
  const [vcBridgeUrl, setVcBridgeUrl] = useState('');
  const [vcBridgeToken, setVcBridgeToken] = useState('');
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
    setBaseUrl('https://api.openai.com/v1');
    setApiKey('');
    setMcpUrl('https://mcp.example.com/mcp');
    setMcpApiKey('');
    setPgHost('localhost');
    setPgPort('5432');
    setPgDatabase('');
    setPgUser('postgres');
    setPgPassword('');
    setPgSsl(false);
    setPgPoolMax('5');
    setPgStmtTimeout('30000');
    setPgReadOnly(false);
    setMyHost('localhost');
    setMyPort('3306');
    setMyDatabase('');
    setMyUser('root');
    setMyPassword('');
    setMySsl(false);
    setMyPoolMax('5');
    setMyStmtTimeout('30000');
    setMyReadOnly(false);
    setVcKind('userbot');
    setVcApiId('');
    setVcApiHash('');
    setVcSession('');
    setVcBridgeUrl('');
    setVcBridgeToken('');
  };

  const buildData = (): CredentialData => {
    switch (type) {
      case 'httpHeaderAuth':
        return { type, headerName, headerValue };
      case 'httpBearerAuth':
        return { type, token };
      case 'httpBasicAuth':
        return { type, username, password };
      case 'openAiApi':
        return { type, baseUrl, apiKey };
      case 'mcpServer':
        // apiKey is optional — omit when blank so the credential carries no key.
        return mcpApiKey.trim() === ''
          ? { type, url: mcpUrl }
          : { type, url: mcpUrl, apiKey: mcpApiKey };
      case 'postgres': {
        // Discrete host/port/db/user/pass form. Blank fields are omitted so the
        // server applies pg's own defaults; ssl is an explicit toggle. The PD-T1
        // hardening fields (pool size / statement timeout / read-only) are always
        // sent (the Zod schema would default them anyway).
        const data: CredentialData = {
          type, ssl: pgSsl,
          poolMax: Number(pgPoolMax) || 5,
          statementTimeoutMs: Number(pgStmtTimeout) || 0,
          readOnly: pgReadOnly,
        };
        if (pgHost.trim() !== '') data.host = pgHost.trim();
        if (pgPort.trim() !== '') data.port = Number(pgPort);
        if (pgDatabase.trim() !== '') data.database = pgDatabase.trim();
        if (pgUser.trim() !== '') data.user = pgUser.trim();
        if (pgPassword !== '') data.password = pgPassword;
        return data;
      }
      case 'mysql': {
        // Mirror of the postgres form (PB-T3). Blank fields omitted so the
        // server applies mysql2's own defaults; ssl is an explicit toggle.
        const data: CredentialData = {
          type, ssl: mySsl,
          poolMax: Number(myPoolMax) || 5,
          statementTimeoutMs: Number(myStmtTimeout) || 0,
          readOnly: myReadOnly,
        };
        if (myHost.trim() !== '') data.host = myHost.trim();
        if (myPort.trim() !== '') data.port = Number(myPort);
        if (myDatabase.trim() !== '') data.database = myDatabase.trim();
        if (myUser.trim() !== '') data.user = myUser.trim();
        if (myPassword !== '') data.password = myPassword;
        return data;
      }
      case 'voiceConnection': {
        // The `kind` selects the connector (PE-T1). For userbot/companion the
        // operator supplies api_id/api_hash + an MTProto session string; for
        // external they supply a bridge URL/token. Blank fields are omitted so
        // the server can reject an incomplete connector (fail-closed, PE-T2).
        const data: CredentialData = { type, kind: vcKind };
        if (vcApiId.trim() !== '') data.apiId = Number(vcApiId);
        if (vcApiHash.trim() !== '') data.apiHash = vcApiHash.trim();
        if (vcSession.trim() !== '') data.session = vcSession.trim();
        if (vcBridgeUrl.trim() !== '') data.bridgeUrl = vcBridgeUrl.trim();
        if (vcBridgeToken.trim() !== '') data.bridgeToken = vcBridgeToken.trim();
        return data;
      }
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
        <form className="card u-mb-1" onSubmit={onCreate}>
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

          {type === 'openAiApi' && (
            <>
              <label>
                <span className="label-text">{t('credentials.field.baseUrl')}</span>
                <input
                  dir="ltr"
                  value={baseUrl}
                  onChange={(e) => setBaseUrl(e.target.value)}
                  placeholder="https://api.openai.com/v1"
                  required
                />
              </label>
              <label>
                <span className="label-text">{t('credentials.field.apiKey')}</span>
                <input
                  dir="ltr"
                  type="password"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  required
                />
              </label>
            </>
          )}

          {type === 'mcpServer' && (
            <>
              <label>
                <span className="label-text">{t('credentials.field.mcpUrl')}</span>
                <input
                  dir="ltr"
                  value={mcpUrl}
                  onChange={(e) => setMcpUrl(e.target.value)}
                  placeholder="https://mcp.example.com/mcp"
                  required
                />
              </label>
              <label>
                <span className="label-text">{t('credentials.field.mcpApiKey')}</span>
                <input
                  dir="ltr"
                  type="password"
                  value={mcpApiKey}
                  onChange={(e) => setMcpApiKey(e.target.value)}
                />
              </label>
            </>
          )}

          {type === 'postgres' && (
            <>
              <label>
                <span className="label-text">{t('credentials.field.pgHost')}</span>
                <input
                  dir="ltr"
                  value={pgHost}
                  onChange={(e) => setPgHost(e.target.value)}
                  placeholder="localhost"
                  required
                />
              </label>
              <label>
                <span className="label-text">{t('credentials.field.pgPort')}</span>
                <input
                  dir="ltr"
                  type="number"
                  value={pgPort}
                  onChange={(e) => setPgPort(e.target.value)}
                  placeholder="5432"
                  required
                />
              </label>
              <label>
                <span className="label-text">{t('credentials.field.pgDatabase')}</span>
                <input
                  dir="ltr"
                  value={pgDatabase}
                  onChange={(e) => setPgDatabase(e.target.value)}
                  required
                />
              </label>
              <label>
                <span className="label-text">{t('credentials.field.pgUser')}</span>
                <input
                  dir="ltr"
                  value={pgUser}
                  onChange={(e) => setPgUser(e.target.value)}
                  required
                />
              </label>
              <label>
                <span className="label-text">{t('credentials.field.pgPassword')}</span>
                <input
                  dir="ltr"
                  type="password"
                  value={pgPassword}
                  onChange={(e) => setPgPassword(e.target.value)}
                />
              </label>
              <label className="u-row">
                <input
                  type="checkbox"
                  checked={pgSsl}
                  onChange={(e) => setPgSsl(e.target.checked)}
                />
                <span className="label-text">{t('credentials.field.pgSsl')}</span>
              </label>
              <label>
                <span className="label-text">{t('credentials.field.poolMax')}</span>
                <input
                  dir="ltr" type="number" min={1} max={100}
                  value={pgPoolMax} onChange={(e) => setPgPoolMax(e.target.value)}
                  placeholder="5"
                />
              </label>
              <label>
                <span className="label-text">{t('credentials.field.statementTimeoutMs')}</span>
                <input
                  dir="ltr" type="number" min={0} max={600000}
                  value={pgStmtTimeout} onChange={(e) => setPgStmtTimeout(e.target.value)}
                  placeholder="30000"
                />
              </label>
              <label className="u-row">
                <input
                  type="checkbox"
                  checked={pgReadOnly}
                  onChange={(e) => setPgReadOnly(e.target.checked)}
                />
                <span className="label-text">{t('credentials.field.readOnly')}</span>
              </label>
            </>
          )}

          {type === 'mysql' && (
            <>
              <label>
                <span className="label-text">{t('credentials.field.myHost')}</span>
                <input
                  dir="ltr"
                  value={myHost}
                  onChange={(e) => setMyHost(e.target.value)}
                  placeholder="localhost"
                  required
                />
              </label>
              <label>
                <span className="label-text">{t('credentials.field.myPort')}</span>
                <input
                  dir="ltr"
                  type="number"
                  value={myPort}
                  onChange={(e) => setMyPort(e.target.value)}
                  placeholder="3306"
                  required
                />
              </label>
              <label>
                <span className="label-text">{t('credentials.field.myDatabase')}</span>
                <input
                  dir="ltr"
                  value={myDatabase}
                  onChange={(e) => setMyDatabase(e.target.value)}
                  required
                />
              </label>
              <label>
                <span className="label-text">{t('credentials.field.myUser')}</span>
                <input
                  dir="ltr"
                  value={myUser}
                  onChange={(e) => setMyUser(e.target.value)}
                  required
                />
              </label>
              <label>
                <span className="label-text">{t('credentials.field.myPassword')}</span>
                <input
                  dir="ltr"
                  type="password"
                  value={myPassword}
                  onChange={(e) => setMyPassword(e.target.value)}
                />
              </label>
              <label className="u-row">
                <input
                  type="checkbox"
                  checked={mySsl}
                  onChange={(e) => setMySsl(e.target.checked)}
                />
                <span className="label-text">{t('credentials.field.mySsl')}</span>
              </label>
              <label>
                <span className="label-text">{t('credentials.field.poolMax')}</span>
                <input
                  dir="ltr" type="number" min={1} max={100}
                  value={myPoolMax} onChange={(e) => setMyPoolMax(e.target.value)}
                  placeholder="5"
                />
              </label>
              <label>
                <span className="label-text">{t('credentials.field.statementTimeoutMs')}</span>
                <input
                  dir="ltr" type="number" min={0} max={600000}
                  value={myStmtTimeout} onChange={(e) => setMyStmtTimeout(e.target.value)}
                  placeholder="30000"
                />
              </label>
              <label className="u-row">
                <input
                  type="checkbox"
                  checked={myReadOnly}
                  onChange={(e) => setMyReadOnly(e.target.checked)}
                />
                <span className="label-text">{t('credentials.field.readOnly')}</span>
              </label>
            </>
          )}

          {type === 'voiceConnection' && (
            <>
              <label>
                <span className="label-text">{t('credentials.field.vcKind')}</span>
                <select
                  value={vcKind}
                  onChange={(e) =>
                    setVcKind(e.target.value as 'userbot' | 'companion' | 'external')
                  }
                >
                  <option value="userbot">{t('credentials.vcKind.userbot')}</option>
                  <option value="companion">{t('credentials.vcKind.companion')}</option>
                  <option value="external">{t('credentials.vcKind.external')}</option>
                </select>
              </label>

              {(vcKind === 'userbot' || vcKind === 'companion') && (
                <>
                  <label>
                    <span className="label-text">{t('credentials.field.vcApiId')}</span>
                    <input
                      dir="ltr"
                      type="number"
                      value={vcApiId}
                      onChange={(e) => setVcApiId(e.target.value)}
                      placeholder="1234567"
                      required
                    />
                  </label>
                  <label>
                    <span className="label-text">{t('credentials.field.vcApiHash')}</span>
                    <input
                      dir="ltr"
                      type="password"
                      value={vcApiHash}
                      onChange={(e) => setVcApiHash(e.target.value)}
                      required
                    />
                  </label>
                  <label>
                    <span className="label-text">{t('credentials.field.vcSession')}</span>
                    <textarea
                      dir="ltr"
                      rows={3}
                      value={vcSession}
                      onChange={(e) => setVcSession(e.target.value)}
                      placeholder="1BVtsO... (MTProto session string)"
                      required
                    />
                  </label>
                </>
              )}

              {vcKind === 'external' && (
                <>
                  <label>
                    <span className="label-text">{t('credentials.field.vcBridgeUrl')}</span>
                    <input
                      dir="ltr"
                      value={vcBridgeUrl}
                      onChange={(e) => setVcBridgeUrl(e.target.value)}
                      placeholder="https://voice-bridge.example.com"
                      required
                    />
                  </label>
                  <label>
                    <span className="label-text">{t('credentials.field.vcBridgeToken')}</span>
                    <input
                      dir="ltr"
                      type="password"
                      value={vcBridgeToken}
                      onChange={(e) => setVcBridgeToken(e.target.value)}
                    />
                  </label>
                </>
              )}

              <span className="hint">{t('credentials.vc.hint')}</span>
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
        <SkeletonList rows={4} label={t('app.loading')} />
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
                  void (async () => {
                    if (await confirmDialog({ message: t('credentials.delete.confirm', { name: cred.name }), danger: true })) {
                      await guard(() => deleteCredential(cred.id));
                    }
                  })();
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
