import { type FormEvent, useState } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { useI18n } from '../i18n';
import { useAuth } from '../stores/auth';

export function LoginPage() {
  const t = useI18n((s) => s.t);
  const { status, login, loggingIn, loginError } = useAuth();
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('');
  const navigate = useNavigate();
  const location = useLocation();

  if (status === 'authenticated') {
    const dest = (location.state as { from?: string } | null)?.from ?? '/bots';
    return <Navigate to={dest} replace />;
  }

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (await login(username, password)) {
      const dest = (location.state as { from?: string } | null)?.from ?? '/bots';
      navigate(dest, { replace: true });
    }
  };

  return (
    <div className="login-wrap">
      <form className="card login-card" onSubmit={onSubmit}>
        <h1>{t('login.title')}</h1>
        {loginError && <div className="alert">{t(loginError)}</div>}
        <label>
          <span className="label-text">{t('login.username')}</span>
          <input
            dir="ltr"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
            required
          />
        </label>
        <label>
          <span className="label-text">{t('login.password')}</span>
          <input
            dir="ltr"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            required
          />
        </label>
        <div className="form-actions">
          <button className="primary" type="submit" disabled={loggingIn} style={{ width: '100%' }}>
            {loggingIn ? t('login.submitting') : t('login.submit')}
          </button>
        </div>
      </form>
    </div>
  );
}
