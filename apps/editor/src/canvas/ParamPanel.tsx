/**
 * Param side-panel (P2-T3) — node configuration UI.
 *
 * Shows when exactly one node is selected: renders the form engine over the
 * node type's paramsJsonSchema, plus node-level controls (enable/disable,
 * note). Edits are committed to the canvas store with a short debounce so
 * keystrokes don't flood undo history / autosave — a field-blur or panel
 * close flushes immediately.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { FlowNode } from '@ctb/shared';
import { useI18n, type MessageKey } from '../i18n';
import { pruneEmpty } from '../form/model';
import { SchemaForm } from '../form/SchemaForm';
import type { JsonSchema } from '../form/schema';
import { useCanvas } from '../stores/canvas';
import { useSelection } from './FlowCanvas';

const COMMIT_MS = 600;

function PanelInner({ node }: { node: FlowNode }) {
  const t = useI18n((s) => s.t);
  const byType = useCanvas((s) => s.byType);
  const info = byType.get(node.type);

  // Draft params: local while typing, committed (pruned) to the store after
  // a debounce. Re-seeded when the selected node changes or undo/redo swaps
  // the document under us.
  const [draft, setDraft] = useState<Record<string, unknown>>(node.params);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const nodeId = node.id;

  // External change (undo/redo/another command) → adopt unless mid-edit.
  useEffect(() => {
    if (timer.current === null) setDraft(node.params);
  }, [node.params]);
  useEffect(() => {
    setDraft(node.params);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodeId]);

  const commit = useCallback(
    (params: Record<string, unknown>) => {
      if (timer.current) {
        clearTimeout(timer.current);
        timer.current = null;
      }
      useCanvas.getState().updateNode(nodeId, { params: pruneEmpty(params) as Record<string, unknown> });
    },
    [nodeId],
  );

  const onFormChange = useCallback(
    (next: Record<string, unknown>) => {
      setDraft(next);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        timer.current = null;
        commit(next);
      }, COMMIT_MS);
    },
    [commit],
  );

  // Unmount (deselect/navigate) flushes a pending commit.
  useEffect(
    () => () => {
      if (timer.current) {
        clearTimeout(timer.current);
        timer.current = null;
        useCanvas
          .getState()
          .updateNode(nodeId, { params: pruneEmpty(draftRef.current) as Record<string, unknown> });
      }
    },
    [nodeId],
  );

  const label = info ? t(info.meta.labelKey as MessageKey) : node.type;

  return (
    <aside className="param-panel" data-testid="param-panel">
      <div className="param-head">
        <strong>{label}</strong>
        <span className="ctb-node-id">{node.id}</span>
      </div>

      {info ? (
        <SchemaForm schema={info.paramsJsonSchema as JsonSchema} value={draft} onChange={onFormChange} />
      ) : (
        <p className="alert">{t('editor.node.unknownType')}</p>
      )}

      <hr className="param-sep" />

      <div className="field-row inline">
        <label className="field-label">{t('panel.enabled')}</label>
        <div className="field-input">
          <input
            type="checkbox"
            checked={!node.disabled}
            onChange={(e) => useCanvas.getState().updateNode(nodeId, { disabled: !e.target.checked })}
          />
        </div>
      </div>
      <div className="field-row">
        <label className="field-label">{t('panel.note')}</label>
        <div className="field-input">
          <textarea
            rows={2}
            value={node.note ?? ''}
            dir="auto"
            onChange={(e) =>
              useCanvas.getState().updateNode(nodeId, { note: e.target.value === '' ? undefined : e.target.value })
            }
          />
        </div>
      </div>
    </aside>
  );
}

export function ParamPanel() {
  const selected = useSelection((s) => s.nodes);
  const graph = useCanvas((s) => s.graph);
  if (selected.size !== 1) return null;
  const id = [...selected][0]!;
  const node = graph.nodes.find((n) => n.id === id);
  if (!node) return null;
  // key remounts the inner panel per node → clean draft state per selection
  return <PanelInner key={node.id} node={node} />;
}
