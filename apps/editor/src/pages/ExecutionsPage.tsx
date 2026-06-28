/**
 * Executions inspector (P2-T5) — list + filter + node-by-node detail + cancel.
 *
 * Layout: filter chips → master list (status, flow/bot, chat, time) →
 * detail pane for the selected execution: wait info (what a paused run is
 * waiting for), cancel button for live runs, and the step log where every
 * "executed" row expands into the SAME DataPanel panes the NDV uses
 * (schema/table/JSON views, per-port tabs) — one I/O renderer everywhere.
 *
 * "Live-ish": a 4s interval calls store.refresh() (skipped while a previous
 * tick is in flight and when the tab is hidden); the store owns no timer so
 * unmount can't leak and tests stay deterministic.
 */
import type { ExecLogEntry, ExecutionStatus, WaitSpec } from '@ctb/shared';
import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../api/client';
import { DataPanel } from '../canvas/DataPanel';
import { confirmDialog } from '../stores/confirm';
import { useI18n, type MessageKey } from '../i18n';
import { useExecutions, type StatusFilter } from '../stores/executions';

const FILTERS: StatusFilter[] = ['all', 'running', 'waiting', 'done', 'error', 'canceled'];

function fmtTime(iso: string, locale: string): string {
  try {
    return new Date(iso).toLocaleString(locale === 'fa' ? 'fa-IR' : 'en-GB', {
      month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
  } catch {
    return iso;
  }
}

function StatusBadge({ status }: { status: ExecutionStatus }) {
  const t = useI18n((s) => s.t);
  return <span className={`badge exec-${status}`}>{t(`exec.status.${status}` as MessageKey)}</span>;
}

/** Human description of a WaitSpec — "waiting" rows must say what for. */
function WaitInfo({ wait }: { wait: WaitSpec }) {
  const t = useI18n((s) => s.t);
  const locale = useI18n((s) => s.locale);
  const deadline = wait.kind === 'delay' ? wait.resumeAt : wait.timeoutAt;
  return (
    <div className="wait-info">
      <strong>{t('execs.wait.title')}</strong>
      <span>
        {wait.kind === 'reply'
          ? t('execs.wait.reply', { expect: t(`option.expect.${wait.expect}` as MessageKey) })
          : wait.kind === 'callback'
            ? t('execs.wait.callback', { keys: wait.keys.join('، ') })
            : t('execs.wait.delay')}
      </span>
      <span className="sub" dir="ltr">{t('execs.wait.node')}: {wait.nodeId}</span>
      {wait.kind === 'reply' && wait.retriesLeft > 0 ? (
        <span className="sub">{t('execs.wait.retries', { n: wait.retriesLeft })}</span>
      ) : null}
      {deadline ? (
        <span className="sub">{t('execs.wait.until', { time: fmtTime(deadline, locale) })}</span>
      ) : null}
    </div>
  );
}

/** One step-log row; "executed" rows (with I/O) expand into DataPanel panes. */
function LogRow({ row }: { row: ExecLogEntry }) {
  const t = useI18n((s) => s.t);
  const locale = useI18n((s) => s.locale);
  const [open, setOpen] = useState(false);
  const hasIo = row.input !== null;
  return (
    <div className={`log-row level-${row.level}${hasIo ? ' has-io' : ''}`}>
      <button
        type="button"
        className="log-head"
        onClick={hasIo ? () => setOpen((o) => !o) : undefined}
        disabled={!hasIo}
      >
        {hasIo ? <span className={`tree-arrow${open ? ' open' : ''}`}>▸</span> : <span className="tree-arrow-spacer" />}
        <span className={`log-level level-${row.level}`}>{row.level}</span>
        {row.nodeId ? <span className="log-node" dir="ltr">{row.nodeId}</span> : null}
        <span className="log-msg" dir="auto">{row.message}</span>
        {row.durationMs !== null ? (
          <span className="log-dur" dir="ltr">{row.durationMs}ms</span>
        ) : null}
        <span className="log-ts" dir="ltr">{fmtTime(row.ts, locale)}</span>
      </button>
      {row.error && row.error !== row.message ? (
        <div className="log-error" dir="auto">{row.error}</div>
      ) : null}
      {open && hasIo ? (
        <div className="log-io">
          <DataPanel title={t('data.input')} items={row.input} emptyMessage={t('data.emptyNode')} />
          <DataPanel
            title={t('data.output')}
            items={null}
            ports={row.output ?? {}}
            emptyMessage={t('data.emptyNode')}
          />
        </div>
      ) : null}
    </div>
  );
}

export function ExecutionsPage() {
  const t = useI18n((s) => s.t);
  const locale = useI18n((s) => s.locale);
  const [searchParams] = useSearchParams();
  const flowIdParam = searchParams.get('flowId');
  const {
    rows, status, flowId, loading, error,
    selectedId, detail, detailLoading,
    load, setStatus, refresh, select, cancel, reset,
  } = useExecutions();

  // id → display-name maps (best-effort: a deleted flow still shows its id)
  const [flowNames, setFlowNames] = useState<Map<string, string>>(new Map());
  const [botNames, setBotNames] = useState<Map<string, string>>(new Map());

  useEffect(() => {
    void load({ flowId: flowIdParam });
    api.listFlows().then((fs) => setFlowNames(new Map(fs.map((f) => [f.id, f.name])))).catch(() => undefined);
    api.listBots().then((bs) => setBotNames(new Map(bs.map((b) => [b.id, b.name])))).catch(() => undefined);
    return () => reset();
  }, [flowIdParam, load, reset]);

  // live-ish refresh — page owns the timer, store guards overlap
  useEffect(() => {
    const id = setInterval(() => {
      if (document.visibilityState === 'visible') void refresh();
    }, 4000);
    return () => clearInterval(id);
  }, [refresh]);

  const live = detail !== null && (detail.status === 'waiting' || detail.status === 'running');

  return (
    <div className="page execs-page">
      <div className="page-head">
        <h1>{t('executions.title')}</h1>
        {flowId ? (
          <span className="badge draft" dir="auto">
            {t('execs.scopedToFlow', { name: flowNames.get(flowId) ?? flowId })}{' '}
            <Link to="/executions">✕</Link>
          </span>
        ) : null}
        <span className="spacer" />
        <button className="ghost" onClick={() => void refresh()}>{t('data.refresh')}</button>
      </div>

      <div className="exec-filters" role="tablist">
        {FILTERS.map((f) => (
          <button
            key={f}
            type="button"
            role="tab"
            aria-selected={status === f}
            className={status === f ? 'active' : ''}
            onClick={() => void setStatus(f)}
          >
            {f === 'all' ? t('execs.filter.all') : t(`exec.status.${f}` as MessageKey)}
          </button>
        ))}
      </div>

      {error && <div className="alert">{error}</div>}

      <div className="execs-layout">
        <div className="execs-list">
          {loading ? (
            <div className="splash">{t('app.loading')}</div>
          ) : rows.length === 0 ? (
            <div className="empty">{t('execs.empty')}</div>
          ) : (
            rows.map((row) => (
              <button
                type="button"
                key={row.id}
                className={`exec-row${row.id === selectedId ? ' selected' : ''}`}
                onClick={() => void select(row.id === selectedId ? null : row.id)}
              >
                <StatusBadge status={row.status} />
                <span className="grow">
                  <span className="title" dir="auto">{flowNames.get(row.flowId) ?? row.flowId}</span>
                  <span className="sub" dir="auto">
                    {botNames.get(row.botId) ?? row.botId}
                    {row.chatId !== null ? ` · ${t('execs.chat', { id: row.chatId })}` : ''}
                  </span>
                </span>
                <span className="exec-time" dir="ltr">{fmtTime(row.startedAt, locale)}</span>
              </button>
            ))
          )}
        </div>

        <div className="execs-detail">
          {selectedId === null ? (
            <div className="empty">{t('execs.selectHint')}</div>
          ) : detailLoading && detail === null ? (
            <div className="splash">{t('data.loading')}</div>
          ) : detail === null ? (
            <div className="empty">{t('error.notFound')}</div>
          ) : (
            <>
              <div className="exec-detail-head">
                <StatusBadge status={detail.status} />
                <span className="title" dir="auto">
                  {flowNames.get(detail.flowId) ?? detail.flowId}
                </span>
                <span className="sub" dir="ltr">{detail.id}</span>
                <span className="spacer" />
                {live ? (
                  <button
                    className="danger"
                    onClick={() => {
                      void (async () => {
                        if (await confirmDialog({ message: t('execs.cancel.confirm'), danger: true })) {
                          await cancel(detail.id);
                        }
                      })();
                    }}
                  >
                    {t('execs.cancel')}
                  </button>
                ) : null}
              </div>

              {detail.error ? <div className="alert" dir="auto">{detail.error}</div> : null}
              {detail.wait ? <WaitInfo wait={detail.wait} /> : null}

              <div className="exec-log">
                {detail.logs.length === 0 ? (
                  <div className="empty">{t('execs.noLogs')}</div>
                ) : (
                  detail.logs.map((row) => <LogRow key={row.id} row={row} />)
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
