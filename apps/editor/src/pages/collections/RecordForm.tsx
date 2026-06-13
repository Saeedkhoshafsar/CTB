/**
 * Record form (P3.5-T4) — the auto-generated record editor. Renders a widget per
 * `CollectionField`, driven entirely by the collection's schema (invariant I2:
 * no domain knowledge). It extends the Phase-2 form idea with the data-only
 * widgets the CRUD panel needs: image/file upload, `group` repeating rows, and a
 * `relation` picker (a search dropdown over the target collection's records).
 *
 * Validation is server-authoritative (invariant I5): the form coerces to the
 * typed document via `toRecordData` and POSTs/PATCHes; a 422 returns field-level
 * errors keyed by dotted path, which we surface inline.
 */
import type { CollectionField, CollectionPublic, RecordPublic } from '@ctb/shared';
import { labelText } from '@ctb/shared';
import { useEffect, useMemo, useState } from 'react';
import { api } from '../../api/client';
import type { Translate } from '../../i18n';
import { type FieldErrors, useRecords } from '../../stores/records';
import {
  type RecordDraft,
  emptyDraft,
  emptyFieldValue,
  emptyGroupRow,
  recordTitle,
  recordToDraft,
  toRecordData,
} from './record-model';

interface Props {
  collection: CollectionPublic;
  /** Sibling collections in the same bot — for resolving relation targets. */
  collections: CollectionPublic[];
  existing?: RecordPublic | undefined;
  onSaved: () => void;
  onCancel: () => void;
  t: Translate;
}

