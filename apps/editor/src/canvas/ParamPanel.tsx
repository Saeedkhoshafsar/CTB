/**
 * Param side-panel (P2-T3) — node configuration UI.
 *
 * Shows when exactly one node is selected: renders the form engine over the
 * node type's paramsJsonSchema, plus node-level controls (enable/disable,
 * note). Edits are committed to the canvas store with a short debounce so
 * keystrokes don't flood undo history / autosave — a field-blur or panel
 * close flushes immediately.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FlowNode } from '@ctb/shared';
import { useI18n, type MessageKey } from '../i18n';
import { pruneEmpty } from '../form/model';
import { SchemaForm } from '../form/SchemaForm';
import type { JsonSchema } from '../form/schema';
import { useCanvas } from '../stores/canvas';
import { useRunData } from '../stores/run-data';
import { nodeDisplayName } from './graph';
import { useSelection } from './FlowCanvas';
import { useNodeDetail } from './NodeDetail';
import { DataPanel } from './DataPanel';
import { ErrorBoundary } from '../components/ErrorBoundary';

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

  const typeLabel = info ? t(info.meta.labelKey as MessageKey) : node.type;
  // H-T2: the panel header shows the node's human title when set, else type.
  const displayName = nodeDisplayName(node, typeLabel);
  // node-level help: `nodeDesc.<type>` — what the node does, in one line.
  const descKey = `nodeDesc.${node.type}`;
  const descMsg = t(descKey as MessageKey);
  const nodeDesc = descMsg === descKey ? null : descMsg;

  // n8n-parity: surface the node's INPUT (what fed it) and OUTPUT (what it
  // emitted) from the latest run right in the side panel, so the user always
  // sees "the previous node's data" — the #1 complaint. Full three-pane view is
  // one click away ("Full view"), which opens the NDV.
  const run = useRunData((s) => s.byNode.get(node.id));
  const execution = useRunData((s) => s.execution);
  const hasInputs = (info?.ports.inputs.length ?? 1) > 0;
  const openFull = useNodeDetail((s) => s.open);
  const dataEmptyMsg = useMemo(
    () => (execution ? t('data.emptyNode') : t('data.noRun')),
    [execution, t],
  );

  return (
    <aside className="param-panel" data-testid="param-panel">
      <div className="param-head">
        <strong dir="auto">{displayName}</strong>
        <span className="ctb-node-id">{node.id}</span>
      </div>
      {nodeDesc ? <p className="param-desc">{nodeDesc}</p> : null}

      {info ? (
        <SchemaForm
          schema={info.paramsJsonSchema as JsonSchema}
          value={draft}
          onChange={onFormChange}
          namespace={node.type}
        />
      ) : (
        <p className="alert">{t('editor.node.unknownType')}</p>
      )}

      <div className="panel-data">
        <div className="panel-data-toggle">
          <strong>{t('panel.data.title')}</strong>
          <button
            type="button"
            className="ndv-link"
            title={t('panel.data.openFullHint')}
            onClick={() => openFull(node.id)}
          >
            {t('panel.data.openFull')}
          </button>
        </div>
        {/* A bad run-data payload must never crash the editor — scope it. */}
        <ErrorBoundary compact>
          {hasInputs ? (
            <DataPanel title={t('data.input')} items={run?.input ?? []} emptyMessage={dataEmptyMsg} />
          ) : (
            <div className="data-panel">
              <div className="data-head"><strong>{t('data.input')}</strong></div>
              <p className="data-empty">{t('data.triggerNoInput')}</p>
            </div>
          )}
          <DataPanel
            title={t('data.output')}
            items={null}
            ports={run?.output ?? {}}
            emptyMessage={dataEmptyMsg}
          />
        </ErrorBoundary>
        {!execution ? <p className="hint">{t('panel.data.hint')}</p> : null}
      </div>

      <hr className="param-sep" />

      <div className="field-row">
        <div className="field-head">
          <label className="field-label">{t('panel.title')}</label>
          <span className="field-desc">{t('paramDesc.panel.title')}</span>
        </div>
        <div className="field-input">
          <input
            type="text"
            value={node.title ?? ''}
            dir="auto"
            maxLength={120}
            placeholder={typeLabel}
            onChange={(e) =>
              useCanvas.getState().updateNode(nodeId, { title: e.target.value === '' ? undefined : e.target.value })
            }
          />
        </div>
      </div>

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
        <div className="field-head">
          <label className="field-label">{t('panel.note')}</label>
          <span className="field-desc">{t('paramDesc.panel.note')}</span>
        </div>
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
  // key remounts the inner panel per node → clean draft state per selection.
  // The boundary keeps a bad node/run-data from blanking the whole editor.
  return (
    <ErrorBoundary key={node.id} compact>
      <PanelInner node={node} />
    </ErrorBoundary>
  );
}
