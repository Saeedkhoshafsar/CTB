/**
 * Flow editor route (P2-T2) — palette + React Flow canvas + toolbar.
 * The document lives in the canvas store; this page wires routing, keyboard
 * shortcuts (Ctrl+Z/Y/S) and the save-state indicator around it.
 */
import type { FlowPublic } from '@ctb/shared';
import { ReactFlowProvider, useReactFlow } from '@xyflow/react';
import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api/client';
import { FlowCanvas } from '../canvas/FlowCanvas';
import { Palette } from '../canvas/Palette';
import { ParamPanel } from '../canvas/ParamPanel';
import { useI18n, type MessageKey } from '../i18n';
import { useCanvas } from '../stores/canvas';

function SaveBadge() {
  const t = useI18n((s) => s.t);
  const saveState = useCanvas((s) => s.saveState);
  const version = useCanvas((s) => s.version);
  return (
    <span className={`badge save-${saveState}`}>
      {t(`editor.save.${saveState}` as MessageKey)} · {t('flows.version', { n: version })}
    </span>
  );
}

function Toolbar({ flow }: { flow: FlowPublic }) {
  const t = useI18n((s) => s.t);
  const past = useCanvas((s) => s.past);
  const future = useCanvas((s) => s.future);
  const undo = useCanvas((s) => s.undo);
  const redo = useCanvas((s) => s.redo);
  const saveNow = useCanvas((s) => s.saveNow);

  return (
    <div className="editor-toolbar">
      <Link className="btn ghost" to={`/bots/${flow.botId}/flows`}>
        {t('common.back')}
      </Link>
      <h1 className="editor-title">{t('editor.title', { name: flow.name })}</h1>
      <span className="spacer" />
      <button className="ghost" disabled={past.length === 0} onClick={undo} title="Ctrl+Z">
        {t('editor.undo')}
      </button>
      <button className="ghost" disabled={future.length === 0} onClick={redo} title="Ctrl+Y">
        {t('editor.redo')}
      </button>
      <button className="btn" onClick={() => void saveNow()}>
        {t('editor.save')}
      </button>
      <SaveBadge />
    </div>
  );
}

/** click-to-add drops the node at the current viewport center. */
function PaletteWithViewport() {
  const nodeTypes = useCanvas((s) => s.nodeTypes);
  const addNode = useCanvas((s) => s.addNode);
  const { screenToFlowPosition } = useReactFlow();

  const onAdd = useCallback(
    (type: string) => {
      const el = document.querySelector('.editor-canvas');
      const rect = el?.getBoundingClientRect();
      const center = rect
        ? screenToFlowPosition({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 })
        : { x: 0, y: 0 };
      addNode(type, { x: Math.round(center.x), y: Math.round(center.y) });
    },
    [screenToFlowPosition, addNode],
  );

  return <Palette nodeTypes={nodeTypes} onAdd={onAdd} />;
}

export function FlowEditorPage() {
  const t = useI18n((s) => s.t);
  const { flowId = '' } = useParams<{ flowId: string }>();
  const [flow, setFlow] = useState<FlowPublic | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCanvas((s) => s.load);
  const loadError = useCanvas((s) => s.loadError);
  const loading = useCanvas((s) => s.loading);

  useEffect(() => {
    api
      .getFlow(flowId)
      .then(setFlow)
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
    void load(flowId);
    return () => {
      // leaving the editor: flush a pending autosave so edits aren't lost
      const { saveState, saveNow, reset } = useCanvas.getState();
      if (saveState === 'dirty') void saveNow().finally(reset);
      else reset();
    };
  }, [flowId, load]);

  // keyboard shortcuts — global on this page
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return;
      const target = e.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      if (e.key === 'z' && !e.shiftKey) {
        e.preventDefault();
        useCanvas.getState().undo();
      } else if (e.key === 'y' || (e.key === 'z' && e.shiftKey)) {
        e.preventDefault();
        useCanvas.getState().redo();
      } else if (e.key === 's') {
        e.preventDefault();
        void useCanvas.getState().saveNow();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const shownError = error ?? loadError;
  if (shownError) {
    return (
      <div className="page">
        <div className="alert">{shownError}</div>
      </div>
    );
  }
  if (!flow || loading) return <div className="splash">{t('app.loading')}</div>;

  return (
    <ReactFlowProvider>
      <div className="editor-layout">
        <Toolbar flow={flow} />
        <div className="editor-main">
          <PaletteWithViewport />
          <div className="editor-canvas">
            <FlowCanvas />
          </div>
          <ParamPanel />
        </div>
      </div>
    </ReactFlowProvider>
  );
}
