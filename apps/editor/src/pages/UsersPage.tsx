/**
 * Users page (P3-T5) — per-bot end-user list with inline editing of the two
 * GENERIC bits (invariant I2): `tags` (string labels) and the free-form
 * `profile` bag. There is no domain field here — the panel just renders
 * whatever the router mirrored (first_name/username/…) and whatever flows have
 * written. Users are read-only otherwise (they're created by conversation, not
 * the panel), so this page only lists + edits, never creates/deletes.
 */
import type { UserPublic } from '@ctb/shared';
import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ApiError, ClientValidationError, api } from '../api/client';
import { useI18n, type MessageKey } from '../i18n';
import { useUsers } from '../stores/users';

export function UsersPage() {
  const t = useI18n((s) => s.t);
  const { botId = '' } = useParams<{ botId: string }>();
  const { users, loading, error, load, updateUser } = useUsers();
  const [botName, setBotName] = useState('');
  const [editing, setEditing] = useState<string | null>(null);

  useEffect(() => {
    void load(botId);
    api
      .getBot(botId)
      .then((b) => setBotName(b.name))
      .catch(() => setBotName(botId));
  }, [botId, load]);

  return (
    <div className="page">
      <div className="page-head">
        <h1>
          {t('users.title')}
          {botName && <span className="sub" style={{ marginInlineStart: '0.5rem' }}>— {botName}</span>}
        </h1>
        <Link className="btn ghost" to="/bots">
          {t('users.back')}
        </Link>
      </div>

      {error && <div className="alert">{error}</div>}

      {loading ? (
        <div className="splash">{t('app.loading')}</div>
      ) : users.length === 0 ? (
        <div className="empty">{t('users.empty')}</div>
      ) : (
        <div className="row-list">
          {users.map((u) => (
            <UserRow
              key={u.id}
              user={u}
              open={editing === u.id}
              onToggle={() => setEditing((cur) => (cur === u.id ? null : u.id))}
              onSave={async (body) => {
                await updateUser(u.id, body);
                setEditing(null);
              }}
              t={t}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function UserRow({
  user,
  open,
  onToggle,
  onSave,
  t,
}: {
  user: UserPublic;
  open: boolean;
  onToggle: () => void;
  onSave: (body: { tags?: string[]; profile?: Record<string, unknown> }) => Promise<void>;
  t: (k: MessageKey, p?: Record<string, string | number>) => string;
}) {
  // Tags edited as a comma-separated string; profile as JSON text (generic — we
  // can't assume a schema, so the panel offers a raw JSON editor for the bag).
  const [tagsText, setTagsText] = useState(user.tags.join(', '));
  const [profileText, setProfileText] = useState(JSON.stringify(user.profile, null, 2));
  const [saving, setSaving] = useState(false);
  const [rowError, setRowError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setTagsText(user.tags.join(', '));
      setProfileText(JSON.stringify(user.profile, null, 2));
      setRowError(null);
    }
  }, [open, user]);

  const save = async () => {
    setSaving(true);
    setRowError(null);
    try {
      const tags = tagsText
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s !== '');
      let profile: Record<string, unknown>;
      try {
        profile = JSON.parse(profileText || '{}');
      } catch {
        setRowError(t('users.profile.invalid'));
        setSaving(false);
        return;
      }
      await onSave({ tags, profile });
    } catch (err) {
      if (err instanceof ClientValidationError || (err instanceof ApiError && err.status === 400)) {
        setRowError(t('error.validation'));
      } else {
        setRowError(t('error.unknown', { detail: err instanceof Error ? err.message : '?' }));
      }
    } finally {
      setSaving(false);
    }
  };

  const seen = new Date(user.lastSeen).toLocaleString();

  return (
    <div className="row" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
        <div className="grow">
          <div className="title">{user.displayName}</div>
          <div className="sub" dir="ltr">
            #{user.tgUserId} · {t('users.lastSeen', { when: seen })}
          </div>
        </div>
        {user.tags.map((tag) => (
          <span className="badge" key={tag}>
            {tag}
          </span>
        ))}
        <button onClick={onToggle}>{open ? t('common.cancel') : t('users.action.edit')}</button>
      </div>

      {open && (
        <div className="card" style={{ marginTop: '0.75rem' }}>
          {rowError && <div className="alert">{rowError}</div>}
          <label>
            <span className="label-text">{t('users.tags')}</span>
            <input value={tagsText} onChange={(e) => setTagsText(e.target.value)} />
            <span className="hint">{t('users.tags.hint')}</span>
          </label>
          <label>
            <span className="label-text">{t('users.profile')}</span>
            <textarea
              dir="ltr"
              rows={Math.min(12, Math.max(4, profileText.split('\n').length))}
              value={profileText}
              onChange={(e) => setProfileText(e.target.value)}
              style={{ fontFamily: 'monospace' }}
            />
            <span className="hint">{t('users.profile.hint')}</span>
          </label>
          <div className="form-actions">
            <button className="primary" onClick={() => void save()} disabled={saving}>
              {saving ? t('users.saving') : t('users.save')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
