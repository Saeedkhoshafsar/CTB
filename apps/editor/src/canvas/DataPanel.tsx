/**
 * DataPanel (P2-T3.5) — one n8n-style data pane (INPUT or OUTPUT side of the
 * node detail view): item count, per-port tabs (output side), and three view
 * modes over FlowItems:
 *
 *   schema — collapsible key tree; every row is DRAGGABLE onto any
 *            ExpressionInput (drag-to-map) and click-to-copy
 *   table  — top-level keys as columns, one row per item
 *   json   — pretty-printed raw payload
 */
import type { FlowItem } from '@ctb/shared';
import { useMemo, useState, type DragEvent } from 'react';
import { useI18n, type MessageKey } from '../i18n';
import { FIELD_DRAG_MIME, childRows, pathToExpression, type TreeRow } from './json-tree';
import { safeItemJson, safeItems } from './run-data';

export type DataView = 'schema' | 'table' | 'json';

const KIND_ICON: Record<TreeRow['kind'], string> = {
  string: 'A',
  number: '#',
  boolean: '✓',
  null: '∅',
  object: '{}',
  array: '[]',
};

// ── schema (tree) view ───────────────────────────────────────────────────────

function TreeBranch({ value, basePath, depth }: { value: unknown; basePath: string; depth: number }) {
  const rows = useMemo(() => childRows(value, basePath, depth), [value, basePath, depth]);
  return (
    <>
      {rows.map((row) => (
        <TreeNode key={row.path} row={row} value={valueAt(value, row)} />
      ))}
    </>
  );
}

/** child value lookup for the recursive branch render */
function valueAt(parent: unknown, row: TreeRow): unknown {
  if (Array.isArray(parent)) return parent[Number(row.key.slice(1, -1))];
  if (parent !== null && typeof parent === 'object') return (parent as Record<string, unknown>)[row.key];
  return undefined;
}

function TreeNode({ row, value }: { row: TreeRow; value: unknown }) {
  const t = useI18n((s) => s.t);
  const [open, setOpen] = useState(row.depth < 1); // first level open by default
  const [copied, setCopied] = useState(false);
  const branch = row.kind === 'object' || row.kind === 'array';
  const expr = pathToExpression(row.path);

  const onDragStart = (e: DragEvent) => {
    e.dataTransfer.setData(FIELD_DRAG_MIME, expr);
    // plain-text fallback so dropping outside CTB still pastes something useful
    e.dataTransfer.setData('text/plain', expr);
    e.dataTransfer.effectAllowed = 'copy';
  };

  const onCopy = () => {
    try {
      void navigator.clipboard?.writeText(expr);
    } catch {
      /* clipboard unavailable — the drag path still works */
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 900);
  };

  return (
    <div className="tree-node">
      <div
        className="tree-row"
        draggable
        onDragStart={onDragStart}
        onClick={branch ? () => setOpen((o) => !o) : onCopy}
        title={copied ? t('data.copied') : `${expr} — ${t('data.dragHint')}`}
        style={{ paddingInlineStart: `${row.depth * 14 + 4}px` }}
      >
        {branch ? <span className={`tree-arrow${open ? ' open' : ''}`}>▸</span> : <span className="tree-arrow-spacer" />}
        <span className={`tree-kind kind-${row.kind}`}>{KIND_ICON[row.kind]}</span>
        <span className="tree-key" dir="ltr">{row.key}</span>
        {branch ? (
          <span className="tree-count">{row.childCount}</span>
        ) : (
          <span className="tree-preview" dir="auto">{copied ? t('data.copied') : row.preview}</span>
        )}
      </div>
      {branch && open ? <TreeBranch value={value} basePath={row.path} depth={row.depth + 1} /> : null}
    </div>
  );
}

// ── table view ───────────────────────────────────────────────────────────────

function TableView({ items }: { items: FlowItem[] }) {
  const cols = useMemo(() => {
    const keys = new Set<string>();
    for (const it of items) for (const k of Object.keys(safeItemJson(it))) keys.add(k);
    return [...keys];
  }, [items]);
  const cell = (v: unknown): string => {
    if (v === undefined) return '';
    const s = typeof v === 'string' ? v : JSON.stringify(v);
    return s.length > 80 ? `${s.slice(0, 80)}…` : s;
  };
  return (
    <div className="data-table-wrap">
      <table className="data-table">
        <thead>
          <tr>
            <th>#</th>
            {cols.map((c) => (
              <th key={c} dir="ltr">{c}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {items.map((it, i) => (
            <tr key={i}>
              <td className="row-num">{i + 1}</td>
              {cols.map((c) => (
                <td key={c} dir="auto">{cell(safeItemJson(it)[c])}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── the pane ────────────────────────────────────────────────────────────────

export function DataPanel({
  title,
  items,
  ports,
  emptyMessage,
}: {
  title: string;
  /** items of the active port (input side passes the single input list). */
  items: FlowItem[] | null;
  /** output side: port→items map for the port tab bar. null = input side. */
  ports?: Record<string, FlowItem[]> | null;
  emptyMessage: string;
}) {
  const t = useI18n((s) => s.t);
  const [view, setView] = useState<DataView>('schema');
  const portNames = ports ? Object.keys(ports) : [];
  const [activePort, setActivePort] = useState(0);
  const rawShown = ports ? (ports[portNames[Math.min(activePort, portNames.length - 1)] ?? ''] ?? []) : (items ?? []);
  // Never trust run data to be an array of items — a malformed payload here used
  // to crash the whole render (the "black screen"). Coerce defensively.
  const shown = safeItems(rawShown);

  return (
    <div className="data-panel">
      <div className="data-head">
        <strong>{title}</strong>
        {shown.length > 0 ? (
          <span className="data-count">{t('data.items', { n: shown.length })}</span>
        ) : null}
        <span className="spacer" />
        <div className="data-views" role="tablist">
          {(['schema', 'table', 'json'] as const).map((v) => (
            <button
              key={v}
              type="button"
              role="tab"
              aria-selected={view === v}
              className={view === v ? 'active' : ''}
              onClick={() => setView(v)}
            >
              {t(`data.view.${v}` as MessageKey)}
            </button>
          ))}
        </div>
      </div>

      {portNames.length > 1 ? (
        <div className="data-ports" role="tablist">
          {portNames.map((p, i) => (
            <button
              key={p}
              type="button"
              role="tab"
              aria-selected={i === activePort}
              className={i === activePort ? 'active' : ''}
              onClick={() => setActivePort(i)}
            >
              {p} <span className="data-count">{ports![p]!.length}</span>
            </button>
          ))}
        </div>
      ) : null}

      {shown.length === 0 ? (
        <p className="data-empty">{emptyMessage}</p>
      ) : view === 'schema' ? (
        <div className="data-body data-tree">
          {shown.map((it, i) => (
            <div key={i} className="tree-item">
              {shown.length > 1 ? <div className="tree-item-head">{t('data.itemN', { n: i + 1 })}</div> : null}
              <TreeBranch value={safeItemJson(it)} basePath="" depth={0} />
            </div>
          ))}
        </div>
      ) : view === 'table' ? (
        <div className="data-body">
          <TableView items={shown} />
        </div>
      ) : (
        <div className="data-body">
          <pre className="data-json" dir="ltr">{JSON.stringify(shown.map((it) => safeItemJson(it)), null, 2)}</pre>
        </div>
      )}
    </div>
  );
}
