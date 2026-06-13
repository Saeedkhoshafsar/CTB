/**
 * Editor shell (P2-T1): auth-gated routing + topbar layout.
 *
 * Routes:
 *   /login                  — login form (redirects away if authenticated)
 *   /bots                   — bots list + create  (default landing)
 *   /bots/:botId/flows      — flows of one bot
 *   /flows/:flowId          — flow editor (canvas lands in P2-T2)
 *   /executions             — executions inspector (lands in P2-T5)
 */
import { useEffect } from 'react';
import {
  HashRouter,
  Navigate,
  NavLink,
  Outlet,
  Route,
  Routes,
  useLocation,
} from 'react-router-dom';
import { useI18n } from './i18n';
import { BotsPage } from './pages/BotsPage';
import { CredentialsPage } from './pages/CredentialsPage';
import { ExecutionsPage } from './pages/ExecutionsPage';
import { FlowEditorPage } from './pages/FlowEditorPage';
import { FlowsPage } from './pages/FlowsPage';
import { LoginPage } from './pages/LoginPage';
import { useAuth } from './stores/auth';

function RequireAuth() {
  const status = useAuth((s) => s.status);
  const t = useI18n((s) => s.t);
  const location = useLocation();

  if (status === 'unknown') return <div className="splash">{t('app.loading')}</div>;
  if (status === 'anonymous') {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }
  return <Outlet />;
}

function Shell() {
  const t = useI18n((s) => s.t);
  const locale = useI18n((s) => s.locale);
  const setLocale = useI18n((s) => s.setLocale);
  const logout = useAuth((s) => s.logout);

  return (
    <div className="shell">
      <header className="topbar">
        <span className="brand">CTB</span>
        <nav>
          <NavLink to="/bots" className={({ isActive }) => (isActive ? 'active' : '')}>
            {t('nav.bots')}
          </NavLink>
          <NavLink to="/executions" className={({ isActive }) => (isActive ? 'active' : '')}>
            {t('nav.executions')}
          </NavLink>
          <NavLink to="/credentials" className={({ isActive }) => (isActive ? 'active' : '')}>
            {t('nav.credentials')}
          </NavLink>
        </nav>
        <span className="spacer" />
        <button className="ghost" onClick={() => setLocale(locale === 'fa' ? 'en' : 'fa')}>
          {t('common.language')}
        </button>
        <button className="ghost" onClick={() => void logout()}>
          {t('nav.logout')}
        </button>
      </header>
      <main className="content">
        <Outlet />
      </main>
    </div>
  );
}

export function App() {
  const probe = useAuth((s) => s.probe);
  const dir = useI18n((s) => s.dir);
  const locale = useI18n((s) => s.locale);

  useEffect(() => {
    void probe();
  }, [probe]);

  useEffect(() => {
    document.documentElement.dir = dir;
    document.documentElement.lang = locale;
  }, [dir, locale]);

  return (
    <HashRouter>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route element={<RequireAuth />}>
          <Route element={<Shell />}>
            <Route path="/bots" element={<BotsPage />} />
            <Route path="/bots/:botId/flows" element={<FlowsPage />} />
            <Route path="/flows/:flowId" element={<FlowEditorPage />} />
            <Route path="/executions" element={<ExecutionsPage />} />
            <Route path="/credentials" element={<CredentialsPage />} />
            <Route path="*" element={<Navigate to="/bots" replace />} />
          </Route>
        </Route>
      </Routes>
    </HashRouter>
  );
}
