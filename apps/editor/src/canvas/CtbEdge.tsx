/**
 * CtbEdge (H-T4, gap G8) — the default edge with an inline "+" affordance at
 * its midpoint. Clicking the "+" opens the NodePicker pre-targeted at THIS
 * edge, so picking a type splits the edge A→B into A→N→B (the structural edit
 * lives in the pure `insertNodeOnEdge` helper + the canvas store).
 *
 * The "+" only shows on hover (CSS) so a dense canvas stays readable; the wire
 * itself is React Flow's standard bezier path + label.
 */
import { BaseEdge, EdgeLabelRenderer, getBezierPath, type EdgeProps } from '@xyflow/react';
import { useI18n } from '../i18n';
import { useNodePicker } from './NodePicker';

export function CtbEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  markerEnd,
  style,
  label,
  selected,
}: EdgeProps) {
  const t = useI18n((s) => s.t);
  const [path, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });

  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        {...(markerEnd ? { markerEnd } : {})}
        {...(style ? { style } : {})}
      />
      <EdgeLabelRenderer>
        <div
          className={`ctb-edge-tools${selected ? ' selected' : ''}`}
          style={{
            transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
          }}
        >
          {label != null && label !== '' ? <span className="ctb-edge-label">{label}</span> : null}
          <button
            type="button"
            className="ctb-edge-add"
            title={t('editor.edge.insert')}
            aria-label={t('editor.edge.insert')}
            onClick={(e) => {
              e.stopPropagation();
              useNodePicker.getState().open(
                { x: e.clientX, y: e.clientY },
                { kind: 'edge', edgeId: id },
              );
            }}
          >
            +
          </button>
        </div>
      </EdgeLabelRenderer>
    </>
  );
}
