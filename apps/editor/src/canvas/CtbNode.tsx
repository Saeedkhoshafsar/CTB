/**
 * Canvas node renderer (P2-T2) — one component for every node type.
 *
 * Handles are generated from the registry's port lists: inputs on the left,
 * outputs on the right (React Flow positions are physical, not logical, so
 * the graph reads left→right in both fa and en — flow direction is a diagram
 * convention, not text direction). Multi-output nodes get one labeled handle
 * per port (true/false, reply/timeout/invalid).
 */
import { Handle, Position, useUpdateNodeInternals } from '@xyflow/react';
import { memo, useEffect } from 'react';
import { useI18n, type MessageKey } from '../i18n';
import { useLifecycle } from '../stores/lifecycle';
import { useRunData } from '../stores/run-data';
import { effectiveOutputs, inputSlots, isProvider, nodeDisplayName, type CtbNodeData } from './graph';

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
  // dynamic-port nodes (tg.menu / flow.switch, P2-T6) grow one handle per
  // button/rule — computed from params via the shared helper.
  const outputs = effectiveOutputs(flowNode, info);
  // typed sub-connection surface (PB-T1): a consumer's slots render as BOTTOM
  // input handles (dashed provider wires land there, distinct from data ports
  // on the left); a provider node exposes a single bottom "provider" output.
  const slots = inputSlots(info);
  const provider = isProvider(info);
  // React Flow caches handle positions — tell it to re-measure whenever the
  // dynamic port list changes (add/remove button) so edges re-anchor.
  const updateNodeInternals = useUpdateNodeInternals();
  const portsKey = `${outputs.join('|')}#${slots.map((s) => s.kind).join('|')}#${provider ? 'p' : ''}`;
  useEffect(() => {
    updateNodeInternals(flowNode.id);
  }, [portsKey, flowNode.id, updateNodeInternals]);
  const color = info ? (CATEGORY_COLOR[info.category] ?? 'var(--border)') : 'var(--danger)';
  // node labels live in the shared registry as i18n keys (nodes.tg.trigger.label)
  const typeLabel = info ? t(info.meta.labelKey as MessageKey) : flowNode.type;
  // H-T2: a custom `title` (if set) is the head; the type label drops to a
  // sub-line so the user still sees WHAT the node is. No title → head = type.
  const displayName = nodeDisplayName(flowNode, typeLabel);
  const showType = displayName !== typeLabel;

  return (
    <div
      className={`ctb-node${flowNode.disabled ? ' disabled' : ''}${info ? '' : ' unknown'}`}
      style={{ borderColor: color }}
    >
      <div className="ctb-node-head" style={{ background: color }} dir="auto">
        {displayName}
      </div>
      {showType ? <div className="ctb-node-type">{typeLabel}</div> : null}
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
              {port.startsWith('btn:') ? port.slice(4) : port}
            </span>
          ) : null}
        </div>
      ))}

      {/* PB-T1: typed sub-connection handles along the BOTTOM edge — a
          consumer's slots (target) and a provider's single output (source). */}
      {slots.map((slot, i) => (
        <div key={`slot-${slot.kind}`}>
          <Handle
            id={slot.kind}
            type="target"
            position={Position.Bottom}
            className="ctb-slot-handle"
            style={{ left: handleTop(i, slots.length) }}
          />
          <span className="ctb-slot-label" style={{ left: handleTop(i, slots.length) }}>
            {slot.kind}
            {slot.required ? ' *' : ''}
          </span>
        </div>
      ))}
      {provider ? (
        <Handle
          id="provider"
          type="source"
          position={Position.Bottom}
          className="ctb-slot-handle ctb-provider-handle"
          style={{ left: '50%' }}
        />
      ) : null}
    </div>
  );
});
