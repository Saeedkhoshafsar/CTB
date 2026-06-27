/**
 * Admins page (PLAN4 K-T3) — list panel admins, add by Telegram numeric id +
 * label, remove, change role (admin↔operator), and (owner-only) transfer
 * ownership. Strictly separate from the per-bot end-user store (invariant I2):
 * these are the panel operators (owner/admin/operator), not bot users.
 *
 * The role-gated controls are decided by the PURE `admin-acl` module (the F-T3
 * pattern), so which buttons render is unit-tested without React. The server is
 * still the authority — the store enforces the owner invariants (K-T1) and the
 * admins API re-checks the caller's role on every request (K-T2); this page is
 * the matching defence-in-depth so an operator never even sees the controls.
 *
 * Reaching this page already requires ≥admin (App.tsx route guard); but we keep
 * the per-row checks here too so an admin still can't touch the owner row.
 */
import {
  type ManageableRole,
  type PanelAdmin,
  type SessionRole,
} from '@ctb/shared';
import { type FormEvent, useEffect, useState } from 'react';
import { ApiError, ClientValidationError } from '../api/client';
import { canChangeRole, canRemove, canTransferTo } from '../lib/admin-acl';
import { useI18n } from '../i18n';
import { useAdmins } from '../stores/admins';
import { useAuth } from '../stores/auth';

const MANAGEABLE_ROLES: ManageableRole[] = ['admin', 'operator'];

export function AdminsPage() {
  const t = useI18n((s) => s.t);
  const user = useAuth((s) => s.user);
  const { admins, loading, error, load, addAdmin, removeAdmin, setAdminRole, transferOwner } =
    useAdmins();

  const myRole: SessionRole = user?.role ?? 'operator';
  const myTgUserId = user?.tgUserId;

  const [showForm, setShowForm] = useState(false);
  const [tgUserId, setTgUserId] = useState('');
  const [label, setLabel] = useState('');
  const [role, setRole] = useState<ManageableRole>('admin');
  const [creating, setCreating] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [rowError, setRowError] = useState<string | null>(null);

  useEffect(() => {
    void load();
  }, [load]);

  const reset = () => {
    setTgUserId('');
    setLabel('');
    setRole('admin');
  };

  const onCreate = async (e: FormEvent) => {
    e.preventDefault();
    setCreating(true);
    setFormError(null);
    try {
      await addAdmin({ tgUserId: tgUserId.trim(), label: label.trim(), role });
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
        <h1>{t('admins.title')}</h1>
        <button className="primary" onClick={() => setShowForm((v) => !v)}>
          {t('admins.add')}
        </button>
      </div>

      <p className="hint">{t('admins.subtitle')}</p>

      {error && <div className="alert">{error}</div>}
      {rowError && <div className="alert">{rowError}</div>}

      {showForm && (
        <form className="card" style={{ marginBottom: '1rem' }} onSubmit={onCreate}>
          {formError && <div className="alert">{formError}</div>}
          <label>
            <span className="label-text">{t('admins.tgUserId')}</span>
            <input
              dir="ltr"
              inputMode="numeric"
              value={tgUserId}
              onChange={(e) => setTgUserId(e.target.value)}
              placeholder="123456789"
              required
            />
          </label>
          <label>
            <span className="label-text">{t('admins.label')}</span>
            <input value={label} onChange={(e) => setLabel(e.target.value)} required />
          </label>
          <label>
            <span className="label-text">{t('admins.role')}</span>
            <select value={role} onChange={(e) => setRole(e.target.value as ManageableRole)}>
              {MANAGEABLE_ROLES.map((r) => (
                <option key={r} value={r}>
                  {t(`admins.role.${r}`)}
                </option>
              ))}
            </select>
          </label>
          <span className="hint">{t('admins.hint')}</span>
          <div className="form-actions">
            <button className="primary" type="submit" disabled={creating}>
              {creating ? t('admins.creating') : t('admins.create')}
            </button>
            <button type="button" className="ghost" onClick={() => setShowForm(false)}>
              {t('common.cancel')}
            </button>
          </div>
        </form>
      )}

      {loading ? (
        <div className="splash">{t('app.loading')}</div>
      ) : admins.length === 0 ? (
        <div className="empty">{t('admins.empty')}</div>
      ) : (
        <div className="row-list">
          {admins.map((admin: PanelAdmin) => {
            const isMe = !!myTgUserId && admin.tgUserId === myTgUserId;
            return (
              <div className="row" key={admin.tgUserId}>
                <div className="grow">
                  <div className="title">
                    {admin.label}
                    {isMe && <span className="badge"> {t('admins.you')}</span>}
                  </div>
                  <div className="sub" dir="ltr">
                    #{admin.tgUserId}
                  </div>
                </div>

                {canChangeRole(myRole, admin) ? (
                  <select
                    value={admin.role}
                    onChange={(e) =>
                      void guard(async () => {
                        await setAdminRole(admin.tgUserId, {
                          role: e.target.value as ManageableRole,
                        });
                      })
                    }
                  >
                    {MANAGEABLE_ROLES.map((r) => (
                      <option key={r} value={r}>
                        {t(`admins.role.${r}`)}
                      </option>
                    ))}
                  </select>
                ) : (
                  <span className="badge">{t(`admins.role.${admin.role}`)}</span>
                )}

                {canTransferTo(myRole, myTgUserId, admin) && (
                  <button
                    className="ghost"
                    onClick={() => {
                      if (confirm(t('admins.transfer.confirm', { label: admin.label }))) {
                        void guard(() => transferOwner({ tgUserId: admin.tgUserId }));
                      }
                    }}
                  >
                    {t('admins.transfer')}
                  </button>
                )}

                {canRemove(myRole, admin) && (
                  <button
                    className="danger ghost"
                    onClick={() => {
                      if (confirm(t('admins.remove.confirm', { label: admin.label }))) {
                        void guard(() => removeAdmin(admin.tgUserId));
                      }
                    }}
                  >
                    {t('admins.action.remove')}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
