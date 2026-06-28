/**
 * Editor shell (P2-T1): auth-gated routing + topbar layout.
 *
 * Routes:
 *   /login                  — login form (redirects away if authenticated)
 *   /bots                   — bots list + create  (default landing)
 *   /bots/:botId/flows      — flows of one bot
 *   /flows/:flowId          — flow editor (canvas lands in P2-T2)
 *   /executions             — executions inspector (lands in P2-T5)
 *   /docs                   — node library docs site (PD-T4)
 */
import { roleAtLeast } from '@ctb/shared';
import { lazy, Suspense, useEffect } from 'react';
import {
  HashRouter,
  Navigate,
  NavLink,
  Outlet,
  Route,
  Routes,
  useLocation,
} from 'react-router-dom';
import { ConfirmHost } from './components/ConfirmHost';
import { ToastHost } from './components/ToastHost';
import { useI18n } from './i18n';
// LoginPage is the initial/anonymous landing — keep it eager so first paint is
// instant. Every authed page is route-split (PLAN5 P3-T7 / issue C8) so the
// heavy flow editor (CodeMirror + @xyflow) loads only when its route is hit.
import { LoginPage } from './pages/LoginPage';
import { useAuth } from './stores/auth';

const BotsPage = lazy(() => import('./pages/BotsPage').then((m) => ({ default: m.BotsPage })));
const FlowsPage = lazy(() => import('./pages/FlowsPage').then((m) => ({ default: m.FlowsPage })));
const UsersPage = lazy(() => import('./pages/UsersPage').then((m) => ({ default: m.UsersPage })));
const CollectionsPage = lazy(() =>
  import('./pages/CollectionsPage').then((m) => ({ default: m.CollectionsPage })),
);
const FlowEditorPage = lazy(() =>
  import('./pages/FlowEditorPage').then((m) => ({ default: m.FlowEditorPage })),
);
const ExecutionsPage = lazy(() =>
  import('./pages/ExecutionsPage').then((m) => ({ default: m.ExecutionsPage })),
);
const CredentialsPage = lazy(() =>
  import('./pages/CredentialsPage').then((m) => ({ default: m.CredentialsPage })),
);
const NodeDocsPage = lazy(() =>
  import('./pages/NodeDocsPage').then((m) => ({ default: m.NodeDocsPage })),
);
const AdminsPage = lazy(() => import('./pages/AdminsPage').then((m) => ({ default: m.AdminsPage })));

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

/**
 * Route guard for ≥admin surfaces (K-T3). Reaching the Admins page requires the
 * session role to be at least `admin`; an `operator` is bounced to /bots. The
 * server is still the authority (the admins API re-checks role — K-T2); this is
 * defence-in-depth so the page never renders for an operator who hand-edits the
 * URL hash.
 */
function RequireAdmin() {
  const user = useAuth((s) => s.user);
  if (!roleAtLeast(user?.role ?? 'operator', 'admin')) {
    return <Navigate to="/bots" replace />;
  }
  return <Outlet />;
}

function Shell() {
  const t = useI18n((s) => s.t);
  const locale = useI18n((s) => s.locale);
  const setLocale = useI18n((s) => s.setLocale);
  const logout = useAuth((s) => s.logout);
  const user = useAuth((s) => s.user);
  const isAdmin = roleAtLeast(user?.role ?? 'operator', 'admin');

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
          <NavLink to="/docs" className={({ isActive }) => (isActive ? 'active' : '')}>
            {t('nav.docs')}
          </NavLink>
          {isAdmin && (
            <NavLink to="/admins" className={({ isActive }) => (isActive ? 'active' : '')}>
              {t('nav.admins')}
            </NavLink>
          )}
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
        <Suspense fallback={<div className="splash">{t('app.loading')}</div>}>
          <Outlet />
        </Suspense>
      </main>
      <ToastHost />
      <ConfirmHost />
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
            <Route path="/bots/:botId/users" element={<UsersPage />} />
            <Route path="/bots/:botId/collections" element={<CollectionsPage />} />
            <Route path="/flows/:flowId" element={<FlowEditorPage />} />
            <Route path="/executions" element={<ExecutionsPage />} />
            <Route path="/credentials" element={<CredentialsPage />} />
            <Route path="/docs" element={<NodeDocsPage />} />
            <Route element={<RequireAdmin />}>
              <Route path="/admins" element={<AdminsPage />} />
            </Route>
            <Route path="*" element={<Navigate to="/bots" replace />} />
          </Route>
        </Route>
      </Routes>
    </HashRouter>
  );
}
