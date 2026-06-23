/**
 * SchemaForm (P2-T3) — the form-engine entry point.
 *
 * Renders an editable form for ANY object JSON Schema (node params today,
 * Collection records in Phase 3.5 — PLAN's architecture note: importable
 * independently of the node panel; nothing in this file knows about nodes,
 * flows or the canvas).
 *
 * Controlled: `value` in, `onChange(next)` out on every edit. The caller
 * decides when/where to persist (the node param panel debounce-commits into
 * the canvas store; a Collection form will POST on submit).
 *
 * Progressive disclosure (n8n behaviour): only REQUIRED fields (and optional
 * fields the user has already filled) are shown by default. The rest live
 * behind a "+ Add option" menu so a node never looks cluttered with dozens of
 * fields a beginner doesn't need. Removing an added optional field (×) returns
 * it to the menu. The split is purely structural (see `partitionFields`), so
 * it applies to every node and to Collection forms automatically.
 */
import { useMemo, useState } from 'react';
import {
  useDesc,
  useLabel,
  FieldRow,
  FormNamespace,
  PreviewScopeProvider,
  SchemaWidget,
  AddOptionControl,
} from './widgets';
import type { PreviewScope } from './preview';
import {
  partitionFields,
  anyAdvancedSet,
  emptyValue,
  type FieldSpec,
  type JsonSchema,
} from './schema';
import { setAtPath } from './model';
import { useI18n } from '../i18n';

function FormBody({
  schema,
  value,
  onChange,
}: {
  schema: JsonSchema;
  value: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
}) {
  const t = useI18n((s) => s.t);
  const label = useLabel();
  const desc = useDesc();

  // Optional fields the user opted into this session via "+ Add option". These
  // stay visible even while still blank (an empty string isn't "set"), so a
  // freshly-added field doesn't vanish on the next render. A filled field is
  // already visible via isSet, so this only matters for not-yet-typed ones.
  const [added, setAdded] = useState<ReadonlySet<string>>(() => new Set());

  const { shown, optional, advanced } = useMemo(
    () => partitionFields(schema, value, added),
    [schema, value, added],
  );

  if (shown.length === 0 && optional.length === 0 && advanced.length === 0) {
    return <p className="form-empty">{t('form.noParams')}</p>;
  }

  const setField = (key: string, v: unknown) =>
    onChange(setAtPath(value, [key], v) as Record<string, unknown>);

  // Add an optional field: seed it with an empty value AND mark it added so it
  // stays in the shown list even before the user types. emptyValue gives '' for
  // strings / [] for arrays / the default for enums — i.e. an editable blank.
  const addOption = (spec: FieldSpec) => {
    setAdded((prev) => new Set(prev).add(spec.key));
    setField(spec.key, emptyValue(spec.schema));
  };

  // Remove an added optional field: unset it AND drop it from `added` so it
  // returns to the add-menu. (Any non-required shown field is removable.)
  const removeOption = (key: string) => {
    setAdded((prev) => {
      if (!prev.has(key)) return prev;
      const next = new Set(prev);
      next.delete(key);
      return next;
    });
    setField(key, undefined);
  };

  // One field row — shared by the always-shown set and the Advanced section so
  // a field renders identically wherever it lives. `removable` is false inside
  // the Advanced section: those fields are author-exposed, not user-added, so
  // there is no "×" to return them to a menu (they always belong to the node).
  const renderField = (spec: FieldSpec, removable: boolean) => (
    <FieldRow
      key={spec.key}
      label={label(spec.key)}
      required={spec.required}
      desc={desc(spec.key)}
      inline={spec.widget === 'boolean'}
      onRemove={removable && !spec.required ? () => removeOption(spec.key) : undefined}
      removeLabel={t('form.removeOption')}
    >
      <SchemaWidget spec={spec} value={value[spec.key]} onChange={(v) => setField(spec.key, v)} />
    </FieldRow>
  );

  return (
    <div className="schema-form">
      {shown.map((spec) => renderField(spec, true))}
      <AddOptionControl
        options={optional}
        onAdd={(key) => {
          const spec = optional.find((s) => s.key === key);
          if (spec) addOption(spec);
        }}
      />
      {advanced.length > 0 && (
        // Native <details> = zero-JS collapsible, keyboard-accessible by
        // default. Opens automatically when an advanced field already carries a
        // value (anyAdvancedSet) so editing an existing node never hides the
        // user's own data behind a closed flap. `key` forces a remount when the
        // auto-open verdict flips, so the default-open reflects the latest data.
        <details
          className="form-advanced"
          key={anyAdvancedSet(advanced, value) ? 'adv-open' : 'adv-closed'}
          open={anyAdvancedSet(advanced, value)}
        >
          <summary className="form-advanced-summary">{t('form.advanced.title')}</summary>
          <div className="form-advanced-body">
            {advanced.map((spec) => renderField(spec, false))}
          </div>
        </details>
      )}
    </div>
  );
}

export function SchemaForm({
  schema,
  value,
  onChange,
  namespace = '',
  previewScope = null,
}: {
  schema: JsonSchema;
  value: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
  /**
   * Optional i18n namespace (e.g. the node type) so param key names that are
   * reused across nodes with different meanings — `mode`, `target` — resolve
   * a node-specific `paramDesc.<namespace>.<key>` before the shared bare key.
   * Empty (the default) preserves the legacy node-agnostic behaviour.
   */
  namespace?: string;
  /**
   * Optional live-preview scope (G-T2). When provided, every ExpressionInput
   * previews its `{{ … }}` against this data. `null` (default) → no preview,
   * so generic consumers (Collection forms) are unchanged.
   */
  previewScope?: PreviewScope | null;
}) {
  return (
    <FormNamespace value={namespace}>
      <PreviewScopeProvider value={previewScope}>
        <FormBody schema={schema} value={value} onChange={onChange} />
      </PreviewScopeProvider>
    </FormNamespace>
  );
}
