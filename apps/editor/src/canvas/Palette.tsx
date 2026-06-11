/**
 * Node palette (P2-T2) — lists registry node types grouped by category.
 * Two ways to add: HTML5 drag onto the canvas, or click (drops at viewport
 * center — keyboard/touch friendly).
 */
import type { NodeTypeInfo } from '@ctb/shared';
import type { DragEvent } from 'react';
import { useI18n, type MessageKey } from '../i18n';

export const PALETTE_MIME = 'application/x-ctb-node-type';

const CATEGORY_ORDER = ['trigger', 'telegram', 'flow', 'data', 'ai'] as const;

export function Palette({
  nodeTypes,
  onAdd,
}: {
  nodeTypes: NodeTypeInfo[];
  onAdd: (type: string) => void;
}) {
  const t = useI18n((s) => s.t);

  const groups = CATEGORY_ORDER.map((cat) => ({
    cat,
    items: nodeTypes.filter((nt) => nt.category === cat),
  })).filter((g) => g.items.length > 0);

  const onDragStart = (e: DragEvent, type: string) => {
    e.dataTransfer.setData(PALETTE_MIME, type);
    e.dataTransfer.effectAllowed = 'move';
  };

  return (
    <aside className="palette">
      <div className="palette-title">{t('editor.palette.title')}</div>
      {groups.map(({ cat, items }) => (
        <div key={cat} className="palette-group">
          <div className="palette-cat">{t(`editor.palette.cat.${cat}` as MessageKey)}</div>
          {items.map((nt) => (
            <button
              key={nt.type}
              className={`palette-item cat-${nt.category}`}
              draggable
              onDragStart={(e) => onDragStart(e, nt.type)}
              onClick={() => onAdd(nt.type)}
              title={nt.type}
            >
              {t(nt.meta.labelKey as MessageKey)}
            </button>
          ))}
        </div>
      ))}
    </aside>
  );
}
