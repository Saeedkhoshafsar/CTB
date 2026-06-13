/**
 * CodeWidget (P2-T7) — the CodeMirror 6 editor behind the structural `code`
 * widget (schema.ts resolves it from the `ctbWidget: 'code'` annotation that
 * DataCodeParamsSchema attaches to its `code` field). Lazy-loaded by
 * widgets.tsx so only flows that use a Code node pay CodeMirror's bundle.
 *
 * JavaScript syntax highlighting + `$`-scope autocompletion. Pinned LTR (code
 * is left-to-right even inside the RTL editor shell). Controlled-ish: external
 * value changes are reconciled into the document, local edits flow out via
 * onChange — we never recreate the EditorView on each keystroke.
 */
import { autocompletion, type CompletionContext, type CompletionResult } from '@codemirror/autocomplete';
import { javascript } from '@codemirror/lang-javascript';
import { EditorState } from '@codemirror/state';
import { EditorView, keymap, lineNumbers } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { useEffect, useRef } from 'react';

export interface CodeWidgetProps {
  value: string;
  onChange: (next: string) => void;
}

/** `$`-scope members the Code node exposes (autocomplete, NODES.md §Code). */
const SCOPE_COMPLETIONS = [
  { label: '$items', type: 'variable', info: 'All input items (run-once mode).' },
  { label: '$json', type: 'variable', info: "First input item's json (per-item: this item's json)." },
  { label: '$vars', type: 'variable', info: 'Execution-scoped variables.' },
  { label: '$http', type: 'namespace', info: 'await $http.request({url}) / $http.get(url) — host-limited.' },
  { label: '$http.request', type: 'function', info: 'await $http.request({ method, url, headers, body })' },
  { label: '$http.get', type: 'function', info: 'await $http.get(url)' },
  { label: '$kv', type: 'namespace', info: '$kv.get / $kv.set / $kv.delete — persistent per-user store.' },
  { label: '$kv.get', type: 'function', info: 'await $kv.get(key)' },
  { label: '$kv.set', type: 'function', info: 'await $kv.set(key, value)' },
  { label: '$kv.delete', type: 'function', info: 'await $kv.delete(key)' },
  { label: 'console.log', type: 'function', info: 'Captured into the execution log.' },
];

/** CodeMirror completion source for the `$` scope. */
function scopeCompletions(context: CompletionContext): CompletionResult | null {
  const word = context.matchBefore(/[$\w.]*/);
  if (!word || (word.from === word.to && !context.explicit)) return null;
  return {
    from: word.from,
    options: SCOPE_COMPLETIONS.map((c) => ({ label: c.label, type: c.type, info: c.info })),
    validFor: /^[$\w.]*$/,
  };
}

export function CodeWidget({ value, onChange }: CodeWidgetProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  // Keep the latest onChange without re-creating the editor each render.
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  // Create the EditorView once (mount); destroy on unmount.
  useEffect(() => {
    if (!hostRef.current) return;
    const state = EditorState.create({
      doc: value,
      extensions: [
        lineNumbers(),
        history(),
        javascript(),
        autocompletion({ override: [scopeCompletions] }),
        keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
        EditorView.lineWrapping,
        EditorView.updateListener.of((update) => {
          if (update.docChanged) onChangeRef.current(update.state.doc.toString());
        }),
      ],
    });
    const view = new EditorView({ state, parent: hostRef.current });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- create-once; value reconciled below.
  }, []);

  // Reconcile external value changes (e.g. node switch, undo) into the doc
  // without clobbering the user's caret on their own edits.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (value !== current) {
      view.dispatch({ changes: { from: 0, to: current.length, insert: value } });
    }
  }, [value]);

  return <div ref={hostRef} className="code-widget" dir="ltr" data-testid="code-widget" />;
}
