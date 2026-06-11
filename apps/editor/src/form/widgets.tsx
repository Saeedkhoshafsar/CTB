/**
 * Widget renderers (P2-T3) — the visual half of the form engine.
 *
 * Every widget edits ONE schema node: it receives the current value and an
 * onChange with the next value (undefined = unset). Widgets never know which
 * node type they belong to — they are keyed by structural WidgetKind
 * (see schema.ts), so Phase 3.5 Collection forms reuse them as-is.
 */
import { useId, useRef, useState, type ReactNode } from 'react';
import { useI18n, type MessageKey } from '../i18n';
import { SCOPE_HINTS, hasExpression, insertHint, splitSegments } from './expression';
import {
  emptyValue,
  matchBranch,
  objectFields,
  unionBranches,
  type FieldSpec,
  type JsonSchema,
} from './schema';

export interface WidgetProps {
  spec: FieldSpec;
  value: unknown;
  onChange: (next: unknown) => void;
}

function humanize(key: string): string {
  return key.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
}

/** Param label: i18n `param.<key>` when present, humanized key otherwise. */
export function useLabel(): (key: string) => string {
  const t = useI18n((s) => s.t);
  return (key: string) => {
    const k = `param.${key}`;
    const msg = t(k as MessageKey);
    return msg === k ? humanize(key) : msg;
  };
}

// ── expression-aware text input ──────────────────────────────────────────────

function ExprHighlight({ text }: { text: string }) {
  return (
    <>
      {splitSegments(text).map((seg, i) =>
        seg.expr ? <mark key={i}>{seg.text}</mark> : <span key={i}>{seg.text}</span>,
      )}
      {/* trailing newline keeps overlay height in sync with the textarea */}
      {'\u200b'}
    </>
  );
}

