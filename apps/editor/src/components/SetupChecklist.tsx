/**
 * First-run setup checklist (PLAN4 L-T2) — a dismissible "go-live" panel that
 * lists the OPEN prerequisite tasks a fresh instance still needs, each
 * deep-linking to the page that satisfies it. When the server reports `ready`
 * the panel flips to a "✅ bot is ready to go public" state.
 *
 * The TRUTH lives on the server (L-T1, `GET /api/setup/checklist`); this
 * component re-derives on mount, so an item disappears the moment its
 * prerequisite is real (principle 1 — no client-only done-flags). The pure
 * `lib/setup-checklist` decides copy + the deep-link route; this is thin glue.
 *
 * Role-gated: the endpoint is admin+ (it 403s an operator), so for an operator
 * we simply render nothing rather than show an error. "Dismiss" is a transient
 * per-session hide (no persisted flag) — refreshing re-derives from real state.
 */
import { roleAtLeast, type SetupChecklist as SetupChecklistDto } from '@ctb/shared';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ApiError, api } from '../api/client';
import { useI18n } from '../i18n';
import { checklistViews } from '../lib/setup-checklist';
import { useAuth } from '../stores/auth';

export function SetupChecklist() {
  const t = useI18n((s) => s.t);
  const user = useAuth((s) => s.user);
  const canSee = roleAtLeast(user?.role ?? 'operator', 'admin');

  const [data, setData] = useState<SetupChecklistDto | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!canSee) return;
    let alive = true;
    api
      .setupChecklist()
      .then((c) => {
        if (alive) setData(c);
      })
      .catch((err) => {
        // 403 (operator) or any error → just hide the panel, never block the page.
        if (alive) setFailed(true);
        if (!(err instanceof ApiError)) console.error('[setup-checklist]', err);
      });
    return () => {
      alive = false;
    };
  }, [canSee]);

  if (!canSee || dismissed || failed || !data) return null;

  // Ready: nothing required remains. Show the celebratory state (still dismissible).
  if (data.ready && data.items.length === 0) {
    return (
      <div className="setup-checklist ready" data-testid="setup-checklist-ready">
        <div className="setup-checklist-head">
          <span className="setup-checklist-title">✅ {t('setup.ready.title')}</span>
          <button className="ghost" onClick={() => setDismissed(true)}>
            {t('setup.dismiss')}
          </button>
        </div>
        <p className="setup-checklist-lead">{t('setup.ready.lead')}</p>
      </div>
    );
  }

  const views = checklistViews(data.items);
  if (views.length === 0) return null; // only unknown ids — nothing to show

  return (
    <div className="setup-checklist" data-testid="setup-checklist">
      <div className="setup-checklist-head">
        <span className="setup-checklist-title">{t('setup.title')}</span>
        <button className="ghost" onClick={() => setDismissed(true)}>
          {t('setup.dismiss')}
        </button>
      </div>
      <p className="setup-checklist-lead">{t('setup.lead')}</p>
      {data.ready && <p className="setup-checklist-note">{t('setup.ready.note')}</p>}
      <ul className="setup-checklist-items">
        {views.map((v) => (
          <li key={v.id} className="setup-checklist-item" data-testid={`setup-item-${v.id}`}>
            <div className="grow">
              <div className="setup-item-title">
                {t(v.titleKey)}
                {v.optional && <span className="badge"> {t('setup.optional')}</span>}
              </div>
              <div className="setup-item-desc">{t(v.descKey)}</div>
            </div>
            <Link className="btn" to={v.route} data-testid={`setup-link-${v.id}`}>
              {t('setup.fix')}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
