/**
 * JSON tree flattening (P2-T3.5) — pure, DOM-free.
 *
 * Flattens a FlowItem's json payload into rows the data panel renders:
 * one row per leaf/branch with a dotted path and a `{{ $json.path }}`
 * expression — the draggable unit of the n8n-style "drag a field onto a
 * parameter input" mapping.
 */

export interface TreeRow {
  /** dotted path, e.g. "user.first_name" or "words[0].text" */
  path: string;
  key: string;
  depth: number;
  /** preview string for leafs; null for expandable branches */
  preview: string | null;
  kind: 'string' | 'number' | 'boolean' | 'null' | 'object' | 'array';
  childCount: number;
}

const PREVIEW_MAX = 60;

function previewOf(value: unknown): string {
  const s = typeof value === 'string' ? value : JSON.stringify(value);
  return s.length > PREVIEW_MAX ? `${s.slice(0, PREVIEW_MAX)}…` : s;
}

function kindOf(value: unknown): TreeRow['kind'] {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return 'array';
  const t = typeof value;
  if (t === 'string' || t === 'number' || t === 'boolean') return t;
  return 'object';
}

/**
 * Flatten one level deep at a time: rows for `value`'s direct children under
 * `basePath`. The component calls this recursively for expanded branches —
 * keeps huge payloads cheap (collapsed branches never flatten).
 */
export function childRows(value: unknown, basePath: string, depth: number): TreeRow[] {
  const rows: TreeRow[] = [];
  if (Array.isArray(value)) {
    value.forEach((v, i) => {
      const kind = kindOf(v);
      const branch = kind === 'object' || kind === 'array';
      rows.push({
        path: `${basePath}[${i}]`,
        key: `[${i}]`,
        depth,
        preview: branch ? null : previewOf(v),
        kind,
        childCount: branch ? sizeOf(v) : 0,
      });
    });
  } else if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const kind = kindOf(v);
      const branch = kind === 'object' || kind === 'array';
      // bare keys join with "."; exotic keys use bracket access so the
      // generated expression actually evaluates
      const seg = /^[A-Za-z_$][\w$]*$/.test(k) ? (basePath ? `${basePath}.${k}` : k) : `${basePath}['${k.replace(/'/g, "\\'")}']`;
      rows.push({
        path: seg,
        key: k,
        depth,
        preview: branch ? null : previewOf(v),
        kind,
        childCount: branch ? sizeOf(v) : 0,
      });
    }
  }
  return rows;
}

function sizeOf(v: unknown): number {
  if (Array.isArray(v)) return v.length;
  if (v !== null && typeof v === 'object') return Object.keys(v as object).length;
  return 0;
}

/** The expression a dragged/clicked field inserts into a parameter input. */
export function pathToExpression(path: string): string {
  return path.startsWith('[') ? `{{ $json${path} }}` : `{{ $json.${path} }}`;
}

/**
 * MIME type for dragging a field expression onto an ExpressionInput —
 * single source of truth lives in the form engine's pure half.
 */
export { FIELD_DRAG_MIME } from '../form/expression';
