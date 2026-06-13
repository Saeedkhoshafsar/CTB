/**
 * FieldRowEditor (P3.5-T3) — the visual row for ONE field in the schema builder.
 * Renders the type picker + label (fa/en) + required/default/indexed/showInList,
 * and reveals the type-specific extras: options (select/multiSelect), relation
 * target picker, group sub-field editor (one level deep), and validation knobs.
 *
 * It is a controlled component: it never holds field state itself, only emits a
 * patched `DraftField` upward. Sub-fields reuse this same component with
 * `isSub` (which hides group/relation from the type picker and the indexed
 * toggle — sub-fields can't be indexed or structural, mirroring SubFieldSchema).
 */
import type { MessageKey } from '../../i18n';
import {
  type DraftField,
  type DraftOption,
  FIELD_TYPES,
  OPTION_TYPES,
  SUB_FIELD_TYPES,
  emptyDraftField,
} from './builder-model';
import type { FieldType } from '@ctb/shared';

type T = (k: MessageKey, p?: Record<string, string | number>) => string;

export interface FieldRowEditorProps {
  field: DraftField;
  /** Collection slugs available as relation targets. */
  relationTargets: string[];
  isSub?: boolean;
  index: number;
  count: number;
  onChange: (patch: Partial<DraftField>) => void;
  onRemove: () => void;
  onMove: (dir: -1 | 1) => void;
  t: T;
}

