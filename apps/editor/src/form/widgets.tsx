/**
 * Widget renderers (P2-T3) — the visual half of the form engine.
 *
 * Every widget edits ONE schema node: it receives the current value and an
 * onChange with the next value (undefined = unset). Widgets never know which
 * node type they belong to — they are keyed by structural WidgetKind
 * (see schema.ts), so Phase 3.5 Collection forms reuse them as-is.
 */
import {
  createContext,
  lazy,
  Suspense,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type DragEvent,
  type ReactNode,
} from 'react';
import { CREDENTIAL_TYPE_LABELS } from '@ctb/shared';
import { useI18n, type MessageKey } from '../i18n';
import { useCanvas } from '../stores/canvas';
import { useCollections } from '../stores/collections';
import { useCredentials } from '../stores/credentials';
import { useFlows } from '../stores/flows';
import { FIELD_DRAG_MIME, SCOPE_HINTS, hasExpression, insertHint } from './expression';
import {
  convertBranchValue,
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

/**
 * Optional namespace for i18n key resolution. Param key names (`mode`,
 * `target`, …) are reused across node types with DIFFERENT meanings, so a
 * bare `paramDesc.mode` collides (flow.wait vs flow.merge vs data.code …).
 * The node panel sets this to the node type so resolvers try the namespaced
 * key (`paramDesc.<ns>.<key>`) first and fall back to the bare key. Generic
 * consumers (Collection forms) leave it empty → identical legacy behaviour.
 */
const NsContext = createContext<string>('');
export const FormNamespace = NsContext.Provider;
function useNs(): string {
  return useContext(NsContext);
}

/**
 * Resolve an i18n key with optional namespace fallback:
 * `<base>.<ns>.<key>` → `<base>.<key>` → undefined (when neither exists).
 */
function resolveNs(
  t: (key: MessageKey) => string,
  base: string,
  ns: string,
  key: string,
): string | undefined {
  if (ns) {
    const nsKey = `${base}.${ns}.${key}`;
    const nsMsg = t(nsKey as MessageKey);
    if (nsMsg !== nsKey) return nsMsg;
  }
  const k = `${base}.${key}`;
  const msg = t(k as MessageKey);
  return msg === k ? undefined : msg;
}

/** Param label: i18n `param.<ns>.<key>` → `param.<key>`, humanized otherwise. */
export function useLabel(): (key: string) => string {
  const t = useI18n((s) => s.t);
  const ns = useNs();
  return (key: string) => resolveNs(t, 'param', ns, key) ?? humanize(key);
}

/** Param help text: i18n `paramDesc.<ns>.<key>` → `paramDesc.<key>`, nothing otherwise. */
export function useDesc(): (key: string) => string | undefined {
  const t = useI18n((s) => s.t);
  const ns = useNs();
  return (key: string) => resolveNs(t, 'paramDesc', ns, key);
}

/** Example placeholder: i18n `ph.<ns>.<key>` → `ph.<key>` when present. */
function usePlaceholder(): (key: string) => string | undefined {
  const t = useI18n((s) => s.t);
  const ns = useNs();
  return (key: string) => resolveNs(t, 'ph', ns, key);
}

// ── expression-aware text input ──────────────────────────────────────────────
// Expression presence is signalled by an accent border + colored {x} badge.
// (A per-segment highlight OVERLAY was tried and removed: with mixed
// Persian/{{ }} bidi text the overlay's separate spans wrap/order differently
// from the input's plain text, so highlights drifted — worse than no highlight.)

const HINTS_WIDTH = 250;
const HINTS_MAX_HEIGHT = 230;

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
  // The hints dropdown renders position:fixed at viewport coordinates so the
  // narrow side-panel / scroll containers can never clip it (the previous
  // absolute-in-panel version overflowed the 320px panel and was unreadable).
  const [hintsPos, setHintsPos] = useState<{ top: number; left: number } | null>(null);
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const fxRef = useRef<HTMLButtonElement | null>(null);

  const toggleHints = () => {
    if (hintsPos) return setHintsPos(null);
    const anchor = fxRef.current?.getBoundingClientRect();
    if (!anchor) return;
    const left = Math.max(8, Math.min(anchor.right - HINTS_WIDTH, window.innerWidth - HINTS_WIDTH - 8));
    const below = anchor.bottom + 4;
    const top =
      below + HINTS_MAX_HEIGHT > window.innerHeight
        ? Math.max(8, anchor.top - 4 - HINTS_MAX_HEIGHT)
        : below;
    setHintsPos({ top, left });
  };

  // Open dropdown: close on outside pointer-down, Escape, or any scroll
  // (scrolling would strand the fixed-position list away from its anchor).
  useEffect(() => {
    if (!hintsPos) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setHintsPos(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setHintsPos(null);
    };
    const onScroll = (e: Event) => {
      // ignore scrolls inside the dropdown itself
      if (rootRef.current?.querySelector('.expr-hints')?.contains(e.target as Node)) return;
      setHintsPos(null);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKey);
    document.addEventListener('scroll', onScroll, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('scroll', onScroll, true);
    };
  }, [hintsPos]);

  const pickHint = (name: string) => {
    const input = inputRef.current;
    const caret = input?.selectionStart ?? value.length;
    const next = insertHint(value, caret, name);
    onChange(next.text);
    setHintsPos(null);
    requestAnimationFrame(() => {
      input?.focus();
      input?.setSelectionRange(next.caret, next.caret);
    });
  };

  // ── drag-to-map (P2-T3.5): drop a field from the data panel → insert its
  // {{ $json.path }} expression at the caret (empty field = replace wholesale).
  const [dropActive, setDropActive] = useState(false);
  const onDragOver = (e: DragEvent) => {
    if (e.dataTransfer.types.includes(FIELD_DRAG_MIME)) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      setDropActive(true);
    }
  };
  const onDrop = (e: DragEvent) => {
    const expr = e.dataTransfer.getData(FIELD_DRAG_MIME);
    setDropActive(false);
    if (!expr) return;
    e.preventDefault();
    const input = inputRef.current;
    const caret = input?.selectionStart ?? value.length;
    const next = value === '' ? expr : value.slice(0, caret) + expr + value.slice(caret);
    const nextCaret = (value === '' ? expr.length : caret + expr.length);
    onChange(next);
    requestAnimationFrame(() => {
      input?.focus();
      input?.setSelectionRange(nextCaret, nextCaret);
    });
  };

  const cls = `expr-input${hasExpression(value) ? ' has-expr' : ''}${multiline ? ' multiline' : ''}${dropActive ? ' drop-active' : ''}`;
  return (
    <div
      className={cls}
      ref={rootRef}
      onDragOver={onDragOver}
      onDragLeave={() => setDropActive(false)}
      onDrop={onDrop}
    >
      <div className="expr-box">
        {multiline ? (
          <textarea
            ref={(el) => void (inputRef.current = el)}
            value={value}
            placeholder={placeholder}
            rows={3}
            onChange={(e) => onChange(e.target.value)}
            dir="auto"
          />
        ) : (
          <input
            ref={(el) => void (inputRef.current = el)}
            type="text"
            value={value}
            placeholder={placeholder}
            onChange={(e) => onChange(e.target.value)}
            dir="auto"
          />
        )}
      </div>
      <button
        ref={fxRef}
        type="button"
        className="expr-fx ghost"
        title={t('form.expr.hints')}
        onClick={toggleHints}
      >
        {'{x}'}
      </button>
      {hintsPos ? (
        <ul
          className="expr-hints"
          role="listbox"
          style={{ top: hintsPos.top, left: hintsPos.left, width: HINTS_WIDTH, maxHeight: HINTS_MAX_HEIGHT }}
        >
          <li className="expr-hints-title" aria-hidden>
            {t('form.expr.hintsTitle')}
          </li>
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

// ── code widget (CodeMirror, lazy — only data.code pays its bundle cost) ────

const LazyCodeWidget = lazy(() =>
  import('./CodeWidget').then((m) => ({ default: m.CodeWidget })),
);

function CodeFieldWidget({ value, onChange }: WidgetProps) {
  return (
    <Suspense fallback={<div className="code-widget-loading" data-testid="code-widget-loading" />}>
      <LazyCodeWidget
        value={value === undefined || value === null ? '' : String(value)}
        onChange={(v) => onChange(v)}
      />
    </Suspense>
  );
}

// ── flow reference widget (sibling-flow selector, flow.executeSubFlow P3-T1) ──
//
// Lists the other flows of the SAME bot (the current flow is excluded — a flow
// calling itself directly is rejected by the node anyway). Structural in the
// same sense as `code`: keyed by the schema's `ctbWidget` annotation, not by a
// node-type lookup, so any future param can reuse it. Reads the editor stores
// directly (like a structural widget that needs ambient context) — the value
// it edits is still just the selected flow's id string.

function FlowRefWidget({ spec, value, onChange }: WidgetProps) {
  const t = useI18n((s) => s.t);
  const currentFlowId = useCanvas((s) => s.flowId);
  const flows = useFlows((s) => s.flows);
  const current = typeof value === 'string' ? value : '';
  // Sibling flows only; never offer the current flow as a target.
  const options = flows.filter((f) => f.id !== currentFlowId);
  // Selected id no longer in the list (deleted / different bot) → still show it
  // so the user sees the dangling reference rather than a silent reset.
  const orphaned = current !== '' && !options.some((f) => f.id === current);
  return (
    <select
      className="flowref-widget"
      value={current}
      onChange={(e) => onChange(e.target.value === '' ? undefined : e.target.value)}
    >
      {!spec.required || current === '' ? (
        <option value="">{t('form.flowRef.none')}</option>
      ) : null}
      {options.map((f) => (
        <option key={f.id} value={f.id}>
          {f.name}
        </option>
      ))}
      {orphaned ? (
        <option value={current}>{t('form.flowRef.missing')}</option>
      ) : null}
    </select>
  );
}

// ── credential reference widget (stored-credential selector, http.request P3-T4) ──
//
// Lists the saved credentials so a node can bind one by id. Structural like
// `flowRef`/`code` — keyed by the schema's `ctbWidget` annotation, never by node
// type, so any future param needing an auth credential reuses it. The value it
// edits is just the selected credential's id string; the secret never reaches
// here (invariant I7). Lazily loads the store the first time it mounts.

function CredentialRefWidget({ spec, value, onChange }: WidgetProps) {
  const t = useI18n((s) => s.t);
  const creds = useCredentials((s) => s.credentials);
  const loadCreds = useCredentials((s) => s.load);
  useEffect(() => {
    if (creds.length === 0) void loadCreds();
    // load is stable; we only want a single fetch on first mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const current = typeof value === 'string' ? value : '';
  // A field may pin the credential TYPE it accepts (z.meta({ credentialType }))
  // — e.g. ai.llmChat only takes `openAiApi`. When present we offer only those,
  // so the user can't bind an HTTP-auth credential to an LLM node. Unannotated
  // fields (http.request) keep listing everything.
  const wantType =
    typeof spec.schema.credentialType === 'string' ? spec.schema.credentialType : undefined;
  const options = wantType ? creds.filter((c) => c.type === wantType) : creds;
  // Selected id no longer present (deleted, or filtered out by type) → still show
  // it so the user sees the dangling reference rather than a silent reset.
  const orphaned = current !== '' && !options.some((c) => c.id === current);
  return (
    <select
      className="credref-widget"
      value={current}
      onChange={(e) => onChange(e.target.value === '' ? undefined : e.target.value)}
    >
      <option value="">{t('credentials.none')}</option>
      {options.map((c) => (
        <option key={c.id} value={c.id}>
          {c.name} · {CREDENTIAL_TYPE_LABELS[c.type]}
        </option>
      ))}
      {orphaned ? <option value={current}>{t('form.credentialRef.missing')}</option> : null}
    </select>
  );
}

// ── collection reference widget (collection-slug selector, P3.5-T5) ───────────
//
// Lists this bot's Collections so `data.collection` / `collection.recordChanged`
// can bind one by SLUG (the value stored is the slug, never an internal id — so
// templates/exports stay portable). Structural like `flowRef`/`credentialRef`:
// keyed by the schema's `ctbWidget` annotation, never by node type, so it stays
// domain-agnostic (invariant I2 — it offers whatever collections exist, with no
// idea whether they're products or recipes). The bot is taken from the flows
// store (the editor only ever edits one bot's flows at a time); the collections
// store is lazily loaded for that bot the first time the widget mounts.

function CollectionRefWidget({ spec, value, onChange }: WidgetProps) {
  const t = useI18n((s) => s.t);
  const botId = useFlows((s) => s.botId);
  const collections = useCollections((s) => s.collections);
  const loadedBotId = useCollections((s) => s.botId);
  const loadCollections = useCollections((s) => s.load);
  useEffect(() => {
    // Load (or re-load) when the active bot differs from what the store holds.
    if (botId && loadedBotId !== botId) void loadCollections(botId);
    // load is stable; re-run only when the bot changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [botId, loadedBotId]);
  const current = typeof value === 'string' ? value : '';
  // Selected slug no longer present (renamed / different bot) → still show it so
  // the user sees the dangling reference rather than a silent reset.
  const orphaned = current !== '' && !collections.some((c) => c.slug === current);
  return (
    <select
      className="collectionref-widget"
      value={current}
      onChange={(e) => onChange(e.target.value === '' ? undefined : e.target.value)}
    >
      {!spec.required || current === '' ? (
        <option value="">{t('form.collectionRef.none')}</option>
      ) : null}
      {collections.map((c) => (
        <option key={c.id} value={c.slug}>
          {c.name} · {c.slug}
        </option>
      ))}
      {orphaned ? <option value={current}>{t('form.collectionRef.missing')}</option> : null}
    </select>
  );
}

function TextWidget({ spec, value, onChange, multiline }: WidgetProps & { multiline?: boolean }) {
  const placeholder = usePlaceholder();
  return (
    <ExpressionInput
      value={value === undefined || value === null ? '' : String(value)}
      onChange={(v) => onChange(v === '' && !spec.required ? undefined : v)}
      multiline={multiline}
      placeholder={placeholder(spec.key)}
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
  const t = useI18n((s) => s.t);
  const ns = useNs();
  const options = spec.schema.enum ?? [];
  // Unset + schema default → SHOW the default (n8n behaviour: the user sees
  // what the engine will actually do). The value itself stays unset — Zod
  // applies the same default server-side.
  const effective = value === undefined ? spec.schema.default : value;
  const current = effective === undefined ? '' : String(effective);
  /** Translated option label (`option.<ns>.<param>.<value>` → `option.<param>.<value>`). */
  const optionLabel = (o: string | number): string =>
    resolveNs(t, 'option', ns, `${spec.key}.${String(o)}`) ?? String(o);
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
          {optionLabel(o)}
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
  const desc = useDesc();
  const obj =
    value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  return (
    <div className="object-widget">
      {objectFields(spec.schema).map((child) => (
        <FieldRow key={child.key} label={label(child.key)} required={child.required} desc={desc(child.key)} inline={child.widget === 'boolean'}>
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
  // The chosen branch is LOCAL UI STATE seeded from the value. Deriving it
  // from the value on every render caused the reported snap-back: switching
  // to "advanced" produced {text:''}, the debounced commit pruned the empty
  // object away, and the re-derived tab jumped back to "simple".
  const [chosen, setChosen] = useState(() => matchBranch(spec.schema, value));
  const valueBranch = matchBranch(spec.schema, value);
  useEffect(() => {
    // Adopt the value's branch only when a real value decisively points at a
    // different branch (undo/redo / external edits). Empty values stay put.
    if (value !== undefined && value !== '' && valueBranch !== chosen) setChosen(valueBranch);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [valueBranch]);
  const branchLabel = (b: FieldSpec, i: number): string =>
    b.schema.type === 'string' || b.schema.type === 'number'
      ? t('form.union.simple')
      : `${t('form.union.advanced')}${branches.length > 2 ? ` ${i + 1}` : ''}`;
  const branch = branches[Math.min(chosen, branches.length - 1)];
  return (
    <div className="union-widget">
      <div className="union-tabs" role="tablist">
        {branches.map((b, i) => (
          <button
            key={i}
            type="button"
            role="tab"
            aria-selected={i === chosen}
            className={i === chosen ? 'active' : ''}
            onClick={() => {
              if (i === chosen) return;
              setChosen(i);
              // convertBranchValue preserves the user's text across the
              // simple⇔advanced switch instead of wiping it.
              onChange(convertBranchValue(b.schema, value));
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
            <div className="cond-v1">
              <ExpressionInput
                value={row.value1 === undefined ? '' : String(row.value1)}
                placeholder="{{ $vars.age }}"
                onChange={(v) => setRow(i, { value1: v })}
              />
            </div>
            <button type="button" className="ghost sm danger cond-del" title={t('form.removeRow')}
              onClick={() => onChange(rows.filter((_, j) => j !== i))}>✕</button>
            <div className="cond-op">
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
            </div>
            {!NO_VALUE2.has(op) ? (
              <div className="cond-v2">
                <ExpressionInput
                  value={row.value2 === undefined ? '' : String(row.value2)}
                  placeholder="18"
                  onChange={(v) => setRow(i, { value2: v })}
                />
              </div>
            ) : null}
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
  desc,
  inline = false,
  children,
}: {
  label: string;
  required: boolean;
  desc?: string | undefined;
  inline?: boolean;
  children: ReactNode;
}) {
  return (
    <div className={`field-row${inline ? ' inline' : ''}`}>
      <div className="field-head">
        <label className="field-label">
          {label}
          {required ? <span className="req">*</span> : null}
        </label>
        {desc ? <span className="field-desc">{desc}</span> : null}
      </div>
      <div className="field-input">{children}</div>
    </div>
  );
}

export function SchemaWidget(props: WidgetProps) {
  switch (props.spec.widget) {
    case 'code':
      return <CodeFieldWidget {...props} />;
    case 'flowRef':
      return <FlowRefWidget {...props} />;
    case 'credentialRef':
      return <CredentialRefWidget {...props} />;
    case 'collectionRef':
      return <CollectionRefWidget {...props} />;
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
