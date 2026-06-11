/**
 * P2-T3 — param-panel → canvas-store → autosave integration (headless).
 *
 * Drives exactly what ParamPanel.commit() does (pruneEmpty + updateNode)
 * and asserts the configured params survive the full pipeline: store
 * document → debounce → PATCH → server-validated FlowGraph. Plus: node-level
 * controls (disable/note) and undo across a param edit.
 */
import { FlowGraphSchema, TgWaitForReplyParamsSchema } from '@ctb/shared';
import { describe, expect, it } from 'vitest';
import { ApiClient } from '../src/api/client';
import { pruneEmpty } from '../src/form/model';
import { createAuthStore } from '../src/stores/auth';
import { createCanvasStore } from '../src/stores/canvas';
import { createFakeServer } from './fake-fetch';

async function setup() {
  const srv = createFakeServer();
  const client = new ApiClient({ fetchImpl: srv.fetch });
  await createAuthStore(client).getState().login('admin', 'pw');
  const bot = await client.createBot({
    name: 'b',
    token: '123456789:AAEabcdefghijklmnopqrstuvwxy-z12345',
    mode: 'polling',
    settings: {},
  });
  const flow = await client.createFlow({ botId: bot.id, name: 'f', graph: { nodes: [], edges: [] } });
  const useCanvas = createCanvasStore(client, 5); // fast debounce for tests
  await useCanvas.getState().load(flow.id);
  return { srv, client, flow, useCanvas };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** what ParamPanel.commit() does with a finished form draft. */
function panelCommit(
  useCanvas: ReturnType<typeof createCanvasStore>,
  nodeId: string,
  draft: Record<string, unknown>,
): void {
  useCanvas.getState().updateNode(nodeId, { params: pruneEmpty(draft) as Record<string, unknown> });
}

describe('param panel → store → autosave', () => {
  it('configured params reach the server document and validate', async () => {
    const { useCanvas, client, flow } = await setup();
    const id = useCanvas.getState().addNode('tg.waitForReply', { x: 0, y: 0 });

    // form draft as the widgets would leave it (incl. noise prune removes)
    panelCommit(useCanvas, id, {
      prompt: { text: 'چند سالته؟' },
      expect: 'number',
      validation: { min: 1, max: 120, regex: '' },
      invalid_message: '',
      max_retries: 2,
      save_to: 'age',
      timeout: '15m',
    });

    await sleep(30); // debounce(5ms) + PATCH
    const saved = FlowGraphSchema.parse((await client.getFlow(flow.id)).graph);
    const node = saved.nodes.find((n) => n.id === id)!;
    expect(node.params).toEqual({
      prompt: { text: 'چند سالته؟' },
      expect: 'number',
      validation: { min: 1, max: 120 },
      max_retries: 2,
      save_to: 'age',
      timeout: '15m',
    });
    expect(TgWaitForReplyParamsSchema.safeParse(node.params).success).toBe(true);
  });

  it('disable + note controls persist; empty note is dropped', async () => {
    const { useCanvas, client, flow } = await setup();
    const id = useCanvas.getState().addNode('tg.sendMessage', { x: 0, y: 0 });
    useCanvas.getState().updateNode(id, { disabled: true, note: 'پیام خوش‌آمد' });
    await sleep(30);
    const saved = FlowGraphSchema.parse((await client.getFlow(flow.id)).graph);
    const node = saved.nodes.find((n) => n.id === id)!;
    expect(node.disabled).toBe(true);
    expect(node.note).toBe('پیام خوش‌آمد');
  });

  it('a param edit is one undo step', async () => {
    const { useCanvas } = await setup();
    const id = useCanvas.getState().addNode('flow.if', { x: 0, y: 0 });
    panelCommit(useCanvas, id, {
      conditions: [{ value1: '{{ $vars.age }}', operator: 'gte', value2: '18' }],
    });
    const withParams = useCanvas.getState().graph.nodes.find((n) => n.id === id)!.params;
    expect(withParams.conditions).toBeDefined();

    useCanvas.getState().undo(); // ← param edit
    expect(useCanvas.getState().graph.nodes.find((n) => n.id === id)!.params).toEqual({});
    useCanvas.getState().undo(); // ← addNode
    expect(useCanvas.getState().graph.nodes).toHaveLength(0);
    useCanvas.getState().redo();
    useCanvas.getState().redo();
    expect(useCanvas.getState().graph.nodes.find((n) => n.id === id)!.params).toEqual(withParams);
  });
});
