/**
 * PB-T5 — the `ai.modelOpenai` chat-model PROVIDER + its params schema.
 *
 * Two surfaces are under test:
 *  1. The PROVIDER node — it registers as `role:'provider'`,
 *     `provides:'ai:model'`, takes no data input, emits only the dashed
 *     `provider` wire, and fails loudly if ever run as a data step (a provider
 *     is resolved as a consumer's config, never executed in the data flow).
 *  2. The params schema (`AiModelOpenaiParamsSchema`) — it requires a credential,
 *     defaults the model, and accepts optional sampling knobs. The CONSUMING
 *     agent reads these from `ctx.slots['ai:model']` (covered in ai-agent.test).
 */
import { describe, expect, it } from 'vitest';
import { builtinNodes } from '../src/index';
import { aiModelOpenai } from '../src/ai/model-openai';
import { AiModelOpenaiParamsSchema } from '@ctb/shared';
import { makeCtx } from './node-harness';

describe('ai.modelOpenai — registration & contract (PB-T5)', () => {
  it('is registered in the builtins; registry is 53 types', () => {
    const types = builtinNodes.map((n) => n.type);
    expect(types).toContain('ai.modelOpenai');
    expect(builtinNodes.length).toBe(54);
  });

  it('is an ai:model provider with no data input and a single provider output', () => {
    expect(aiModelOpenai.type).toBe('ai.modelOpenai');
    expect(aiModelOpenai.category).toBe('ai');
    expect(aiModelOpenai.role).toBe('provider');
    expect(aiModelOpenai.provides).toBe('ai:model');
    expect(aiModelOpenai.ports.inputs).toEqual([]);
    expect(aiModelOpenai.ports.outputs).toEqual(['provider']);
  });

  it('fails loudly if it is ever executed as a data step', async () => {
    const ctx = makeCtx({});
    const res = await aiModelOpenai.execute(ctx, AiModelOpenaiParamsSchema.parse({ credentialId: 'c1' }), []);
    expect(res.kind).toBe('error');
    if (res.kind === 'error') expect(res.message).toMatch(/not executed as a data step/);
  });
});

describe('AiModelOpenaiParamsSchema (PB-T5)', () => {
  it('requires a credential', () => {
    expect(() => AiModelOpenaiParamsSchema.parse({})).toThrow();
    expect(() => AiModelOpenaiParamsSchema.parse({ credentialId: '' })).toThrow();
  });

  it('defaults the model and leaves sampling knobs optional', () => {
    const p = AiModelOpenaiParamsSchema.parse({ credentialId: 'c1' });
    expect(p.model).toBe('gpt-4o-mini');
    expect(p.temperature).toBeUndefined();
    expect(p.max_tokens).toBeUndefined();
  });

  it('accepts a model name + sampling knobs', () => {
    const p = AiModelOpenaiParamsSchema.parse({
      credentialId: 'c1',
      model: 'gpt-4o',
      temperature: 0.2,
      max_tokens: 512,
    });
    expect(p).toMatchObject({ credentialId: 'c1', model: 'gpt-4o', temperature: 0.2, max_tokens: 512 });
  });

  it('rejects an out-of-range temperature', () => {
    expect(() => AiModelOpenaiParamsSchema.parse({ credentialId: 'c1', temperature: 5 })).toThrow();
  });
});
