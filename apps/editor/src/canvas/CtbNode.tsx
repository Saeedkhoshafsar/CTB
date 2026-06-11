/**
 * Canvas node renderer (P2-T2) — one component for every node type.
 *
 * Handles are generated from the registry's port lists: inputs on the left,
 * outputs on the right (React Flow positions are physical, not logical, so
 * the graph reads left→right in both fa and en — flow direction is a diagram
 * convention, not text direction). Multi-output nodes get one labeled handle
 * per port (true/false, reply/timeout/invalid).
 */
import { Handle, Position } from '@xyflow/react';
import { memo } from 'react';
import { useI18n, type MessageKey } from '../i18n';
import { useLifecycle } from '../stores/lifecycle';
import { useRunData } from '../stores/run-data';
import type { CtbNodeData } from './graph';

const CATEGORY_COLOR: Record<string, string> = {
  trigger: 'var(--node-trigger)',
  telegram: 'var(--node-telegram)',
  flow: 'var(--node-flow)',
  data: 'var(--node-data)',
  ai: 'var(--node-ai)',
};

/** vertical spread for n handles inside the node body. */
function handleTop(index: number, count: number): string {
  return `${((index + 1) / (count + 1)) * 100}%`;
}

export const CtbNode = memo(function CtbNode({ data }: { data: CtbNodeData }) {
  const t = useI18n((s) => s.t);
  const { flowNode, info } = data;
  // n8n-style run badge: how many items this node emitted on the last run
  const run = useRunData((s) => s.byNode.get(flowNode.id));
  const outCount = run ? Object.values(run.output).reduce((n, arr) => n + arr.length, 0) : null;
  // activation problems for THIS node (P2-T4) — badge on the offending node
  const nodeProblems = useLifecycle((s) => s.problemsByNode.get(flowNode.id));

  const inputs = info?.ports.inputs ?? ['main'];
  const outputs = info?.ports.outputs ?? ['main'];
  const color = info ? (CATEGORY_COLOR[info.category] ?? 'var(--border)') : 'var(--danger)';
  // node labels live in the shared registry as i18n keys (nodes.tg.trigger.label)
  const label = info ? t(info.meta.labelKey as MessageKey) : flowNode.type;

  return (
    <div
      className={`ctb-node${flowNode.disabled ? ' disabled' : ''}${info ? '' : ' unknown'}`}
      style={{ borderColor: color }}
    >
      <div className="ctb-node-head" style={{ background: color }}>
        {label}
      </div>
      <div className="ctb-node-body">
        <span className="ctb-node-id">{flowNode.id}</span>
        {outCount !== null && outCount > 0 ? (
          <span className="ctb-node-run" title={t('data.lastRun')}>
            {t('data.items', { n: outCount })}
          </span>
        ) : null}
        {flowNode.note ? <div className="ctb-node-note">{flowNode.note}</div> : null}
        {flowNode.disabled ? <div className="ctb-node-flag">{t('editor.node.disabled')}</div> : null}
        {!info ? <div className="ctb-node-flag danger">{t('editor.node.unknownType')}</div> : null}
        {nodeProblems && nodeProblems.length > 0 ? (
          <div className="ctb-node-flag danger" title={nodeProblems.join('\n')}>
            ⚠ {t('editor.node.problems', { n: nodeProblems.length })}
          </div>
        ) : null}
      </div>

      {inputs.map((port, i) => (
        <Handle
          key={`in-${port}`}
          id={port}
          type="target"
          position={Position.Left}
          style={{ top: handleTop(i, inputs.length) }}
        />
      ))}
      {outputs.map((port, i) => (
        <div key={`out-${port}`}>
          <Handle
            id={port}
            type="source"
            position={Position.Right}
            style={{ top: handleTop(i, outputs.length) }}
          />
          {outputs.length > 1 ? (
            <span className="ctb-port-label" style={{ top: handleTop(i, outputs.length) }}>
              {port}
            </span>
          ) : null}
        </div>
      ))}
    </div>
  );
});
