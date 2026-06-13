/**
 * SchemaBuilder (P3.5-T3) — the visual editor that produces a CreateCollectionBody
 * (slug + name + icon + the field schema + display hints). New collections only
 * need slug+name+schema; an existing collection is edited in-place (slug fixed).
 *
 * On save it assembles the typed schema doc from the draft rows and validates it
 * against the SHARED `CollectionSchema` (invariant I5) — the editor refuses to
 * round-trip an invalid schema, surfacing the Zod issue inline. When EDITING and
 * the change removes a field that records depend on, it shows a record-count
 * warning and requires a confirm before persisting (P3.5-T3 accept criterion).
 */
import {
  CollectionSchema,
  type CollectionDisplay,
  type CollectionPublic,
  type CreateCollectionBody,
} from '@ctb/shared';
import { useMemo, useState } from 'react';
import type { MessageKey } from '../../i18n';
import {
  type DraftField,
  emptyDraftField,
  fromField,
  removedFieldKeys,
  toSchemaDoc,
} from './builder-model';
import { FieldRowEditor, moveItem } from './FieldRowEditor';

type T = (k: MessageKey, p?: Record<string, string | number>) => string;

export interface SchemaBuilderProps {
  /** Editing an existing collection, or undefined for "new". */
  existing?: CollectionPublic;
  /** Sibling slugs offered as relation targets (excluding self). */
  relationTargets: string[];
  /** Resolve the live record count when a destructive edit needs a warning. */
  recordCount?: () => Promise<number>;
  onSave: (body: CreateCollectionBody, mode: 'create' | 'update') => Promise<void>;
  onCancel: () => void;
  t: T;
}