export function RecordForm({ collection, collections, existing, onSaved, onCancel, t }: Props) {
  const { createRecord, updateRecord } = useRecords();
  const [draft, setDraft] = useState<RecordDraft>(() =>
    existing ? recordToDraft(collection.schema, existing.data) : emptyDraft(collection.schema),
  );
  const [errors, setErrors] = useState<FieldErrors>({});
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const setField = (key: string, value: unknown) =>
    setDraft((d) => ({ ...d, [key]: value }));

  const handleSave = async () => {
    setSaving(true);
    setFormError(null);
    setErrors({});
    try {
      const data = toRecordData(collection.schema, draft);
      const result = existing
        ? await updateRecord(collection.id, existing.id, { data, mode: 'replace' })
        : await createRecord(collection.id, { data });
      if (result && 'data' in result) {
        onSaved();
      } else {
        // FieldErrors map — render inline; empty map means a generic 422.
        setErrors(result as FieldErrors);
        if (Object.keys(result as FieldErrors).length === 0) {
          setFormError(t('records.error.invalid'));
        }
      }
    } catch (err) {
      setFormError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="card record-form" data-testid="record-form">
      <h2>{existing ? t('records.form.edit') : t('records.form.new')}</h2>
      <div className="form-grid">
        {collection.schema.fields.map((field) => (
          <FieldEditor
            key={field.key}
            field={field}
            value={draft[field.key]}
            error={errors[field.key]}
            errors={errors}
            collections={collections}
            onChange={(v) => setField(field.key, v)}
            t={t}
          />
        ))}
      </div>

      {formError && (
        <div className="alert" role="alert">
          {formError}
        </div>
      )}

      <div className="form-actions">
        <button type="button" className="ghost" onClick={onCancel}>
          {t('records.action.cancel')}
        </button>
        <button type="button" className="primary" onClick={() => void handleSave()} disabled={saving}>
          {saving ? t('records.saving') : t('records.action.save')}
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// per-field editors
// ---------------------------------------------------------------------------

interface FieldEditorProps {
  field: CollectionField;
  value: unknown;
  error?: string | undefined;
  /** Full error map (so group sub-rows can find their dotted-path errors). */
  errors: FieldErrors;
  pathPrefix?: string | undefined;
  collections: CollectionPublic[];
  onChange: (value: unknown) => void;
  t: Translate;
}

function FieldEditor({ field, value, error, errors, pathPrefix, collections, onChange, t }: FieldEditorProps) {
  const label = labelText(field.label, field.key);
  const required = field.required ? ' *' : '';

  return (
    <label className="field-row" data-field={field.key}>
      <span className="label-text">
        {label}
        {required}
      </span>
      <FieldWidget
        field={field}
        value={value}
        errors={errors}
        pathPrefix={pathPrefix}
        collections={collections}
        onChange={onChange}
        t={t}
      />
      {field.helpText && <span className="hint">{labelText(field.helpText, '')}</span>}
      {error && (
        <span className="hint" style={{ color: 'var(--danger)' }} role="alert">
          {error}
        </span>
      )}
    </label>
  );
}

function FieldWidget({
  field,
  value,
  errors,
  pathPrefix,
  collections,
  onChange,
  t,
}: Omit<FieldEditorProps, 'error'>) {
  switch (field.type) {
    case 'longText':
    case 'richTextLite':
      return (
        <textarea
          value={typeof value === 'string' ? value : ''}
          onChange={(e) => onChange(e.target.value)}
          rows={4}
        />
      );
    case 'number':
      return (
        <input
          type="number"
          dir="ltr"
          value={value === undefined || value === null ? '' : String(value)}
          onChange={(e) => onChange(e.target.value)}
          {...(field.validation?.min !== undefined ? { min: field.validation.min } : {})}
          {...(field.validation?.max !== undefined ? { max: field.validation.max } : {})}
        />
      );
    case 'boolean':
      return (
        <span className="toggle">
          <input
            type="checkbox"
            checked={value === true}
            onChange={(e) => onChange(e.target.checked)}
          />
        </span>
      );
    case 'select':
      return (
        <select value={typeof value === 'string' ? value : ''} onChange={(e) => onChange(e.target.value)}>
          <option value="">{t('records.field.choose')}</option>
          {(field.options ?? []).map((o) => (
            <option key={o.value} value={o.value}>
              {labelText(o.label, o.value)}
            </option>
          ))}
        </select>
      );
    case 'multiSelect':
      return <MultiSelectWidget field={field} value={value} onChange={onChange} />;
    case 'date':
      return (
        <input
          type="date"
          dir="ltr"
          value={typeof value === 'string' ? value : ''}
          onChange={(e) => onChange(e.target.value)}
        />
      );
    case 'dateTime':
      return (
        <input
          type="datetime-local"
          dir="ltr"
          value={typeof value === 'string' ? value.slice(0, 16) : ''}
          onChange={(e) => onChange(e.target.value ? new Date(e.target.value).toISOString() : '')}
        />
      );
    case 'image':
    case 'file':
      return <FileWidget field={field} value={value} collections={collections} onChange={onChange} t={t} />;
    case 'json':
      return (
        <textarea
          dir="ltr"
          className="mono"
          value={typeof value === 'string' ? value : JSON.stringify(value ?? null, null, 2)}
          onChange={(e) => onChange(e.target.value)}
          rows={4}
        />
      );
    case 'relation':
      return <RelationWidget field={field} value={value} collections={collections} onChange={onChange} t={t} />;
    case 'group':
      return (
        <GroupWidget
          field={field}
          value={value}
          errors={errors}
          pathPrefix={pathPrefix}
          collections={collections}
          onChange={onChange}
          t={t}
        />
      );
    default:
      return (
        <input
          type="text"
          value={typeof value === 'string' ? value : ''}
          onChange={(e) => onChange(e.target.value)}
          {...(field.validation?.regex ? { pattern: field.validation.regex } : {})}
        />
      );
  }
}

// --- multiSelect: a set of toggle chips ------------------------------------

function MultiSelectWidget({
  field,
  value,
  onChange,
}: {
  field: CollectionField;
  value: unknown;
  onChange: (v: unknown) => void;
}) {
  const selected = Array.isArray(value) ? (value as string[]) : [];
  const toggle = (v: string) =>
    onChange(selected.includes(v) ? selected.filter((x) => x !== v) : [...selected, v]);
  return (
    <div className="chip-set">
      {(field.options ?? []).map((o) => (
        <button
          type="button"
          key={o.value}
          className={`chip${selected.includes(o.value) ? ' on' : ''}`}
          onClick={() => toggle(o.value)}
        >
          {labelText(o.label, o.value)}
        </button>
      ))}
    </div>
  );
}

// --- image/file upload ------------------------------------------------------

function FileWidget({
  field,
  value,
  collections,
  onChange,
  t,
}: {
  field: CollectionField;
  value: unknown;
  collections: CollectionPublic[];
  onChange: (v: unknown) => void;
  t: Translate;
}) {
  const botId = collections[0]?.botId ?? '';
  const [uploading, setUploading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const fileId = typeof value === 'string' && value !== '' ? value : null;

  const handleFile = async (file: File) => {
    setUploading(true);
    setErr(null);
    try {
      const base64 = await fileToBase64(file);
      const uploaded = await api.uploadFile(botId, base64, file.type || null);
      onChange(uploaded.id);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="file-widget">
      {fileId && field.type === 'image' && (
        <img className="file-preview" src={api.fileUrl(fileId)} alt={field.key} />
      )}
      {fileId && field.type === 'file' && (
        <a className="sub" href={api.fileUrl(fileId)} target="_blank" rel="noreferrer" dir="ltr">
          {fileId}
        </a>
      )}
      <div className="file-actions">
        <input
          type="file"
          accept={field.type === 'image' ? 'image/*' : undefined}
          disabled={uploading}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void handleFile(f);
          }}
        />
        {fileId && (
          <button type="button" className="ghost" onClick={() => onChange('')}>
            {t('records.field.clearFile')}
          </button>
        )}
      </div>
      {uploading && <span className="hint">{t('records.field.uploading')}</span>}
      {err && (
        <span className="hint" style={{ color: 'var(--danger)' }}>
          {err}
        </span>
      )}
    </div>
  );
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      // strip the "data:<mime>;base64," prefix
      const comma = result.indexOf(',');
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(reader.error ?? new Error('read failed'));
    reader.readAsDataURL(file);
  });
}

// --- relation picker (search dropdown over the target collection) -----------

function RelationWidget({
  field,
  value,
  collections,
  onChange,
  t,
}: {
  field: CollectionField;
  value: unknown;
  collections: CollectionPublic[];
  onChange: (v: unknown) => void;
  t: Translate;
}) {
  const target = useMemo(
    () => collections.find((c) => c.slug === field.relation?.collection),
    [collections, field.relation],
  );
  const [options, setOptions] = useState<RecordPublic[]>([]);
  const [loaded, setLoaded] = useState(false);
  const many = field.relation?.kind === 'many';

  useEffect(() => {
    if (!target) return;
    void api
      .queryRecords(target.id, { where: [], sort: [], limit: 200 })
      .then((page) => setOptions(page.records))
      .catch(() => setOptions([]))
      .finally(() => setLoaded(true));
  }, [target]);

  if (!target) {
    return <span className="hint">{t('records.relation.missing', { slug: field.relation?.collection ?? '' })}</span>;
  }
  const labelFor = (id: string): string => {
    const rec = options.find((r) => r.id === id);
    return rec ? recordTitle(target, rec) : id;
  };

  if (many) {
    const selected = Array.isArray(value) ? (value as string[]) : [];
    const toggle = (id: string) =>
      onChange(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]);
    return (
      <div className="chip-set" data-testid={`relation-${field.key}`}>
        {!loaded && <span className="hint">{t('app.loading')}</span>}
        {loaded && options.length === 0 && <span className="hint">{t('records.relation.empty')}</span>}
        {options.map((r) => (
          <button
            type="button"
            key={r.id}
            className={`chip${selected.includes(r.id) ? ' on' : ''}`}
            onClick={() => toggle(r.id)}
          >
            {recordTitle(target, r)}
          </button>
        ))}
      </div>
    );
  }

  return (
    <select
      data-testid={`relation-${field.key}`}
      value={typeof value === 'string' ? value : ''}
      onChange={(e) => onChange(e.target.value)}
    >
      <option value="">{t('records.field.choose')}</option>
      {typeof value === 'string' && value !== '' && !options.some((r) => r.id === value) && (
        <option value={value}>{labelFor(value)}</option>
      )}
      {options.map((r) => (
        <option key={r.id} value={r.id}>
          {recordTitle(target, r)}
        </option>
      ))}
    </select>
  );
}

