/**
 * Flow editor route (P2-T2, lifecycle P2-T4) — palette + React Flow canvas +
 * toolbar with activate/deactivate, version history + rollback.
 * The document lives in the canvas store; this page wires routing, keyboard
 * shortcuts (Ctrl+Z/Y/S) and the save-state indicator around it.
 */
import type { FlowPublic } from '@ctb/shared';
import { ReactFlowProvider, useReactFlow } from '@xyflow/react';
import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ApiError, api } from '../api/client';
import { FlowCanvas } from '../canvas/FlowCanvas';
import { NodeDetail } from '../canvas/NodeDetail';
import { Palette } from '../canvas/Palette';
import { ParamPanel } from '../canvas/ParamPanel';
import { useI18n, type MessageKey } from '../i18n';
import { useCanvas } from '../stores/canvas';
import { useLifecycle } from '../stores/lifecycle';
import { useRunData } from '../stores/run-data';

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

/** Version history dropdown — list of snapshots with a restore action. */
function VersionsPanel() {
  const t = useI18n((s) => s.t);
  const { versions, current, versionsLoading, busy, rollback } = useLifecycle();
  const flowId = useLifecycle((s) => s.flowId);

  const onRestore = async (version: number) => {
    if (!confirm(t('editor.versions.confirm', { n: version }))) return;
    // flush pending edits FIRST so the current graph becomes a snapshot too
    await useCanvas.getState().saveNow();
    const flow = await rollback(version);
    // reload the document from the server — rollback replaced the graph
    if (flow && flowId) await useCanvas.getState().load(flowId);
  };

  return (
    <div className="versions-panel" data-testid="versions-panel">
      <div className="versions-head">
        {t('editor.versions.title')} · {t('flows.version', { n: current })}
      </div>
      {versionsLoading ? (
        <div className="versions-empty">{t('app.loading')}</div>
      ) : versions.length === 0 ? (
        <div className="versions-empty">{t('editor.versions.empty')}</div>
      ) : (
        <ul className="versions-list">
          {versions.map((v) => (
            <li key={v.version} className="versions-row">
              <span className="versions-v">{t('flows.version', { n: v.version })}</span>
              <span className="versions-meta">
                {t('editor.versions.counts', { nodes: v.nodeCount, edges: v.edgeCount })}
                {' · '}
                {new Date(v.createdAt).toLocaleString()}
              </span>
              <button className="ghost" disabled={busy} onClick={() => void onRestore(v.version)}>
                {t('editor.versions.restore')}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Activation problems strip under the toolbar (flow-level + per-node). */
function ProblemsStrip() {
  const t = useI18n((s) => s.t);
  const problems = useLifecycle((s) => s.problems);
  const error = useLifecycle((s) => s.error);
  const clearProblems = useLifecycle((s) => s.clearProblems);
  if (problems.length === 0 && !error) return null;
  return (
    <div className="alert problems-strip" data-testid="problems-strip">
      <strong>{t('editor.problems.title')}</strong>
      <ul>
        {error ? <li>{error}</li> : null}
        {problems.map((p, i) => (
          <li key={i}>{p.nodeId ? `${p.nodeId}: ${p.message}` : p.message}</li>
        ))}
      </ul>
      <button className="ghost" onClick={clearProblems}>
        {t('common.close')}
      </button>
    </div>
  );
}

/**
 * Test-run button (P2-T7): save → POST /flows/:id/run (starts at the
 * flow.manualTrigger) → reload run data so the NDV INPUT/OUTPUT panes and
 * [code] console rows show this run. 422 no_manual_trigger → pointed alert.
 */
function TestRunButton({ flow }: { flow: FlowPublic }) {
  const t = useI18n((s) => s.t);
  const saveNow = useCanvas((s) => s.saveNow);
  const [running, setRunning] = useState(false);
  const onRun = async () => {
    setRunning(true);
    try {
      await saveNow();
      const res = await api.runFlow(flow.id);
      await useRunData.getState().load(flow.id);
      if (res.status === 'error') {
        window.alert(t('editor.testRun.failed', { error: res.error ?? '?' }));
      }
    } catch (err) {
      const body = err instanceof ApiError ? (err.body as { error?: string }) : null;
      window.alert(
        body?.error === 'no_manual_trigger'
          ? t('editor.testRun.noTrigger')
          : t('editor.testRun.failed', { error: err instanceof Error ? err.message : String(err) }),
      );
    } finally {
      setRunning(false);
    }
  };
  return (
    <button className="btn" disabled={running} onClick={() => void onRun()} data-testid="test-run">
      {running ? t('editor.testRun.running') : t('editor.testRun.button')}
    </button>
  );
}

function Toolbar({ flow }: { flow: FlowPublic }) {
  const t = useI18n((s) => s.t);
  const past = useCanvas((s) => s.past);
  const future = useCanvas((s) => s.future);
  const undo = useCanvas((s) => s.undo);
  const redo = useCanvas((s) => s.redo);
  const saveNow = useCanvas((s) => s.saveNow);
  const status = useLifecycle((s) => s.status);
  const busy = useLifecycle((s) => s.busy);
  const versionsOpen = useLifecycle((s) => s.versionsOpen);
  const toggleVersions = useLifecycle((s) => s.toggleVersions);

  const onActivate = async () => {
    // activation validates the SAVED graph — flush edits first
    await saveNow();
    await useLifecycle.getState().activate();
  };

  return (
    <>
      <div className="editor-toolbar">
        <Link className="btn ghost" to={`/bots/${flow.botId}/flows`}>
          {t('common.back')}
        </Link>
        <h1 className="editor-title">{t('editor.title', { name: flow.name })}</h1>
        <span className={`badge ${status === 'active' ? 'active' : 'draft'}`}>
          {t(`flows.status.${status}` as MessageKey)}
        </span>
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
        <TestRunButton flow={flow} />
        <div className="versions-anchor">
          <button className="ghost" onClick={toggleVersions}>
            {t('editor.versions.button')}
          </button>
          {versionsOpen ? <VersionsPanel /> : null}
        </div>
        {status === 'active' ? (
          <button className="danger" disabled={busy} onClick={() => void useLifecycle.getState().deactivate()}>
            {t('flows.action.deactivate')}
          </button>
        ) : (
          <button className="primary" disabled={busy} onClick={() => void onActivate()}>
            {t('flows.action.activate')}
          </button>
        )}
        <SaveBadge />
      </div>
      <ProblemsStrip />
    </>
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
      .then((f) => {
        setFlow(f);
        useLifecycle.getState().init(f.id, f.status);
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
    void load(flowId);
    // run data for the node detail view — best-effort, independent of the doc
    void useRunData.getState().load(flowId);
    return () => {
      // leaving the editor: flush a pending autosave so edits aren't lost
      const { saveState, saveNow, reset } = useCanvas.getState();
      if (saveState === 'dirty') void saveNow().finally(reset);
      else reset();
      useRunData.getState().reset();
      useLifecycle.getState().reset();
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
        <NodeDetail />
      </div>
    </ReactFlowProvider>
  );
}
