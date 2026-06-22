/**
 * NodeDetail (NDV, P2-T3.5) — the n8n-style three-pane node modal:
 *
 *   ┌─ INPUT ─────────┬─ node params ────────┬─ OUTPUT ─────────┐
 *   │ items that fed  │ the SAME SchemaForm  │ items the node   │
 *   │ this node on    │ the side-panel uses  │ emitted per port │
 *   │ the last run    │ (same draft commit)  │ on the last run  │
 *   └─────────────────┴──────────────────────┴──────────────────┘
 *
 * Opened by double-clicking a node on the canvas. Fields in either data pane
 * drag-drop onto any parameter input as `{{ $json.path }}` (drag-to-map).
 * Run data comes from the run-data store (latest execution of this flow).
 */
import type { FlowNode } from '@ctb/shared';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { create } from 'zustand';
import { useI18n, type MessageKey } from '../i18n';
import { pruneEmpty } from '../form/model';
import { buildPreviewScope, type PreviewScope } from '../form/preview';
import { SchemaForm } from '../form/SchemaForm';
import type { JsonSchema } from '../form/schema';
import { useCanvas } from '../stores/canvas';
import { useRunData } from '../stores/run-data';
import { DataPanel } from './DataPanel';

const COMMIT_MS = 600;

/** which node's detail view is open — view-state, outside undo history. */
interface DetailState {
  nodeId: string | null;
  open: (nodeId: string) => void;
  close: () => void;
}
export const useNodeDetail = create<DetailState>((set) => ({
  nodeId: null,
  open: (nodeId) => set({ nodeId }),
  close: () => set({ nodeId: null }),
}));

function DetailInner({ node }: { node: FlowNode }) {
  const t = useI18n((s) => s.t);
  const byType = useCanvas((s) => s.byType);
  const info = byType.get(node.type);
  const close = useNodeDetail((s) => s.close);

  const run = useRunData((s) => s.byNode.get(node.id));
  const execution = useRunData((s) => s.execution);
  const runLoading = useRunData((s) => s.loading);
  const refresh = useRunData((s) => s.refresh);

  // Live-preview scope (G-T2): the latest run's FIRST input item drives
  // `{{ $json.* }}` previews inside the form. No run / no input → null → the
  // ExpressionInput shows no preview (the engine still resolves at run time).
  const previewScope = useMemo<PreviewScope | null>(() => {
    const first = run?.input?.[0];
    if (!first) return null;
    return buildPreviewScope({ json: first.json, items: run?.input });
  }, [run]);

  // Same draft/debounce-commit pattern as ParamPanel — one undo step per
  // pause, flushed on close. (Kept local: the two surfaces edit the same
  // node but never simultaneously — the NDV is a modal.)
  const [draft, setDraft] = useState<Record<string, unknown>>(node.params);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const nodeId = node.id;

  useEffect(() => {
    if (timer.current === null) setDraft(node.params);
  }, [node.params]);

  const onFormChange = useCallback(
    (next: Record<string, unknown>) => {
      setDraft(next);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        timer.current = null;
        useCanvas.getState().updateNode(nodeId, { params: pruneEmpty(next) as Record<string, unknown> });
      }, COMMIT_MS);
    },
    [nodeId],
  );

  // unmount/close flushes a pending commit
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

  // Escape closes
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [close]);

  const label = info ? t(info.meta.labelKey as MessageKey) : node.type;
  const descKey = `nodeDesc.${node.type}`;
  const descMsg = t(descKey as MessageKey);
  const nodeDesc = descMsg === descKey ? null : descMsg;
  const hasInputs = (info?.ports.inputs.length ?? 1) > 0;

  const emptyMsg = execution
    ? t('data.emptyNode')
    : t('data.noRun');

  return (
    <div className="ndv-overlay" onClick={(e) => e.target === e.currentTarget && close()}>
      <div className="ndv" role="dialog" aria-label={label}>
        <div className="ndv-head">
          <strong>{label}</strong>
          <span className="ctb-node-id">{node.id}</span>
          <span className="spacer" />
          {execution ? (
            <span className={`badge exec-${execution.status}`}>
              {t(`exec.status.${execution.status}` as MessageKey)}
            </span>
          ) : null}
          <button type="button" className="ghost" disabled={runLoading} onClick={() => void refresh()}>
            {runLoading ? t('data.loading') : t('data.refresh')}
          </button>
          <button type="button" className="ghost ndv-close" onClick={close} title={t('common.close')}>
            ✕
          </button>
        </div>

        <div className="ndv-body">
          {hasInputs ? (
            <DataPanel title={t('data.input')} items={run?.input ?? []} emptyMessage={emptyMsg} />
          ) : (
            <div className="data-panel">
              <div className="data-head"><strong>{t('data.input')}</strong></div>
              <p className="data-empty">{t('data.triggerNoInput')}</p>
            </div>
          )}

          <div className="ndv-params">
            {nodeDesc ? <p className="param-desc">{nodeDesc}</p> : null}
            {info ? (
              <SchemaForm
                schema={info.paramsJsonSchema as JsonSchema}
                value={draft}
                onChange={onFormChange}
                previewScope={previewScope}
              />
            ) : (
              <p className="alert">{t('editor.node.unknownType')}</p>
            )}
          </div>

          <DataPanel
            title={t('data.output')}
            items={null}
            ports={run?.output ?? {}}
            emptyMessage={emptyMsg}
          />
        </div>
      </div>
    </div>
  );
}

export function NodeDetail() {
  const nodeId = useNodeDetail((s) => s.nodeId);
  const graph = useCanvas((s) => s.graph);
  if (!nodeId) return null;
  const node = graph.nodes.find((n) => n.id === nodeId);
  if (!node) return null;
  return <DetailInner key={node.id} node={node} />;
}
