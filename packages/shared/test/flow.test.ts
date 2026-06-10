import { describe, expect, it } from 'vitest';
import { FlowGraphSchema, NodeTypeSchema } from '@ctb/shared';
import sampleFlow from './fixtures/sample-flow.json';

describe('FlowGraphSchema', () => {
  it('parses the hand-written sample flow (P1 demo flow)', () => {
    const graph = FlowGraphSchema.parse(sampleFlow);
    expect(graph.nodes).toHaveLength(7);
    expect(graph.edges).toHaveLength(6);
    expect(graph.nodes[0]!.type).toBe('tg.trigger');
  });

  it('applies defaults: params/position/disabled', () => {
    const graph = FlowGraphSchema.parse({
      nodes: [{ id: 'a', type: 'flow.if' }],
      edges: [],
    });
    expect(graph.nodes[0]!.params).toEqual({});
    expect(graph.nodes[0]!.position).toEqual({ x: 0, y: 0 });
    expect(graph.nodes[0]!.disabled).toBe(false);
  });

  it('defaults edge ports to "main"', () => {
    const graph = FlowGraphSchema.parse({
      nodes: [
        { id: 'a', type: 'flow.if' },
        { id: 'b', type: 'flow.if' },
      ],
      edges: [{ id: 'e', from: { node: 'a' }, to: { node: 'b' } }],
    });
    expect(graph.edges[0]!.from.port).toBe('main');
    expect(graph.edges[0]!.to.port).toBe('main');
  });

  it('rejects duplicate node ids', () => {
    const res = FlowGraphSchema.safeParse({
      nodes: [
        { id: 'dup', type: 'flow.if' },
        { id: 'dup', type: 'flow.switch' },
      ],
      edges: [],
    });
    expect(res.success).toBe(false);
    expect(JSON.stringify(res.error?.issues)).toContain('duplicate node id');
  });

  it('rejects edges referencing unknown nodes', () => {
    const res = FlowGraphSchema.safeParse({
      nodes: [{ id: 'a', type: 'flow.if' }],
      edges: [{ id: 'e', from: { node: 'a' }, to: { node: 'ghost' } }],
    });
    expect(res.success).toBe(false);
    expect(JSON.stringify(res.error?.issues)).toContain('unknown node');
  });

  it('rejects malformed node type ids', () => {
    expect(NodeTypeSchema.safeParse('tg.sendMessage').success).toBe(true);
    expect(NodeTypeSchema.safeParse('collection.recordChanged').success).toBe(true);
    expect(NodeTypeSchema.safeParse('NoNamespace').success).toBe(false);
    expect(NodeTypeSchema.safeParse('UPPER.case').success).toBe(false);
    expect(NodeTypeSchema.safeParse('a.b.c').success).toBe(false);
  });

  it('rejects node ids with unsafe characters', () => {
    const res = FlowGraphSchema.safeParse({
      nodes: [{ id: 'bad id!', type: 'flow.if' }],
      edges: [],
    });
    expect(res.success).toBe(false);
  });
});
