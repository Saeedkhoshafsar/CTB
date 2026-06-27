/**
 * PLAN4 J-T2 — test-run mode decision (pure, DOM-free).
 *
 * The Report B blocker was that a flow whose real entry is a `tg.trigger` could
 * only get a dead-end "use the Manual trigger instead" alert. `decideTestRunMode`
 * is the pure core that now routes such a flow into n8n-style live-listen, while
 * keeping the historical `manual` path byte-for-byte unchanged when a
 * `flow.manualTrigger` is present. Pinning it here (no React) makes the behaviour
 * users feel deterministic and regression-proof — the F-T3 pattern.
 */
import type { FlowGraph } from '@ctb/shared';
import { describe, expect, it } from 'vitest';
import {
  MANUAL_TRIGGER_TYPE,
  TELEGRAM_TRIGGER_TYPE,
  decideTestRunMode,
} from '../src/lib/test-run';

/** Minimal node literal — only the fields the decision reads. */
function node(type: string, id = type, disabled = false): FlowGraph['nodes'][number] {
  return { id, type, params: {}, position: { x: 0, y: 0 }, disabled } as FlowGraph['nodes'][number];
}

function graph(...nodes: FlowGraph['nodes']): Pick<FlowGraph, 'nodes'> {
  return { nodes };
}

describe('decideTestRunMode (J-T2)', () => {
  it('manual: an enabled flow.manualTrigger → synchronous run path', () => {
    expect(decideTestRunMode(graph(node(MANUAL_TRIGGER_TYPE)))).toBe('manual');
  });

  it('listen: no manual trigger but an enabled tg.trigger → live listen', () => {
    expect(decideTestRunMode(graph(node(TELEGRAM_TRIGGER_TYPE)))).toBe('listen');
  });

  it('manual takes precedence when BOTH triggers exist (historical behaviour)', () => {
    expect(
      decideTestRunMode(graph(node(TELEGRAM_TRIGGER_TYPE), node(MANUAL_TRIGGER_TYPE))),
    ).toBe('manual');
  });

  it('none: a flow with no trigger node at all', () => {
    expect(decideTestRunMode(graph(node('tg.sendMessage')))).toBe('none');
  });

  it('none: an empty / null / undefined graph', () => {
    expect(decideTestRunMode(graph())).toBe('none');
    expect(decideTestRunMode(null)).toBe('none');
    expect(decideTestRunMode(undefined)).toBe('none');
  });

  it('a DISABLED manual trigger does not count — falls through to tg.trigger listen', () => {
    expect(
      decideTestRunMode(graph(node(MANUAL_TRIGGER_TYPE, 'm', true), node(TELEGRAM_TRIGGER_TYPE))),
    ).toBe('listen');
  });

  it('a DISABLED tg.trigger with no manual trigger → none (nothing to listen on)', () => {
    expect(decideTestRunMode(graph(node(TELEGRAM_TRIGGER_TYPE, 't', true)))).toBe('none');
  });
});
