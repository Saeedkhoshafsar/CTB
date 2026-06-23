/**
 * P3-T7 — flow import/export envelope + starter template gallery (shared, pure).
 *
 * The acceptance bar from PLAN: export → import → IDENTICAL semantics. These
 * tests pin that round-trip and the deliberate drop of the un-portable
 * `errorHandlerFlowId`, plus that every shipped template is a valid,
 * activatable, GENERIC (I2) export. Server + editor both reuse these schemas
 * (I5), so pinning them here keeps every consumer honest.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  DataKvParamsSchema,
  DataSetFieldsParamsSchema,
  FLOW_EXPORT_KIND,
  FLOW_EXPORT_VERSION,
  FLOW_TEMPLATES,
  FlowExportSchema,
  FlowGraphSchema,
  FlowIfParamsSchema,
  FlowManualTriggerParamsSchema,
  FlowSwitchParamsSchema,
  FlowWaitParamsSchema,
  TgMenuParamsSchema,
  TgSendMessageParamsSchema,
  TgTriggerParamsSchema,
  TgWaitForReplyParamsSchema,
  findFlowTemplate,
  flowTemplateInfo,
  parseFlowExport,
  toFlowExport,
  validateFlowForActivation,
} from '@ctb/shared';
import type { FlowExport } from '@ctb/shared';

/** The param schemas the templates use — same shapes the real registry holds (I5). */
const PARAM_SCHEMAS = new Map<string, z.ZodType>([
  ['flow.manualTrigger', FlowManualTriggerParamsSchema],
  ['tg.trigger', TgTriggerParamsSchema],
  ['tg.sendMessage', TgSendMessageParamsSchema],
  ['tg.waitForReply', TgWaitForReplyParamsSchema],
  ['tg.menu', TgMenuParamsSchema],
  ['flow.if', FlowIfParamsSchema],
  ['flow.switch', FlowSwitchParamsSchema],
  ['flow.wait', FlowWaitParamsSchema],
  ['data.setFields', DataSetFieldsParamsSchema],
  ['data.kv', DataKvParamsSchema],
]);

const sampleGraph = {
  nodes: [
    { id: 'start', type: 'tg.trigger', params: { event: 'command', command: '/go' } },
    { id: 'msg', type: 'tg.sendMessage', params: { type: 'text', text: 'hi {{ $vars.name }}' } },
  ],
  edges: [{ id: 'e1', from: { node: 'start', port: 'main' }, to: { node: 'msg', port: 'main' } }],
};