// --- group: repeating rows --------------------------------------------------

function GroupWidget({
  field,
  value,
  errors,
  pathPrefix,
  collections,
  onChange,
  t,
}: {
  field: CollectionField;
  value: unknown;
  errors: FieldErrors;
  pathPrefix?: string | undefined;
  collections: CollectionPublic[];
  onChange: (v: unknown) => void;
  t: Translate;
}) {
  const rows = Array.isArray(value) ? (value as RecordDraft[]) : [];
  const prefix = pathPrefix ? `${pathPrefix}.${field.key}` : field.key;

  const setRow = (i: number, key: string, v: unknown) =>
    onChange(rows.map((r, idx) => (idx === i ? { ...r, [key]: v } : r)));
  const addRow = () => onChange([...rows, emptyGroupRow(field)]);
  const removeRow = (i: number) => onChange(rows.filter((_, idx) => idx !== i));

  return (
    <div className="group-widget" data-testid={`group-${field.key}`}>
      {rows.map((row, i) => (
        <div className="group-row card" key={i}>
          <div className="group-row-head">
            <span className="sub">#{i + 1}</span>
            <button type="button" className="ghost danger" onClick={() => removeRow(i)}>
              {t('records.group.removeRow')}
            </button>
          </div>
          <div className="form-grid">
            {(field.fields ?? []).map((sub) => (
              <FieldEditor
                key={sub.key}
                field={sub}
                value={row[sub.key]}
                error={errors[`${prefix}[${i}].${sub.key}`]}
                errors={errors}
                pathPrefix={`${prefix}[${i}]`}
                collections={collections}
                onChange={(v) => setRow(i, sub.key, v)}
                t={t}
              />
            ))}
          </div>
        </div>
      ))}
      <button type="button" className="ghost" onClick={addRow}>
        {t('records.group.addRow')}
      </button>
      {rows.length === 0 && (
        <span className="hint">{labelText(field.label, field.key)}: {t('records.group.empty')}</span>
      )}
    </div>
  );
}

// re-export the empty-value helper for callers that compose forms
export { emptyFieldValue };
