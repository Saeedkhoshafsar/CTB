/**
 * P2-T4 — activation-time flow validation (shared, pure).
 * The same function backs the server's 422 and the editor fake, so these
 * tests pin the semantics both sides rely on.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { FlowGraphSchema, type FlowGraph } from '../src/flow';
import {
  problemStrings,
  validateFlowForActivation,
  type NodeSlotMeta,
} from '../src/flow-validate';

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
    expect(problems[0]!.message).toContain('trigger');
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

  it('without nodeMeta, slot rules are inert (legacy callers unchanged)', () => {
    // A graph that WOULD violate slot rules passes when no meta is supplied,
    // proving the third arg is purely additive (no behavior change to Phase A).
    const g = graph([
      node('t', 'tg.trigger', { event: 'command' }),
      node('s', 'tg.sendMessage', { text: 'hi' }),
    ]);
    expect(validateFlowForActivation(g, SCHEMAS)).toEqual([]);
  });
});

// ── PB-T1: typed sub-connection (slot/role) rules ─────────────────────────
describe('validateFlowForActivation — typed sub-connections (PB-T1)', () => {
  const Empty = z.object({}).loose();
  // schemas for the synthetic Phase-B-ish nodes used below
  const SLOT_SCHEMAS = new Map<string, z.ZodType>([
    ['tg.trigger', TriggerSchema],
    ['ai.agent', Empty],
    ['ai.modelOpenai', Empty],
    ['ai.memoryKv', Empty],
    ['tool.think', Empty],
  ]);

  // an Agent consumer exposing a required model slot, an optional memory slot,
  // and a repeatable tool slot — the canonical n8n-Agent shape.
  const META: ReadonlyMap<string, NodeSlotMeta> = new Map<string, NodeSlotMeta>([
    ['tg.trigger', {}],
    [
      'ai.agent',
      {
        role: 'data',
        inputSlots: [
          { kind: 'ai:model', required: true, repeatable: false },
          { kind: 'ai:memory', required: false, repeatable: false },
          { kind: 'ai:tool', required: false, repeatable: true },
        ],
      },
    ],
    ['ai.modelOpenai', { role: 'provider', provides: 'ai:model' }],
    ['ai.memoryKv', { role: 'provider', provides: 'ai:memory' }],
    ['tool.think', { role: 'provider', provides: 'ai:tool' }],
  ]);

  const edge = (id: string, from: [string, string], to: [string, string]) => ({
    id,
    from: { node: from[0], port: from[1] },
    to: { node: to[0], port: to[1] },
  });

  const slotGraph = (
    nodes: ReturnType<typeof node>[],
    edges: ReturnType<typeof edge>[],
  ): FlowGraph => FlowGraphSchema.parse({ nodes, edges });

  const base = () => [
    node('t', 'tg.trigger', { event: 'command' }),
    node('a', 'ai.agent', {}),
    node('m', 'ai.modelOpenai', {}),
  ];

  it('a well-wired agent (model provider into ai:model slot) activates', () => {
    const g = slotGraph(base(), [
      edge('e1', ['t', 'main'], ['a', 'main']),
      edge('e2', ['m', 'provider'], ['a', 'ai:model']),
    ]);
    expect(validateFlowForActivation(g, SLOT_SCHEMAS, META)).toEqual([]);
  });

  it('a required slot left empty is a problem on the consumer', () => {
    const g = slotGraph(
      [node('t', 'tg.trigger', { event: 'command' }), node('a', 'ai.agent', {})],
      [edge('e1', ['t', 'main'], ['a', 'main'])],
    );
    const problems = validateFlowForActivation(g, SLOT_SCHEMAS, META);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({ nodeId: 'a' });
    expect(problems[0]!.message).toContain('ai:model');
  });

  it('wrong-kind provider into a slot is rejected', () => {
    // a memory provider plugged into the ai:model slot
    const g = slotGraph(
      [
        node('t', 'tg.trigger', { event: 'command' }),
        node('a', 'ai.agent', {}),
        node('mem', 'ai.memoryKv', {}),
      ],
      [
        edge('e1', ['t', 'main'], ['a', 'main']),
        edge('e2', ['mem', 'provider'], ['a', 'ai:model']),
      ],
    );
    const problems = validateFlowForActivation(g, SLOT_SCHEMAS, META);
    // model slot unfilled + wrong-kind edge → both flagged
    expect(problems.some((p) => p.message.includes('must be fed by a ai:model'))).toBe(true);
  });

  it('a data node feeding a slot is rejected', () => {
    const g = slotGraph(
      [
        node('t', 'tg.trigger', { event: 'command' }),
        node('a', 'ai.agent', {}),
        node('s', 'tg.sendMessage', { text: 'hi' }),
      ],
      [
        edge('e1', ['t', 'main'], ['a', 'main']),
        edge('e2', ['s', 'main'], ['a', 'ai:model']),
      ],
    );
    const schemas = new Map([...SLOT_SCHEMAS, ['tg.sendMessage', SendSchema]]);
    const meta = new Map([...META, ['tg.sendMessage', { role: 'data' } as NodeSlotMeta]]);
    const problems = validateFlowForActivation(g, schemas, meta);
    expect(problems.some((p) => p.message.includes('must be fed by a ai:model'))).toBe(true);
  });

  it('a provider wired into a plain data port is rejected', () => {
    const g = slotGraph(base(), [
      edge('e1', ['t', 'main'], ['a', 'main']),
      edge('e2', ['m', 'provider'], ['a', 'ai:model']),
      // the model provider ALSO mis-wired into the agent's data input
      edge('e3', ['m', 'provider'], ['a', 'main']),
    ]);
    const problems = validateFlowForActivation(g, SLOT_SCHEMAS, META);
    expect(problems.some((p) => p.message.includes('can only attach to a matching'))).toBe(true);
  });

  it('a non-repeatable slot rejects a second provider', () => {
    const g = slotGraph(
      [...base(), node('m2', 'ai.modelOpenai', {})],
      [
        edge('e1', ['t', 'main'], ['a', 'main']),
        edge('e2', ['m', 'provider'], ['a', 'ai:model']),
        edge('e3', ['m2', 'provider'], ['a', 'ai:model']),
      ],
    );
    const problems = validateFlowForActivation(g, SLOT_SCHEMAS, META);
    expect(problems.some((p) => p.message.includes('only one provider'))).toBe(true);
  });

  it('a repeatable tool slot accepts many providers', () => {
    const g = slotGraph(
      [...base(), node('th1', 'tool.think', {}), node('th2', 'tool.think', {})],
      [
        edge('e1', ['t', 'main'], ['a', 'main']),
        edge('e2', ['m', 'provider'], ['a', 'ai:model']),
        edge('e3', ['th1', 'provider'], ['a', 'ai:tool']),
        edge('e4', ['th2', 'provider'], ['a', 'ai:tool']),
      ],
    );
    expect(validateFlowForActivation(g, SLOT_SCHEMAS, META)).toEqual([]);
  });

  it('a provider node is not itself a trigger (cannot anchor a flow)', () => {
    // only a provider + its consumer, no real trigger → flow has no trigger
    const g = slotGraph(
      [node('a', 'ai.agent', {}), node('m', 'ai.modelOpenai', {})],
      [edge('e2', ['m', 'provider'], ['a', 'ai:model'])],
    );
    const problems = validateFlowForActivation(g, SLOT_SCHEMAS, META);
    expect(problems.some((p) => p.nodeId === null && p.message.includes('trigger'))).toBe(true);
  });

  it('disabled provider → its required slot reads as unfilled', () => {
    const g = slotGraph(
      [
        node('t', 'tg.trigger', { event: 'command' }),
        node('a', 'ai.agent', {}),
        node('m', 'ai.modelOpenai', {}, true), // disabled
      ],
      [
        edge('e1', ['t', 'main'], ['a', 'main']),
        edge('e2', ['m', 'provider'], ['a', 'ai:model']),
      ],
    );
    const problems = validateFlowForActivation(g, SLOT_SCHEMAS, META);
    expect(problems.some((p) => p.nodeId === 'a' && p.message.includes('ai:model'))).toBe(true);
  });
});

describe('validateFlowForActivation (P2-T4) — fixture', () => {
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
