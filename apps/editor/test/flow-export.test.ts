/**
 * PLAN3 F-T3 — flow-export helper tests.
 *
 * Surfacing "Export this flow as JSON" in BOTH the flow list and the editor
 * toolbar means the filename/blob logic is now shared. These tests pin the PURE
 * part (no DOM) so the download a user gets is identical and predictable
 * wherever they click Export. The thin DOM glue (`downloadFlowExport`) is left
 * to the integration layer — the unit-testable risk lives in the name/blob.
 */
import { FLOW_EXPORT_KIND, FLOW_EXPORT_VERSION, type FlowExport } from '@ctb/shared';
import { describe, expect, it } from 'vitest';
import { flowExportBlob, flowExportFilename } from '../src/lib/flow-export';

const sampleEnvelope: FlowExport = {
  kind: FLOW_EXPORT_KIND,
  version: FLOW_EXPORT_VERSION,
  name: 'Greeting flow',
  graph: { nodes: [], edges: [] },
  settings: { executionPolicy: 'replace', errorHandlerFlowId: null },
};

describe('flowExportFilename', () => {
  it('keeps a clean ascii name, appends .json', () => {
    expect(flowExportFilename('greeting')).toBe('greeting.json');
    expect(flowExportFilename('my-flow.v2')).toBe('my-flow.v2.json');
  });

  it('collapses runs of non-word characters to a single underscore', () => {
    expect(flowExportFilename('My Greeting Flow')).toBe('My_Greeting_Flow.json');
    expect(flowExportFilename('a // b ?? c')).toBe('a_b_c.json');
  });

  it('trims leading/trailing underscores produced by stray symbols', () => {
    expect(flowExportFilename('  spaced  ')).toBe('spaced.json');
    expect(flowExportFilename('!!!edge!!!')).toBe('edge.json');
  });

  it('falls back to "flow" for empty / all-symbol names', () => {
    expect(flowExportFilename('')).toBe('flow.json');
    expect(flowExportFilename('   ')).toBe('flow.json');
    expect(flowExportFilename('///')).toBe('flow.json');
  });

  it('handles non-latin (e.g. Persian) names predictably', () => {
    // \w (default flags) excludes unicode letters, so an all-Persian name has no
    // word chars left and falls back to "flow" — assert that explicit behaviour.
    expect(flowExportFilename('جریان')).toBe('flow.json');
    // mixed: the latin "flow-" survives, the Persian tail collapses + trims.
    expect(flowExportFilename('flow-سلام')).toBe('flow-.json');
  });
});

describe('flowExportBlob', () => {
  it('serializes the envelope as pretty JSON with application/json type', async () => {
    const blob = flowExportBlob(sampleEnvelope);
    expect(blob.type).toBe('application/json');
    const text = await blob.text();
    expect(JSON.parse(text)).toEqual(sampleEnvelope);
    // pretty-printed (2-space indent) → contains newlines + indentation
    expect(text).toContain('\n  "kind"');
  });
});