export function SchemaBuilder({
  existing,
  relationTargets,
  recordCount,
  onSave,
  onCancel,
  t,
}: SchemaBuilderProps) {
  const editing = existing !== undefined;
  const [slug, setSlug] = useState(existing?.slug ?? '');
  const [name, setName] = useState(existing?.name ?? '');
  const [icon, setIcon] = useState(existing?.icon ?? '');
  const [fields, setFields] = useState<DraftField[]>(
    existing ? existing.schema.fields.map(fromField) : [emptyDraftField('text')],
  );
  // display hints
  const [titleField, setTitleField] = useState(existing?.display?.titleField ?? '');
  const [sortField, setSortField] = useState(existing?.display?.defaultSort?.field ?? '');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>(existing?.display?.defaultSort?.dir ?? 'asc');

  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [pendingRemoval, setPendingRemoval] = useState<{
    body: CreateCollectionBody;
    removed: string[];
    count: number;
  } | null>(null);

  const fieldKeys = useMemo(() => fields.map((f) => f.key.trim()).filter((k) => k !== ''), [fields]);

  const patchField = (i: number, patch: Partial<DraftField>) =>
    setFields((cur) => cur.map((f, j) => (j === i ? { ...f, ...patch } : f)));

  const assemble = (): { body: CreateCollectionBody } | { issue: string } => {
    const schemaDoc = toSchemaDoc(fields);
    const parsed = CollectionSchema.safeParse(schemaDoc);
    if (!parsed.success) {
      return { issue: parsed.error.issues[0]?.message ?? t('collections.error.schema') };
    }
    const display: CollectionDisplay = {};
    const listColumns = fields.filter((f) => f.showInList).map((f) => f.key.trim()).filter(Boolean);
    if (listColumns.length > 0) display.listColumns = listColumns;
    if (titleField.trim() !== '') display.titleField = titleField.trim();
    if (sortField.trim() !== '') display.defaultSort = { field: sortField.trim(), dir: sortDir };
    const body: CreateCollectionBody = {
      slug: slug.trim(),
      name: name.trim(),
      ...(icon.trim() !== '' ? { icon: icon.trim() } : {}),
      schema: parsed.data,
      ...(Object.keys(display).length > 0 ? { display } : {}),
    };
    return { body };
  };

  const doSave = async (body: CreateCollectionBody) => {
    setSaving(true);
    setError(null);
    try {
      await onSave(body, editing ? 'update' : 'create');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
      setPendingRemoval(null);
    }
  };

  const handleSave = async () => {
    setError(null);
    if (name.trim() === '') {
      setError(t('collections.error.name'));
      return;
    }
    const assembled = assemble();
    if ('issue' in assembled) {
      setError(assembled.issue);
      return;
    }
    const { body } = assembled;

    // Destructive-edit guard (editing only): if a field was removed and the
    // collection has records, ask for confirmation first.
    if (editing && existing) {
      const removed = removedFieldKeys(existing.schema, body.schema);
      if (removed.length > 0 && recordCount) {
        const count = await recordCount();
        if (count > 0) {
          setPendingRemoval({ body, removed, count });
          return;
        }
      }
    }
    await doSave(body);
  };

  return (
    <div className="card schema-builder" data-testid="schema-builder">
      <div className="form-grid">
        <label>
          <span className="label-text">{t('collections.slug')}</span>
          <input
            dir="ltr"
            value={slug}
            disabled={editing}
            placeholder="products"
            onChange={(e) => setSlug(e.target.value)}
          />
          <span className="hint">{t('collections.slug.hint')}</span>
        </label>
        <label>
          <span className="label-text">{t('collections.name')}</span>
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label>
          <span className="label-text">{t('collections.icon')}</span>
          <input dir="ltr" value={icon ?? ''} placeholder="package" onChange={(e) => setIcon(e.target.value)} />
        </label>
      </div>

      <h3 style={{ marginTop: '1rem' }}>{t('collections.fields')}</h3>
      {fields.map((field, i) => (
        <FieldRowEditor
          key={field.rowId}
          field={field}
          relationTargets={relationTargets}
          index={i}
          count={fields.length}
          t={t}
          onChange={(patch) => patchField(i, patch)}
          onRemove={() => setFields((cur) => cur.filter((_, j) => j !== i))}
          onMove={(dir) => setFields((cur) => moveItem(cur, i, dir))}
        />
      ))}
      <div style={{ display: 'flex', gap: '0.5rem' }}>
        <button type="button" className="ghost" onClick={() => setFields((cur) => [...cur, emptyDraftField('text')])}>
          {t('collections.field.add')}
        </button>
      </div>

      <h3 style={{ marginTop: '1rem' }}>{t('collections.display')}</h3>
      <div className="form-grid">
        <label>
          <span className="label-text">{t('collections.display.titleField')}</span>
          <select value={titleField} onChange={(e) => setTitleField(e.target.value)}>
            <option value="">—</option>
            {fieldKeys.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span className="label-text">{t('collections.display.sortField')}</span>
          <select value={sortField} onChange={(e) => setSortField(e.target.value)}>
            <option value="">—</option>
            {fieldKeys.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span className="label-text">{t('collections.display.sortDir')}</span>
          <select value={sortDir} onChange={(e) => setSortDir(e.target.value as 'asc' | 'desc')}>
            <option value="asc">{t('collections.display.asc')}</option>
            <option value="desc">{t('collections.display.desc')}</option>
          </select>
        </label>
      </div>

      {error && <div className="alert" role="alert">{error}</div>}

      {pendingRemoval && (
        <div className="alert warn" role="alert" data-testid="destructive-warning">
          <p>
            {t('collections.destructive.warning', {
              fields: pendingRemoval.removed.join(', '),
              count: pendingRemoval.count,
            })}
          </p>
          <div className="form-actions">
            <button type="button" className="ghost" onClick={() => setPendingRemoval(null)}>
              {t('common.cancel')}
            </button>
            <button
              type="button"
              className="danger"
              onClick={() => void doSave(pendingRemoval.body)}
              disabled={saving}
            >
              {t('collections.destructive.confirm')}
            </button>
          </div>
        </div>
      )}

      {!pendingRemoval && (
        <div className="form-actions">
          <button type="button" className="ghost" onClick={onCancel}>
            {t('common.cancel')}
          </button>
          <button type="button" className="primary" onClick={() => void handleSave()} disabled={saving}>
            {saving ? t('collections.saving') : editing ? t('collections.save') : t('collections.create')}
          </button>
        </div>
      )}
    </div>
  );
}
