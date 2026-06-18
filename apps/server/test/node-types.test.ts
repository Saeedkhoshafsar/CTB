/**
 * P2-T2 — GET /api/node-types contract tests.
 * The palette payload must mirror the executor's registry exactly and the
 * JSON Schemas must accept the same params the Zod schemas accept.
 */
import { NodeRegistry } from '@ctb/core';
import { registerBuiltinNodes } from '@ctb/nodes';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { nodeTypeInfos } from '../src/api/node-types';

const registry = registerBuiltinNodes(new NodeRegistry());
const infos = nodeTypeInfos(registry);

describe('nodeTypeInfos (P2-T2)', () => {
  it('exposes every registered builtin with category/meta/ports', () => {
    const types = infos.map((i) => i.type).sort();
    expect(types).toEqual(
      registry
        .list()
        .map((d) => d.type)
        .sort(),
    );
    // the P1 six
    for (const t of [
      'tg.trigger',
      'tg.sendMessage',
      'tg.waitForReply',
      'flow.if',
      'data.setFields',
      'flow.stopError',
    ]) {
      expect(types).toContain(t);
    }
    for (const info of infos) {
      expect(info.meta.labelKey).toBeTruthy();
      expect(Array.isArray(info.ports.inputs)).toBe(true);
      expect(Array.isArray(info.ports.outputs)).toBe(true);
    }
  });

  it('ports match the canvas edge contract (waitForReply: reply/invalid/timeout; if: true/false)', () => {
    const wait = infos.find((i) => i.type === 'tg.waitForReply')!;
    expect(wait.ports.outputs).toEqual(expect.arrayContaining(['reply', 'invalid', 'timeout']));
    const flowIf = infos.find((i) => i.type === 'flow.if')!;
    expect(flowIf.ports.outputs).toEqual(expect.arrayContaining(['true', 'false']));
    const trigger = infos.find((i) => i.type === 'tg.trigger')!;
    expect(trigger.ports.inputs).toEqual([]); // triggers have no inputs
  });

  it('paramsJsonSchema is plain JSON (survives stringify round-trip) and structurally sane', () => {
    for (const info of infos) {
      const round = JSON.parse(JSON.stringify(info.paramsJsonSchema));
      expect(round).toEqual(info.paramsJsonSchema);
      expect(typeof info.paramsJsonSchema).toBe('object');
    }
    // sample: sendMessage schema knows about its text param
    const send = infos.find((i) => i.type === 'tg.sendMessage')!;
    const schemaStr = JSON.stringify(send.paramsJsonSchema);
    expect(schemaStr).toContain('text');
  });

  // ── typed sub-connection surface (PB-T1) ────────────────────────────────
  it('omits role/inputSlots/provides for plain data nodes (Phase-A back-compat)', () => {
    // A plain data node (no slots, no provider role) must NOT carry any of the
    // new keys — its palette payload stays byte-identical to before PB-T1. The
    // builtins that opt in today are the PB-T4 memory providers + the PB-T5
    // `ai.modelOpenai` provider + the `ai.agent` consumer (which declares
    // inputSlots); we assert those separately below. Every other node here is
    // still a plain data node.
    const providers = new Set(['ai.memoryKv', 'ai.memoryPostgres', 'ai.modelOpenai']);
    const consumersWithSlots = new Set(['ai.agent']);
    for (const info of infos) {
      if (providers.has(info.type) || consumersWithSlots.has(info.type)) continue;
      expect(info).not.toHaveProperty('role');
      expect(info).not.toHaveProperty('inputSlots');
      expect(info).not.toHaveProperty('provides');
    }
  });

  it('surfaces role:provider + provides:ai:model for the PB-T5 ai.modelOpenai provider', () => {
    const info = infos.find((i) => i.type === 'ai.modelOpenai')!;
    expect(info).toBeDefined();
    expect(info.role).toBe('provider');
    expect(info.provides).toBe('ai:model');
    expect(info.ports.inputs).toEqual([]);
    expect(info.ports.outputs).toEqual(['provider']);
    expect(info).not.toHaveProperty('inputSlots');
  });

  it('surfaces the PB-T5 inputSlots for the real ai.agent builtin', () => {
    const agent = infos.find((i) => i.type === 'ai.agent')!;
    expect(agent).toBeDefined();
    // consumer: role defaults to 'data' so it is OMITTED from the payload
    expect(agent).not.toHaveProperty('role');
    expect(agent).not.toHaveProperty('provides');
    expect(agent.inputSlots).toEqual([
      { kind: 'ai:model', required: false, repeatable: false },
      { kind: 'ai:memory', required: false, repeatable: false },
      { kind: 'ai:tool', required: false, repeatable: true },
    ]);
  });

  it('surfaces role:provider + provides:ai:memory for the PB-T4 memory providers', () => {
    for (const type of ['ai.memoryKv', 'ai.memoryPostgres']) {
      const info = infos.find((i) => i.type === type)!;
      expect(info).toBeDefined();
      expect(info.role).toBe('provider');
      expect(info.provides).toBe('ai:memory');
      // providers take no data input and emit only the dashed provider wire
      expect(info.ports.inputs).toEqual([]);
      expect(info.ports.outputs).toEqual(['provider']);
      // a provider exposes no consumer slots
      expect(info).not.toHaveProperty('inputSlots');
    }
  });

  it('surfaces role/inputSlots/provides when a node opts in', () => {
    const reg = new NodeRegistry();
    reg.register({
      type: 'ai.agent',
      category: 'ai',
      role: 'data',
      inputSlots: [
        { kind: 'ai:model', required: true, repeatable: false },
        { kind: 'ai:memory', required: false, repeatable: false },
        { kind: 'ai:tool', required: false, repeatable: true },
      ],
      meta: { labelKey: 'node.ai.agent' },
      ports: { inputs: ['main'], outputs: ['main'] },
      paramsSchema: z.object({}),
      execute: async () => ({ kind: 'end' }),
    });
    reg.register({
      type: 'ai.modelOpenai',
      category: 'ai',
      role: 'provider',
      provides: 'ai:model',
      meta: { labelKey: 'node.ai.modelOpenai' },
      ports: { inputs: [], outputs: [] },
      paramsSchema: z.object({}),
      execute: async () => ({ kind: 'end' }),
    });

    const out = nodeTypeInfos(reg);
    const agent = out.find((i) => i.type === 'ai.agent')!;
    // consumer: role defaults to 'data' so it is OMITTED; slots are surfaced
    expect(agent).not.toHaveProperty('role');
    expect(agent).not.toHaveProperty('provides');
    expect(agent.inputSlots).toEqual([
      { kind: 'ai:model', required: true, repeatable: false },
      { kind: 'ai:memory', required: false, repeatable: false },
      { kind: 'ai:tool', required: false, repeatable: true },
    ]);

    const model = out.find((i) => i.type === 'ai.modelOpenai')!;
    expect(model.role).toBe('provider');
    expect(model.provides).toBe('ai:model');
    expect(model).not.toHaveProperty('inputSlots');

    // payload is plain JSON (slots survive a stringify round-trip)
    const round = JSON.parse(JSON.stringify(agent.inputSlots));
    expect(round).toEqual(agent.inputSlots);
  });
});