export function FieldRowEditor({
  field,
  relationTargets,
  isSub = false,
  index,
  count,
  onChange,
  onRemove,
  onMove,
  t,
}: FieldRowEditorProps) {
  const types = isSub ? SUB_FIELD_TYPES : FIELD_TYPES;
  const isOptionType = OPTION_TYPES.includes(field.type);

  return (
    <div className="card field-row" data-testid="field-row" style={{ marginBottom: '0.5rem' }}>
      <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <label className="grow">
          <span className="label-text">{t('collections.field.key')}</span>
          <input
            dir="ltr"
            aria-label={t('collections.field.key')}
            value={field.key}
            placeholder="e.g. title"
            onChange={(e) => onChange({ key: e.target.value })}
          />
        </label>
        <label>
          <span className="label-text">{t('collections.field.type')}</span>
          <select
            aria-label={t('collections.field.type')}
            value={field.type}
            onChange={(e) => onChange({ type: e.target.value as FieldType })}
          >
            {types.map((ty) => (
              <option key={ty} value={ty}>
                {t(`collections.fieldType.${ty}` as MessageKey)}
              </option>
            ))}
          </select>
        </label>
        <div style={{ display: 'flex', gap: '0.25rem' }}>
          <button
            type="button"
            className="ghost"
            disabled={index === 0}
            title={t('collections.field.moveUp')}
            onClick={() => onMove(-1)}
          >
            ↑
          </button>
          <button
            type="button"
            className="ghost"
            disabled={index === count - 1}
            title={t('collections.field.moveDown')}
            onClick={() => onMove(1)}
          >
            ↓
          </button>
          <button type="button" className="ghost danger" onClick={onRemove}>
            {t('collections.field.remove')}
          </button>
        </div>
      </div>

      <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', marginTop: '0.5rem' }}>
        <label className="grow">
          <span className="label-text">{t('collections.field.labelFa')}</span>
          <input value={field.labelFa} onChange={(e) => onChange({ labelFa: e.target.value })} />
        </label>
        <label className="grow">
          <span className="label-text">{t('collections.field.labelEn')}</span>
          <input dir="ltr" value={field.labelEn} onChange={(e) => onChange({ labelEn: e.target.value })} />
        </label>
      </div>

      <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap', marginTop: '0.5rem' }}>
        <label className="inline">
          <input
            type="checkbox"
            checked={field.required}
            onChange={(e) => onChange({ required: e.target.checked })}
          />
          <span>{t('collections.field.required')}</span>
        </label>
        <label className="inline">
          <input
            type="checkbox"
            checked={field.showInList}
            onChange={(e) => onChange({ showInList: e.target.checked })}
          />
          <span>{t('collections.field.showInList')}</span>
        </label>
        {!isSub && field.type !== 'group' && (
          <label className="inline">
            <input
              type="checkbox"
              checked={field.indexed}
              onChange={(e) => onChange({ indexed: e.target.checked })}
            />
            <span>{t('collections.field.indexed')}</span>
          </label>
        )}
        {field.type !== 'group' && field.type !== 'relation' && (
          <label className="grow">
            <span className="label-text">{t('collections.field.default')}</span>
            <input
              dir="ltr"
              value={field.defaultText}
              placeholder={t('collections.field.default.hint')}
              onChange={(e) => onChange({ defaultText: e.target.value })}
            />
          </label>
        )}
      </div>

      {/* validation knobs for the relevant types */}
      {(field.type === 'number') && (
        <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', marginTop: '0.5rem' }}>
          <label>
            <span className="label-text">{t('collections.field.min')}</span>
            <input dir="ltr" value={field.min} onChange={(e) => onChange({ min: e.target.value })} />
          </label>
          <label>
            <span className="label-text">{t('collections.field.max')}</span>
            <input dir="ltr" value={field.max} onChange={(e) => onChange({ max: e.target.value })} />
          </label>
        </div>
      )}
      {(field.type === 'text' || field.type === 'longText' || field.type === 'richTextLite') && (
        <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', marginTop: '0.5rem' }}>
          <label>
            <span className="label-text">{t('collections.field.minLength')}</span>
            <input dir="ltr" value={field.minLength} onChange={(e) => onChange({ minLength: e.target.value })} />
          </label>
          <label>
            <span className="label-text">{t('collections.field.maxLength')}</span>
            <input dir="ltr" value={field.maxLength} onChange={(e) => onChange({ maxLength: e.target.value })} />
          </label>
          <label className="grow">
            <span className="label-text">{t('collections.field.regex')}</span>
            <input dir="ltr" value={field.regex} onChange={(e) => onChange({ regex: e.target.value })} />
          </label>
        </div>
      )}

      {/* select / multiSelect options */}
      {isOptionType && (
        <OptionsEditor
          options={field.options}
          onChange={(options) => onChange({ options })}
          t={t}
        />
      )}

      {/* relation target picker */}
      {field.type === 'relation' && (
        <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', marginTop: '0.5rem' }}>
          <label className="grow">
            <span className="label-text">{t('collections.field.relationTarget')}</span>
            <select
              aria-label={t('collections.field.relationTarget')}
              value={field.relationCollection}
              onChange={(e) => onChange({ relationCollection: e.target.value })}
            >
              <option value="">{t('collections.field.relationTarget.choose')}</option>
              {relationTargets.map((slug) => (
                <option key={slug} value={slug}>
                  {slug}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span className="label-text">{t('collections.field.relationKind')}</span>
            <select
              aria-label={t('collections.field.relationKind')}
              value={field.relationKind}
              onChange={(e) => onChange({ relationKind: e.target.value as 'one' | 'many' })}
            >
              <option value="one">{t('collections.relationKind.one')}</option>
              <option value="many">{t('collections.relationKind.many')}</option>
            </select>
          </label>
        </div>
      )}

      {/* group sub-fields (one level deep) */}
      {field.type === 'group' && (
        <div className="group-sub" style={{ marginTop: '0.5rem', paddingInlineStart: '1rem', borderInlineStart: '2px solid var(--border, #ccc)' }}>
          <div className="sub" style={{ marginBottom: '0.25rem' }}>{t('collections.field.group.hint')}</div>
          {field.fields.map((sub, i) => (
            <FieldRowEditor
              key={sub.rowId}
              field={sub}
              relationTargets={relationTargets}
              isSub
              index={i}
              count={field.fields.length}
              t={t}
              onChange={(patch) =>
                onChange({ fields: field.fields.map((f, j) => (j === i ? { ...f, ...patch } : f)) })
              }
              onRemove={() => onChange({ fields: field.fields.filter((_, j) => j !== i) })}
              onMove={(dir) => onChange({ fields: moveItem(field.fields, i, dir) })}
            />
          ))}
          <button
            type="button"
            className="ghost"
            onClick={() => onChange({ fields: [...field.fields, emptyDraftField('text')] })}
          >
            {t('collections.field.group.addSub')}
          </button>
        </div>
      )}
    </div>
  );
}

function OptionsEditor({
  options,
  onChange,
  t,
}: {
  options: DraftOption[];
  onChange: (next: DraftOption[]) => void;
  t: T;
}) {
  return (
    <div className="options-editor" style={{ marginTop: '0.5rem' }}>
      <div className="sub" style={{ marginBottom: '0.25rem' }}>{t('collections.field.options')}</div>
      {options.map((opt, i) => (
        <div key={i} style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.25rem', flexWrap: 'wrap' }}>
          <input
            dir="ltr"
            aria-label={t('collections.field.option.value')}
            placeholder={t('collections.field.option.value')}
            value={opt.value}
            onChange={(e) => onChange(options.map((o, j) => (j === i ? { ...o, value: e.target.value } : o)))}
          />
          <input
            placeholder={t('collections.field.option.labelFa')}
            value={opt.labelFa}
            onChange={(e) => onChange(options.map((o, j) => (j === i ? { ...o, labelFa: e.target.value } : o)))}
          />
          <input
            dir="ltr"
            placeholder={t('collections.field.option.labelEn')}
            value={opt.labelEn}
            onChange={(e) => onChange(options.map((o, j) => (j === i ? { ...o, labelEn: e.target.value } : o)))}
          />
          <button type="button" className="ghost danger" onClick={() => onChange(options.filter((_, j) => j !== i))}>
            ×
          </button>
        </div>
      ))}
      <button
        type="button"
        className="ghost"
        onClick={() => onChange([...options, { value: '', labelFa: '', labelEn: '' }])}
      >
        {t('collections.field.option.add')}
      </button>
    </div>
  );
}

/** Move item at `i` by `dir` (-1 up / +1 down), clamped. Pure. */
export function moveItem<T>(items: T[], i: number, dir: -1 | 1): T[] {
  const j = i + dir;
  if (j < 0 || j >= items.length) return items;
  const next = [...items];
  const a = next[i]!;
  const b = next[j]!;
  next[i] = b;
  next[j] = a;
  return next;
}