export function ExpressionInput({
  value,
  onChange,
  multiline = false,
  placeholder,
}: {
  value: string;
  onChange: (next: string) => void;
  multiline?: boolean | undefined;
  placeholder?: string | undefined;
}) {
  const t = useI18n((s) => s.t);
  const [hintsOpen, setHintsOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);
  const overlayRef = useRef<HTMLDivElement | null>(null);

  const syncScroll = () => {
    const input = inputRef.current;
    const overlay = overlayRef.current;
    if (input && overlay) {
      overlay.scrollTop = input.scrollTop;
      overlay.scrollLeft = input.scrollLeft;
    }
  };

  const pickHint = (name: string) => {
    const input = inputRef.current;
    const caret = input?.selectionStart ?? value.length;
    const next = insertHint(value, caret, name);
    onChange(next.text);
    setHintsOpen(false);
    requestAnimationFrame(() => {
      input?.focus();
      input?.setSelectionRange(next.caret, next.caret);
    });
  };

  const cls = `expr-input${hasExpression(value) ? ' has-expr' : ''}${multiline ? ' multiline' : ''}`;
  return (
    <div className={cls}>
      <div className="expr-box">
        <div ref={overlayRef} className="expr-overlay" aria-hidden>
          <ExprHighlight text={value} />
        </div>
        {multiline ? (
          <textarea
            ref={(el) => void (inputRef.current = el)}
            value={value}
            placeholder={placeholder}
            rows={3}
            onChange={(e) => onChange(e.target.value)}
            onScroll={syncScroll}
            dir="auto"
          />
        ) : (
          <input
            ref={(el) => void (inputRef.current = el)}
            type="text"
            value={value}
            placeholder={placeholder}
            onChange={(e) => onChange(e.target.value)}
            onScroll={syncScroll}
            dir="auto"
          />
        )}
      </div>
      <button
        type="button"
        className="expr-fx ghost"
        title={t('form.expr.hints')}
        onClick={() => setHintsOpen((o) => !o)}
      >
        {'{x}'}
      </button>
      {hintsOpen ? (
        <ul className="expr-hints" role="listbox">
          {SCOPE_HINTS.map((h) => (
            <li key={h.name}>
              <button type="button" onClick={() => pickHint(h.name)}>
                <code>{h.name}</code>
                <span className="hint-example">{h.example}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

// ── primitive widgets ────────────────────────────────────────────────────────

function TextWidget({ spec, value, onChange, multiline }: WidgetProps & { multiline?: boolean }) {
  return (
    <ExpressionInput
      value={value === undefined || value === null ? '' : String(value)}
      onChange={(v) => onChange(v === '' && !spec.required ? undefined : v)}
      multiline={multiline}
    />
  );
}

function NumberWidget({ spec, value, onChange }: WidgetProps) {
  return (
    <input
      type="number"
      value={typeof value === 'number' ? value : ''}
      min={spec.schema.minimum}
      max={spec.schema.maximum}
      onChange={(e) => {
        const raw = e.target.value;
        onChange(raw === '' ? undefined : Number(raw));
      }}
    />
  );
}

function BooleanWidget({ value, onChange }: WidgetProps) {
  return (
    <label className="bool-widget">
      <input
        type="checkbox"
        checked={value === true}
        onChange={(e) => onChange(e.target.checked)}
      />
    </label>
  );
}

function SelectWidget({ spec, value, onChange }: WidgetProps) {
  const options = spec.schema.enum ?? [];
  const current = value === undefined ? '' : String(value);
  return (
    <select
      value={current}
      onChange={(e) => {
        const raw = e.target.value;
        if (raw === '') return onChange(undefined);
        const opt = options.find((o) => String(o) === raw);
        onChange(opt ?? raw);
      }}
    >
      {!spec.required || current === '' ? <option value="">—</option> : null}
      {options.map((o) => (
        <option key={String(o)} value={String(o)}>
          {String(o)}
        </option>
      ))}
    </select>
  );
}

const DURATION_UNITS = ['s', 'm', 'h', 'd', 'ms'] as const;

function DurationWidget({ value, onChange }: WidgetProps) {
  const m = typeof value === 'string' ? /^(\d+)\s*(ms|s|m|h|d)$/.exec(value) : null;
  const qty = m ? m[1]! : '';
  const unit = m ? m[2]! : 'm';
  const t = useI18n((s) => s.t);
  const emit = (q: string, u: string) => onChange(q === '' ? undefined : `${q}${u}`);
  return (
    <div className="duration-widget">
      <input
        type="number"
        min={0}
        value={qty}
        onChange={(e) => emit(e.target.value, unit)}
        placeholder="15"
      />
      <select value={unit} onChange={(e) => emit(qty, e.target.value)}>
        {DURATION_UNITS.map((u) => (
          <option key={u} value={u}>
            {t(`form.duration.${u}` as MessageKey)}
          </option>
        ))}
      </select>
    </div>
  );
}

// ── composite widgets ────────────────────────────────────────────────────────

function ObjectWidget({ spec, value, onChange }: WidgetProps) {
  const label = useLabel();
  const obj =
    value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  return (
    <div className="object-widget">
      {objectFields(spec.schema).map((child) => (
        <FieldRow key={child.key} label={label(child.key)} required={child.required} inline={child.widget === 'boolean'}>
          <SchemaWidget
            spec={child}
            value={obj[child.key]}
            onChange={(v) => onChange({ ...obj, [child.key]: v })}
          />
        </FieldRow>
      ))}
    </div>
  );
}

function RowsWidget({ spec, value, onChange }: WidgetProps) {
  const t = useI18n((s) => s.t);
  const label = useLabel();
  const items: JsonSchema = spec.schema.items ?? {};
  const rows = Array.isArray(value) ? value : [];
  const fields = objectFields(items);
  const setRow = (i: number, v: unknown) => onChange(rows.map((r, j) => (j === i ? v : r)));
  return (
    <div className="rows-widget">
      {rows.map((row, i) => {
        const rowObj =
          row !== null && typeof row === 'object' && !Array.isArray(row)
            ? (row as Record<string, unknown>)
            : {};
        return (
          <div className="row-item" key={i}>
            <div className="row-fields">
              {fields.length > 0 ? (
                fields.map((child) => (
                  <FieldRow key={child.key} label={label(child.key)} required={child.required} inline={child.widget === 'boolean'}>
                    <SchemaWidget
                      spec={child}
                      value={rowObj[child.key]}
                      onChange={(v) => setRow(i, { ...rowObj, [child.key]: v })}
                    />
                  </FieldRow>
                ))
              ) : (
                <SchemaWidget
                  spec={{ key: '', schema: items, required: true, widget: 'expression' }}
                  value={row}
                  onChange={(v) => setRow(i, v)}
                />
              )}
            </div>
            <div className="row-controls">
              <button type="button" className="ghost sm" title={t('form.moveUp')} disabled={i === 0}
                onClick={() => onChange(swap(rows, i, i - 1))}>↑</button>
              <button type="button" className="ghost sm" title={t('form.moveDown')} disabled={i === rows.length - 1}
                onClick={() => onChange(swap(rows, i, i + 1))}>↓</button>
              <button type="button" className="ghost sm danger" title={t('form.removeRow')}
                onClick={() => onChange(rows.filter((_, j) => j !== i))}>✕</button>
            </div>
          </div>
        );
      })}
      <button type="button" className="ghost add-row" onClick={() => onChange([...rows, emptyValue(items)])}>
        + {t('form.addRow')}
      </button>
    </div>
  );
}

function swap(rows: unknown[], a: number, b: number): unknown[] {
  const next = [...rows];
  const tmp = next[a];
  next[a] = next[b]!;
  next[b] = tmp;
  return next;
}

function UnionWidget({ spec, value, onChange }: WidgetProps) {
  const t = useI18n((s) => s.t);
  const branches = unionBranches(spec.schema);
  const active = matchBranch(spec.schema, value);
  const branchLabel = (b: FieldSpec, i: number): string =>
    b.schema.type === 'string' || b.schema.type === 'number'
      ? t('form.union.simple')
      : `${t('form.union.advanced')}${branches.length > 2 ? ` ${i + 1}` : ''}`;
  const branch = branches[active];
  return (
    <div className="union-widget">
      <div className="union-tabs">
        {branches.map((b, i) => (
          <button
            key={i}
            type="button"
            className={`ghost sm${i === active ? ' active' : ''}`}
            onClick={() => {
              if (i !== active) onChange(emptyValue(b.schema));
            }}
          >
            {branchLabel(b, i)}
          </button>
        ))}
      </div>
      {branch ? <SchemaWidget spec={{ ...branch, key: spec.key }} value={value} onChange={onChange} /> : null}
    </div>
  );
}

// ── Telegram keyboard builder ────────────────────────────────────────────────

interface KbInlineButton {
  text?: string;
  kind?: string;
  value?: string;
}

function KeyboardWidget({ spec, value, onChange }: WidgetProps) {
  const t = useI18n((s) => s.t);
  const kb =
    value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as { kind?: string; rows?: unknown[]; one_time?: boolean })
      : undefined;
  const kind = kb?.kind ?? '';
  const id = useId();

  const setKind = (next: string) => {
    if (next === '') return onChange(undefined);
    if (next === 'remove') return onChange({ kind: 'remove' });
    if (next === 'inline')
      return onChange({ kind: 'inline', rows: [[{ text: '', kind: 'callback', value: '' }]] });
    return onChange({ kind: 'reply', rows: [['']], one_time: true });
  };

  return (
    <div className="kb-widget">
      <select id={id} value={kind} onChange={(e) => setKind(e.target.value)}>
        {!spec.required || kind === '' ? <option value="">{t('form.kb.none')}</option> : null}
        <option value="inline">{t('form.kb.inline')}</option>
        <option value="reply">{t('form.kb.reply')}</option>
        <option value="remove">{t('form.kb.remove')}</option>
      </select>

      {kind === 'inline' ? (
        <InlineKbGrid
          rows={(kb?.rows ?? []) as KbInlineButton[][]}
          onChange={(rows) => onChange({ kind: 'inline', rows })}
        />
      ) : null}

      {kind === 'reply' ? (
        <>
          <ReplyKbGrid
            rows={(kb?.rows ?? []) as string[][]}
            onChange={(rows) => onChange({ kind: 'reply', rows, one_time: kb?.one_time ?? true })}
          />
          <label className="bool-widget inline">
            <input
              type="checkbox"
              checked={kb?.one_time !== false}
              onChange={(e) => onChange({ kind: 'reply', rows: kb?.rows ?? [['']], one_time: e.target.checked })}
            />
            {t('form.kb.oneTime')}
          </label>
        </>
      ) : null}
    </div>
  );
}

function InlineKbGrid({
  rows,
  onChange,
}: {
  rows: KbInlineButton[][];
  onChange: (rows: KbInlineButton[][]) => void;
}) {
  const t = useI18n((s) => s.t);
  const setBtn = (r: number, c: number, patch: Partial<KbInlineButton>) =>
    onChange(rows.map((row, i) => (i === r ? row.map((b, j) => (j === c ? { ...b, ...patch } : b)) : row)));
  return (
    <div className="kb-grid">
      {rows.map((row, r) => (
        <div className="kb-row" key={r}>
          {row.map((btn, c) => (
            <div className="kb-btn" key={c}>
              <input
                type="text"
                value={btn.text ?? ''}
                placeholder={t('form.kb.btnText')}
                onChange={(e) => setBtn(r, c, { text: e.target.value })}
                dir="auto"
              />
              <select value={btn.kind ?? 'callback'} onChange={(e) => setBtn(r, c, { kind: e.target.value })}>
                <option value="callback">callback</option>
                <option value="url">url</option>
                <option value="web_app">web_app</option>
              </select>
              <input
                type="text"
                value={btn.value ?? ''}
                placeholder={(btn.kind ?? 'callback') === 'callback' ? t('form.kb.btnKey') : 'https://…'}
                onChange={(e) => setBtn(r, c, { value: e.target.value })}
                dir="ltr"
              />
              <button type="button" className="ghost sm danger" title={t('form.removeRow')}
                onClick={() => {
                  const nextRow = row.filter((_, j) => j !== c);
                  onChange(nextRow.length === 0 ? rows.filter((_, i) => i !== r) : rows.map((rr, i) => (i === r ? nextRow : rr)));
                }}>✕</button>
            </div>
          ))}
          <button type="button" className="ghost sm" onClick={() => onChange(rows.map((rr, i) => (i === r ? [...rr, { text: '', kind: 'callback', value: '' }] : rr)))}>
            + {t('form.kb.addButton')}
          </button>
        </div>
      ))}
      <button type="button" className="ghost add-row" onClick={() => onChange([...rows, [{ text: '', kind: 'callback', value: '' }]])}>
        + {t('form.kb.addRow')}
      </button>
    </div>
  );
}

function ReplyKbGrid({ rows, onChange }: { rows: string[][]; onChange: (rows: string[][]) => void }) {
  const t = useI18n((s) => s.t);
  return (
    <div className="kb-grid">
      {rows.map((row, r) => (
        <div className="kb-row" key={r}>
          {row.map((cell, c) => (
            <span className="kb-btn" key={c}>
              <input
                type="text"
                value={cell}
                placeholder={t('form.kb.btnText')}
                onChange={(e) => onChange(rows.map((rr, i) => (i === r ? rr.map((cc, j) => (j === c ? e.target.value : cc)) : rr)))}
                dir="auto"
              />
              <button type="button" className="ghost sm danger" title={t('form.removeRow')}
                onClick={() => {
                  const nextRow = row.filter((_, j) => j !== c);
                  onChange(nextRow.length === 0 ? rows.filter((_, i) => i !== r) : rows.map((rr, i) => (i === r ? nextRow : rr)));
                }}>✕</button>
            </span>
          ))}
          <button type="button" className="ghost sm" onClick={() => onChange(rows.map((rr, i) => (i === r ? [...rr, ''] : rr)))}>
            + {t('form.kb.addButton')}
          </button>
        </div>
      ))}
      <button type="button" className="ghost add-row" onClick={() => onChange([...rows, ['']])}>
        + {t('form.kb.addRow')}
      </button>
    </div>
  );
}

// ── IF condition rows ────────────────────────────────────────────────────────

const NO_VALUE2 = new Set(['exists', 'is_empty']);

interface CondRow {
  value1?: unknown;
  operator?: string;
  value2?: unknown;
}

function ConditionsWidget({ spec, value, onChange }: WidgetProps) {
  const t = useI18n((s) => s.t);
  const operators = (spec.schema.items?.properties?.operator?.enum ?? []) as string[];
  const rows: CondRow[] = Array.isArray(value) ? (value as CondRow[]) : [];
  const setRow = (i: number, patch: Partial<CondRow>) =>
    onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <div className="cond-widget">
      {rows.map((row, i) => {
        const op = row.operator ?? operators[0] ?? 'equals';
        return (
          <div className="cond-row" key={i}>
            <ExpressionInput
              value={row.value1 === undefined ? '' : String(row.value1)}
              placeholder="{{ $json.value }}"
              onChange={(v) => setRow(i, { value1: v })}
            />
            <select value={op} onChange={(e) => setRow(i, { operator: e.target.value, ...(NO_VALUE2.has(e.target.value) ? { value2: undefined } : {}) })}>
              {operators.map((o) => {
                const k = `form.cond.op.${o}`;
                const msg = t(k as MessageKey);
                return (
                  <option key={o} value={o}>
                    {msg === k ? o : msg}
                  </option>
                );
              })}
            </select>
            {!NO_VALUE2.has(op) ? (
              <ExpressionInput
                value={row.value2 === undefined ? '' : String(row.value2)}
                onChange={(v) => setRow(i, { value2: v })}
              />
            ) : (
              <span className="cond-noval">—</span>
            )}
            <button type="button" className="ghost sm danger" title={t('form.removeRow')}
              onClick={() => onChange(rows.filter((_, j) => j !== i))}>✕</button>
          </div>
        );
      })}
      <button type="button" className="ghost add-row"
        onClick={() => onChange([...rows, { value1: '', operator: operators[0] ?? 'equals', value2: '' }])}>
        + {t('form.cond.add')}
      </button>
    </div>
  );
}

// ── field row + dispatch ─────────────────────────────────────────────────────

export function FieldRow({
  label,
  required,
  inline = false,
  children,
}: {
  label: string;
  required: boolean;
  inline?: boolean;
  children: ReactNode;
}) {
  return (
    <div className={`field-row${inline ? ' inline' : ''}`}>
      <label className="field-label">
        {label}
        {required ? <span className="req">*</span> : null}
      </label>
      <div className="field-input">{children}</div>
    </div>
  );
}

export function SchemaWidget(props: WidgetProps) {
  switch (props.spec.widget) {
    case 'boolean':
      return <BooleanWidget {...props} />;
    case 'number':
      return <NumberWidget {...props} />;
    case 'select':
      return <SelectWidget {...props} />;
    case 'duration':
      return <DurationWidget {...props} />;
    case 'multiline':
      return <TextWidget {...props} multiline />;
    case 'object':
      return <ObjectWidget {...props} />;
    case 'rows':
      return <RowsWidget {...props} />;
    case 'union':
      return <UnionWidget {...props} />;
    case 'keyboard':
      return <KeyboardWidget {...props} />;
    case 'conditions':
      return <ConditionsWidget {...props} />;
    case 'expression':
    case 'text':
    default:
      return <TextWidget {...props} />;
  }
}
