/**
 * Sticky-note canvas element (H-T1).
 *
 * A sticky note is a CANVAS-ONLY annotation — not a flow node (it has no
 * handles, no ports, and the executor never sees it). It is stored in
 * `FlowGraph.notes` and rendered as a React Flow custom node of type 'sticky'
 * so it gets drag / selection / delete for free, while staying behind the
 * flow nodes (lower z-index) so wires remain readable.
 *
 * Editing is in-place: double-click (or the ✎ button) turns the body into a
 * textarea; blur / Escape commits via the canvas store. A small fixed colour
 * palette keeps the canvas legible. Resize uses React Flow's NodeResizer; the
 * final size is committed to the document on resize-end.
 */
import { NodeResizer, type NodeProps } from '@xyflow/react';
import { memo, useEffect, useRef, useState } from 'react';
import { useI18n } from '../i18n';
import { useCanvas } from '../stores/canvas';
import type { NoteColor } from '@ctb/shared';
import type { StickyRfNode } from './graph';

const COLORS: NoteColor[] = ['yellow', 'green', 'blue', 'pink', 'gray'];

export const StickyNote = memo(function StickyNote(props: NodeProps<StickyRfNode>) {
  const { data, selected } = props;
  const note = data.note;
  const t = useI18n((s) => s.t);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(note.text);
  const taRef = useRef<HTMLTextAreaElement>(null);

  // keep the local draft in sync when the note changes from elsewhere
  // (undo/redo, autosave round-trip) while NOT editing.
  useEffect(() => {
    if (!editing) setDraft(note.text);
  }, [note.text, editing]);

  useEffect(() => {
    if (editing) taRef.current?.focus();
  }, [editing]);

  const commitText = (): void => {
    setEditing(false);
    if (draft !== note.text) useCanvas.getState().updateNote(note.id, { text: draft });
  };

  const setColor = (color: NoteColor): void => {
    if (color !== note.color) useCanvas.getState().updateNote(note.id, { color });
  };

  return (
    <div className={`sticky-note sticky-${note.color}${selected ? ' selected' : ''}`}>
      <NodeResizer
        isVisible={selected}
        minWidth={80}
        minHeight={60}
        maxWidth={2000}
        maxHeight={2000}
        onResizeEnd={(_e, params) =>
          useCanvas
            .getState()
            .updateNote(note.id, {
              size: { width: Math.round(params.width), height: Math.round(params.height) },
            })
        }
      />

      <div className="sticky-toolbar">
        <div className="sticky-colors">
          {COLORS.map((c) => (
            <button
              key={c}
              type="button"
              className={`sticky-color sticky-color-${c}${c === note.color ? ' active' : ''}`}
              aria-label={t(`editor.note.color.${c}` as never)}
              aria-pressed={c === note.color}
              // nodrag stops React Flow from starting a drag on this click
              onClick={(e) => {
                e.stopPropagation();
                setColor(c);
              }}
            />
          ))}
        </div>
        <div className="sticky-actions">
          {!editing && (
            <button
              type="button"
              className="sticky-btn nodrag"
              aria-label={t('editor.note.edit')}
              onClick={(e) => {
                e.stopPropagation();
                setEditing(true);
              }}
            >
              ✎
            </button>
          )}
        </div>
      </div>

      {editing ? (
        <textarea
          ref={taRef}
          className="sticky-text-edit nodrag"
          value={draft}
          placeholder={t('editor.note.placeholder')}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commitText}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault();
              setDraft(note.text);
              setEditing(false);
            }
            // Ctrl/Cmd+Enter commits; plain Enter inserts a newline.
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              commitText();
            }
            e.stopPropagation(); // don't let Delete/Backspace delete the node
          }}
        />
      ) : (
        <div
          className="sticky-text"
          onDoubleClick={(e) => {
            e.stopPropagation();
            setEditing(true);
          }}
        >
          {note.text ? note.text : <span className="sticky-empty">{t('editor.note.empty')}</span>}
        </div>
      )}
    </div>
  );
});