describe('toFlowExport / FlowExportSchema', () => {
  it('wraps a flow design in a versioned, identity-free envelope', () => {
    const graph = FlowGraphSchema.parse(sampleGraph);
    const exp = toFlowExport({ name: 'My flow', graph, settings: { executionPolicy: 'queue', errorHandlerFlowId: null } });

    expect(exp.kind).toBe(FLOW_EXPORT_KIND);
    expect(exp.version).toBe(FLOW_EXPORT_VERSION);
    expect(exp.name).toBe('My flow');
    expect(exp.settings.executionPolicy).toBe('queue');
    // no instance identity rides along
    expect(exp).not.toHaveProperty('id');
    expect(exp).not.toHaveProperty('botId');
    // the envelope itself validates
    expect(FlowExportSchema.safeParse(exp).success).toBe(true);
  });

  it('drops the un-portable errorHandlerFlowId (→ null) on export', () => {
    const graph = FlowGraphSchema.parse(sampleGraph);
    const exp = toFlowExport({
      name: 'Has handler',
      graph,
      settings: { executionPolicy: 'replace', errorHandlerFlowId: 'some-other-flow-id' },
    });
    expect(exp.settings.errorHandlerFlowId).toBeNull();
  });

  it('rejects an envelope that smuggles in a non-null errorHandlerFlowId', () => {
    const graph = FlowGraphSchema.parse(sampleGraph);
    const bad = { ...toFlowExport({ name: 'x', graph }), settings: { executionPolicy: 'replace', errorHandlerFlowId: 'leak' } };
    expect(FlowExportSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects JSON that is not a flow export', () => {
    expect(parseFlowExport({ hello: 'world' }).ok).toBe(false);
    expect(parseFlowExport({ kind: 'something.else', version: 1, name: 'x', graph: sampleGraph }).ok).toBe(false);
    expect(parseFlowExport({ kind: FLOW_EXPORT_KIND, version: 99, name: 'x', graph: sampleGraph }).ok).toBe(false);
  });

  it('rejects an export whose graph is structurally invalid (dangling edge)', () => {
    const broken = {
      kind: FLOW_EXPORT_KIND,
      version: FLOW_EXPORT_VERSION,
      name: 'broken',
      graph: { nodes: [{ id: 'a', type: 'tg.trigger', params: { event: 'text' } }], edges: [{ id: 'e', from: { node: 'a', port: 'main' }, to: { node: 'ghost', port: 'main' } }] },
    };
    expect(parseFlowExport(broken).ok).toBe(false);
  });
});

describe('export → import → identical semantics (PLAN acceptance)', () => {
  it('graph survives export→serialize→import byte-for-byte', () => {
    const graph = FlowGraphSchema.parse(sampleGraph);
    const exp = toFlowExport({ name: 'Round trip', graph, settings: { executionPolicy: 'ignore', errorHandlerFlowId: null } });

    // simulate a download + re-upload through JSON
    const wire = JSON.parse(JSON.stringify(exp));
    const imported = parseFlowExport(wire);
    expect(imported.ok).toBe(true);
    if (!imported.ok) return;

    // the graph the importer would persist is identical to the one exported
    expect(imported.value.graph).toEqual(graph);
    // settings (minus the dropped handler) survive too
    expect(imported.value.settings).toEqual({ executionPolicy: 'ignore', errorHandlerFlowId: null });
    // and exporting the imported flow again yields the same envelope (idempotent)
    const reExp = toFlowExport({ name: imported.value.name, graph: imported.value.graph, settings: imported.value.settings });
    expect(reExp).toEqual(exp);
  });

  it('sticky notes (H-T1) ride the document through export→import unchanged', () => {
    const graph = FlowGraphSchema.parse({
      ...sampleGraph,
      notes: [
        { id: 'note_1', text: 'explain the trigger', position: { x: -40, y: 20 }, size: { width: 260, height: 180 }, color: 'green' },
        { id: 'note_2', text: '', position: { x: 320, y: 0 }, size: { width: 240, height: 160 }, color: 'pink' },
      ],
    });
    const exp = toFlowExport({ name: 'With notes', graph, settings: { executionPolicy: 'ignore', errorHandlerFlowId: null } });
    const wire = JSON.parse(JSON.stringify(exp));
    const imported = parseFlowExport(wire);
    expect(imported.ok).toBe(true);
    if (!imported.ok) return;
    // notes survive byte-for-byte alongside nodes/edges — they ride the one flow document
    expect(imported.value.graph).toEqual(graph);
    expect(imported.value.graph.notes).toHaveLength(2);
  });
});

describe('starter template gallery (P3-T7, all GENERIC — I2)', () => {
  it('ships the planned templates with stable ids (hello quick-start leads)', () => {
    expect(FLOW_TEMPLATES.map((t) => t.id)).toEqual(['hello', 'feedback', 'quiz', 'faq', 'reminder']);
  });

  it('the hello quick-start is a minimal manualTrigger → sendMessage greeting', () => {
    const t = findFlowTemplate('hello');
    expect(t, 'hello template exists').toBeTruthy();
    const types = t!.export.graph.nodes.map((n) => n.type);
    expect(types).toEqual(['flow.manualTrigger', 'tg.sendMessage']);
    // it drives the editor's Test-run button (a manual trigger) and sends to a
    // chat seeded by the trigger sample — so a one-click run actually replies.
    const triggerParams = t!.export.graph.nodes.find((n) => n.type === 'flow.manualTrigger')?.params;
    expect(triggerParams).toMatchObject({ sample: expect.stringContaining('chat') });
  });

  it('every template is a valid, importable export', () => {
    for (const t of FLOW_TEMPLATES) {
      const parsed = FlowExportSchema.safeParse(t.export);
      expect(parsed.success, `${t.id} should be a valid FlowExport`).toBe(true);
    }
  });

  it('every template graph is activatable (all node params valid)', () => {
    for (const t of FLOW_TEMPLATES) {
      const graph = FlowGraphSchema.parse(t.export.graph);
      const problems = validateFlowForActivation(graph, PARAM_SCHEMAS);
      expect(problems, `${t.id}: ${problems.map((p) => p.message).join('; ')}`).toEqual([]);
    }
  });

  it('every template round-trips export→import unchanged', () => {
    for (const t of FLOW_TEMPLATES) {
      const wire = JSON.parse(JSON.stringify(t.export));
      const imported = parseFlowExport(wire);
      expect(imported.ok, t.id).toBe(true);
      if (imported.ok) expect(imported.value).toEqual(t.export as FlowExport);
    }
  });

  it('findFlowTemplate / flowTemplateInfo expose gallery rows', () => {
    expect(findFlowTemplate('feedback')?.export.name).toBe('Feedback form');
    expect(findFlowTemplate('nope')).toBeUndefined();
    const info = flowTemplateInfo(findFlowTemplate('quiz')!);
    expect(info).toMatchObject({ id: 'quiz', name: 'Quiz' });
    expect(info.nodeCount).toBeGreaterThan(0);
  });
});
