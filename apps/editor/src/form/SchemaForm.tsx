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
 */
import { useDesc, useLabel, FieldRow, SchemaWidget } from './widgets';
import { objectFields, type JsonSchema } from './schema';
import { setAtPath } from './model';
import { useI18n } from '../i18n';

export function SchemaForm({
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
  const fields = objectFields(schema);
  if (fields.length === 0) {
    return <p className="form-empty">{t('form.noParams')}</p>;
  }
  return (
    <div className="schema-form">
      {fields.map((spec) => (
        <FieldRow key={spec.key} label={label(spec.key)} required={spec.required} desc={desc(spec.key)} inline={spec.widget === 'boolean'}>
          <SchemaWidget
            spec={spec}
            value={value[spec.key]}
            onChange={(v) => onChange(setAtPath(value, [spec.key], v) as Record<string, unknown>)}
          />
        </FieldRow>
      ))}
    </div>
  );
}
