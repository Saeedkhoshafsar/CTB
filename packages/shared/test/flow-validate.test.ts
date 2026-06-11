/**
 * P2-T4 — activation-time flow validation (shared, pure).
 * The same function backs the server's 422 and the editor fake, so these
 * tests pin the semantics both sides rely on.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { FlowGraphSchema, type FlowGraph } from '../src/flow';
import { problemStrings, validateFlowForActivation } from '../src/flow-validate';

const TriggerSchema = z.object({ event: z.enum(['command', 'any_message']) });
const SendSchema = z.object({ text: z.string().min(1) });
const SCHEMAS = new Map<string, z.ZodType>([
  ['tg.trigger', TriggerSchema],
  ['tg.sendMessage', SendSchema],
]);

const node = (id: string, type: string, params: Record<string, unknown>, disabled = false) => ({
  id,
  type,
  params,
  position: { x: 0, y: 0 },
  ...(disabled ? { disabled } : {}),
});

const graph = (nodes: ReturnType<typeof node>[]): FlowGraph =>
  FlowGraphSchema.parse({ nodes, edges: [] });

describe('validateFlowForActivation (P2-T4)', () => {
  it('valid graph → no problems', () => {
    const g = graph([
      node('t', 'tg.trigger', { event: 'command' }),
      node('s', 'tg.sendMessage', { text: 'سلام' }),
    ]);
    expect(validateFlowForActivation(g, SCHEMAS)).toEqual([]);
  });

  it('no enabled trigger → flow-level problem (nodeId null)', () => {
    const g = graph([node('t', 'tg.trigger', { event: 'command' }, true)]);
    const problems = validateFlowForActivation(g, SCHEMAS);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({ nodeId: null });
    expect(problems[0]!.message).toContain('tg.trigger');
  });

  it('invalid params → problem pinned to the offending node with the path', () => {
    const g = graph([
      node('t', 'tg.trigger', { event: 'command' }),
      node('s', 'tg.sendMessage', { text: '' }), // min(1) violated
    ]);
    const problems = validateFlowForActivation(g, SCHEMAS);
    expect(problems).toHaveLength(1);
    expect(problems[0]!.nodeId).toBe('s');
    expect(problems[0]!.message).toMatch(/^text:/);
  });

  it('disabled nodes are skipped (their params never run)', () => {
    const g = graph([
      node('t', 'tg.trigger', { event: 'command' }),
      node('s', 'tg.sendMessage', { text: '' }, true),
    ]);
    expect(validateFlowForActivation(g, SCHEMAS)).toEqual([]);
  });

  it('unknown node type → problem on that node', () => {
    const g = graph([
      node('t', 'tg.trigger', { event: 'command' }),
      node('x', 'ghost.node', {}),
    ]);
    const problems = validateFlowForActivation(g, SCHEMAS);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({ nodeId: 'x' });
    expect(problems[0]!.message).toContain('ghost.node');
  });

  it('expression values ({{ }}) are never judged — issue skipped', () => {
    // event must be an enum, but an expression resolves only at runtime
    const g = graph([
      node('t', 'tg.trigger', { event: 'command' }),
      node('s', 'tg.sendMessage', { text: '{{ $vars.greeting }}' }),
    ]);
    // text min(1) passes here, so force a failure shape with a number schema
    const NumSchema = z.object({ n: z.number() });
    const withExpr = graph([
      node('t', 'tg.trigger', { event: 'command' }),
      node('m', 'data.num', { n: '{{ $json.count }}' }),
    ]);
    expect(validateFlowForActivation(g, SCHEMAS)).toEqual([]);
    expect(
      validateFlowForActivation(withExpr, new Map([...SCHEMAS, ['data.num', NumSchema]])),
    ).toEqual([]);
  });

  it('problemStrings flattens with node prefix', () => {
    expect(
      problemStrings([
        { nodeId: null, message: 'flow-level' },
        { nodeId: 'a', message: 'bad param' },
      ]),
    ).toEqual(['flow-level', 'a: bad param']);
  });

  it('the real sample-flow fixture is activatable against real schemas', async () => {
    const { TgTriggerParamsSchema, TgSendMessageParamsSchema, TgWaitForReplyParamsSchema } =
      await import('../src/node-params');
    const { FlowIfParamsSchema, DataSetFieldsParamsSchema, FlowStopErrorParamsSchema } =
      await import('../src/node-params');
    const real = new Map<string, z.ZodType>([
      ['tg.trigger', TgTriggerParamsSchema],
      ['tg.sendMessage', TgSendMessageParamsSchema],
      ['tg.waitForReply', TgWaitForReplyParamsSchema],
      ['flow.if', FlowIfParamsSchema],
      ['data.setFields', DataSetFieldsParamsSchema],
      ['flow.stopError', FlowStopErrorParamsSchema],
    ]);
    const fixture = FlowGraphSchema.parse(
      JSON.parse(readFileSync(new URL('./fixtures/sample-flow.json', import.meta.url), 'utf8')),
    );
    expect(validateFlowForActivation(fixture, real)).toEqual([]);
  });
});
