import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  end, fail, goto, out, wait,
  type FlowItem, type NodeCtx, type NodeDef, type NodeResult,
} from '@ctb/shared';

describe('NodeResult helpers', () => {
  it('build the discriminated union correctly', () => {
    expect(out({ main: [{ json: {} }] }).kind).toBe('items');
    expect(wait({ kind: 'delay', nodeId: 'n', resumeAt: '2026-06-11T00:00:00.000Z' }).kind).toBe('wait');
    expect(goto('n2', []).kind).toBe('goto');
    expect(end().kind).toBe('end');
    expect(fail('boom').kind).toBe('error');
  });
});

describe('NodeDef contract', () => {
  it('a minimal typed node compiles and executes against the contract', async () => {
    const paramsSchema = z.object({ greeting: z.string().default('hi') });
    type P = z.infer<typeof paramsSchema>;

    const echoNode: NodeDef<P> = {
      type: 'data.echo',
      category: 'data',
      meta: { labelKey: 'nodes.echo.label' },
      ports: { inputs: ['main'], outputs: ['main'] },
      paramsSchema,
      async execute(_ctx: NodeCtx, params: P, items: FlowItem[]): Promise<NodeResult> {
        return out({ main: items.map((i) => ({ json: { ...i.json, greeting: params.greeting } })) });
      },
    };

    const fakeCtx = {} as NodeCtx; // contract-shape test only
    const res = await echoNode.execute(fakeCtx, { greeting: 'salam' }, [{ json: { a: 1 } }]);
    if (res.kind !== 'items') throw new Error('expected items');
    expect(res.outputs['main']?.[0]?.json).toEqual({ a: 1, greeting: 'salam' });
  });
});
