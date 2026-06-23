import { describe, expect, it } from 'vitest';
import { FlowGraphSchema, NodeTypeSchema, StickyNoteSchema } from '@ctb/shared';
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

  // ── sticky notes (H-T1) ───────────────────────────────────────────────────
  describe('sticky notes (H-T1)', () => {
    it('a graph WITHOUT notes parses unchanged — notes is optional/absent', () => {
      const graph = FlowGraphSchema.parse({
        nodes: [{ id: 'a', type: 'flow.if' }],
        edges: [],
      });
      // optional, no default → omitted graphs stay byte-identical (engine inert)
      expect(graph.notes).toBeUndefined();
    });

    it('the hand-written sample flow (no notes) still parses byte-identically', () => {
      const graph = FlowGraphSchema.parse(sampleFlow);
      expect(graph.notes).toBeUndefined();
      expect(graph.nodes).toHaveLength(7);
    });

    it('parses notes and applies StickyNote defaults (size/color/text)', () => {
      const graph = FlowGraphSchema.parse({
        nodes: [],
        edges: [],
        notes: [{ id: 'note_1', position: { x: 10, y: 20 } }],
      });
      expect(graph.notes).toHaveLength(1);
      const n = graph.notes![0]!;
      expect(n.text).toBe('');
      expect(n.color).toBe('yellow');
      expect(n.size).toEqual({ width: 240, height: 160 });
      expect(n.position).toEqual({ x: 10, y: 20 });
    });

    it('notes round-trip through the graph independent of nodes/edges', () => {
      const input = {
        nodes: [{ id: 'a', type: 'flow.if' }],
        edges: [],
        notes: [
          { id: 'note_1', text: 'hi', position: { x: 0, y: 0 }, size: { width: 300, height: 200 }, color: 'blue' as const },
        ],
      };
      const graph = FlowGraphSchema.parse(input);
      expect(graph.notes![0]).toMatchObject({ id: 'note_1', text: 'hi', color: 'blue' });
    });

    it('rejects duplicate note ids', () => {
      const res = FlowGraphSchema.safeParse({
        nodes: [],
        edges: [],
        notes: [{ id: 'dup' }, { id: 'dup' }],
      });
      expect(res.success).toBe(false);
      expect(JSON.stringify(res.error?.issues)).toContain('duplicate note id');
    });

    it('a note id may coincide with a node id (separate namespaces)', () => {
      // notes are never referenced by edges/engine, so no collision is possible.
      const res = FlowGraphSchema.safeParse({
        nodes: [{ id: 'shared', type: 'flow.if' }],
        edges: [],
        notes: [{ id: 'shared', text: 'note named like the node' }],
      });
      expect(res.success).toBe(true);
    });

    it('rejects an unknown note colour', () => {
      const res = StickyNoteSchema.safeParse({ id: 'n', color: 'rainbow' });
      expect(res.success).toBe(false);
    });

    it('clamps reject out-of-bounds sizes', () => {
      expect(StickyNoteSchema.safeParse({ id: 'n', size: { width: 10, height: 10 } }).success).toBe(false);
      expect(StickyNoteSchema.safeParse({ id: 'n', size: { width: 200, height: 200 } }).success).toBe(true);
    });
  });

  // ── node title / human name (H-T2) ─────────────────────────────────────────
  describe('node title (H-T2)', () => {
    it('a node WITHOUT a title parses unchanged — title is optional/absent', () => {
      const graph = FlowGraphSchema.parse({
        nodes: [{ id: 'a', type: 'flow.if' }],
        edges: [],
      });
      expect(graph.nodes[0]!.title).toBeUndefined();
    });

    it('the hand-written sample flow (no titles) still parses byte-identically', () => {
      const graph = FlowGraphSchema.parse(sampleFlow);
      expect(graph.nodes.every((n) => n.title === undefined)).toBe(true);
    });

    it('parses and preserves a custom node title', () => {
      const graph = FlowGraphSchema.parse({
        nodes: [{ id: 'a', type: 'tg.sendMessage', title: 'Welcome message' }],
        edges: [],
      });
      expect(graph.nodes[0]!.title).toBe('Welcome message');
    });

    it('a title may use any script (RTL/Persian) and is presentational only', () => {
      const graph = FlowGraphSchema.parse({
        nodes: [{ id: 'a', type: 'tg.sendMessage', title: 'پیام خوش‌آمد' }],
        edges: [],
      });
      expect(graph.nodes[0]!.title).toBe('پیام خوش‌آمد');
    });

    it('rejects a title longer than 120 chars', () => {
      const res = FlowGraphSchema.safeParse({
        nodes: [{ id: 'a', type: 'flow.if', title: 'x'.repeat(121) }],
        edges: [],
      });
      expect(res.success).toBe(false);
    });

    it('accepts a title exactly 120 chars', () => {
      const res = FlowGraphSchema.safeParse({
        nodes: [{ id: 'a', type: 'flow.if', title: 'x'.repeat(120) }],
        edges: [],
      });
      expect(res.success).toBe(true);
    });
  });
});
