/**
 * Node library docs model (PD-T4) — unit tests for the pure transform that
 * turns the node CATALOG (NodeTypeInfo[]) into the browsable docs structure.
 *
 * The model is what makes the registry browsable; these tests pin its
 * behaviour against the SAME catalog fixture the editor's fake server serves
 * (FAKE_NODE_TYPES, whose param schemas are the genuine @ctb/shared Zod
 * schemas converted exactly like the real GET /api/node-types). So a node
 * added to the registry — with its real params — is exercised here too, and
 * the docs can never advertise a param the form wouldn't render.
 */
import type { NodeTypeInfo } from '@ctb/shared';
import { describe, expect, it } from 'vitest';
import {
  buildDocs,
  defaultText,
  DOC_CATEGORY_ORDER,
  filterDocs,
  paramsOf,
  summarizeType,
  toDocNode,
  totalNodes,
} from '../src/pages/node-docs/model';
import { ApiClient } from '../src/api/client';
import { createAuthStore } from '../src/stores/auth';
import { createFakeServer, FAKE_NODE_TYPES } from './fake-fetch';
import type { JsonSchema } from '../src/form/schema';

describe('node-docs model — summarizeType', () => {
  it('summarizes primitives', () => {
    expect(summarizeType({ type: 'string' })).toBe('string');
    expect(summarizeType({ type: 'number' })).toBe('number');
    expect(summarizeType({ type: 'integer' })).toBe('integer');
    expect(summarizeType({ type: 'boolean' })).toBe('boolean');
    expect(summarizeType({ type: 'object' })).toBe('object');
  });

  it('summarizes enums as "one of"', () => {
    expect(summarizeType({ enum: ['a', 'b', 'c'] })).toBe('one of: a, b, c');
  });

  it('summarizes const as "= value"', () => {
    expect(summarizeType({ const: 'inline' })).toBe('= inline');
  });

  it('summarizes arrays as "list of <item>"', () => {
    expect(summarizeType({ type: 'array', items: { type: 'string' } })).toBe('list of string');
    expect(summarizeType({ type: 'array' })).toBe('list');
  });

  it('summarizes unions, de-duplicated', () => {
    expect(
      summarizeType({ anyOf: [{ type: 'number' }, { type: 'string' }] }),
    ).toBe('number | string');
    // de-dup: two string branches collapse to one
    expect(
      summarizeType({ anyOf: [{ type: 'string' }, { type: 'string' }] }),
    ).toBe('string');
  });

  it('treats the empty (z.unknown) schema as "any"', () => {
    expect(summarizeType({})).toBe('any');
  });
});

describe('node-docs model — defaultText', () => {
  it('returns null when no default', () => {
    expect(defaultText({ type: 'string' })).toBeNull();
  });
  it('shows empty string as ""', () => {
    expect(defaultText({ type: 'string', default: '' })).toBe('""');
  });
  it('stringifies non-empty defaults', () => {
    expect(defaultText({ type: 'string', default: 'hi' })).toBe('hi');
    expect(defaultText({ type: 'number', default: 5 })).toBe('5');
    expect(defaultText({ type: 'boolean', default: true })).toBe('true');
    expect(defaultText({ type: 'array', default: [] })).toBe('[]');
  });
});

describe('node-docs model — paramsOf', () => {
  it('projects top-level fields with required/widget/type', () => {
    const send = FAKE_NODE_TYPES.find((n) => n.type === 'tg.sendMessage')!;
    const params = paramsOf(send);
    expect(params.length).toBeGreaterThan(0);
    const keys = params.map((p) => p.key);
    // sendMessage definitely has a chat target + a text/body field
    expect(keys).toContain('chat');
    for (const p of params) {
      expect(typeof p.key).toBe('string');
      expect(typeof p.required).toBe('boolean');
      expect(typeof p.typeSummary).toBe('string');
    }
  });

  it('returns [] for a node whose params schema has no object fields', () => {
    // A synthetic node with a bare union params schema — no top-level props.
    const synthetic: NodeTypeInfo = {
      type: 'x.union',
      category: 'data',
      meta: { labelKey: 'nodes.x.union.label' },
      ports: { inputs: ['main'], outputs: ['main'] },
      paramsJsonSchema: { anyOf: [{ type: 'string' }, { type: 'number' }] } as JsonSchema as Record<string, unknown>,
    };
    expect(paramsOf(synthetic)).toEqual([]);
  });
});

describe('node-docs model — toDocNode', () => {
  it('marks a no-input node as a trigger', () => {
    const trig = FAKE_NODE_TYPES.find((n) => n.type === 'tg.trigger')!;
    const doc = toDocNode(trig);
    expect(doc.isTrigger).toBe(true);
    expect(doc.inputs).toEqual([]);
    expect(doc.outputs).toEqual(['main']);
    expect(doc.labelKey).toBe('nodes.tg.trigger.label');
  });

  it('carries ports, descriptionKey (null when absent) and category', () => {
    const send = FAKE_NODE_TYPES.find((n) => n.type === 'tg.sendMessage')!;
    const doc = toDocNode(send);
    expect(doc.isTrigger).toBe(false);
    expect(doc.inputs).toEqual(['main']);
    expect(doc.category).toBe('telegram');
    // FAKE fixtures don't set descriptionKey → null (not undefined)
    expect(doc.descriptionKey).toBeNull();
  });
});

describe('node-docs model — buildDocs', () => {
  it('groups nodes by category in palette order, nodes sorted by type', () => {
    const cats = buildDocs(FAKE_NODE_TYPES);
    // every category present must be in DOC_CATEGORY_ORDER for this fixture
    for (const c of cats) {
      expect(DOC_CATEGORY_ORDER).toContain(c.category as (typeof DOC_CATEGORY_ORDER)[number]);
    }
    // categories appear in the canonical order
    const order = cats.map((c) => c.category);
    const expectedOrder = DOC_CATEGORY_ORDER.filter((c) => order.includes(c));
    expect(order).toEqual(expectedOrder);
    // nodes within a category are sorted by type
    for (const c of cats) {
      const types = c.nodes.map((n) => n.type);
      expect(types).toEqual([...types].sort((a, b) => a.localeCompare(b)));
    }
    // total is preserved
    expect(totalNodes(cats)).toBe(FAKE_NODE_TYPES.length);
  });

  it('appends an unknown category after the known ones', () => {
    // A future category not in DOC_CATEGORY_ORDER — cast past the typed union to
    // simulate a registry that grows a new category the docs page hasn't ranked.
    const custom = {
      type: 'z.custom',
      category: 'zzz-custom',
      meta: { labelKey: 'nodes.z.custom.label' },
      ports: { inputs: ['main'], outputs: ['main'] },
      paramsJsonSchema: { type: 'object', properties: {} } as Record<string, unknown>,
    } as unknown as NodeTypeInfo;
    const withExtra: NodeTypeInfo[] = [...FAKE_NODE_TYPES, custom];
    const cats = buildDocs(withExtra);
    expect(cats[cats.length - 1]!.category).toBe('zzz-custom');
  });
});

describe('node-docs model — filterDocs', () => {
  const cats = buildDocs(FAKE_NODE_TYPES);
  // identity label resolver (search by raw key/type for determinism)
  const id = (k: string) => k;

  it('returns everything for an empty query', () => {
    expect(totalNodes(filterDocs(cats, '', id))).toBe(FAKE_NODE_TYPES.length);
    expect(totalNodes(filterDocs(cats, '   ', id))).toBe(FAKE_NODE_TYPES.length);
  });

  it('matches by node type substring', () => {
    const res = filterDocs(cats, 'tg.', id);
    const types = res.flatMap((c) => c.nodes.map((n) => n.type));
    expect(types.every((t) => t.startsWith('tg.'))).toBe(true);
    expect(types.length).toBeGreaterThan(0);
  });

  it('matches by label key via the resolver', () => {
    const res = filterDocs(cats, 'sendMessage', id);
    const types = res.flatMap((c) => c.nodes.map((n) => n.type));
    expect(types).toContain('tg.sendMessage');
  });

  it('matches by param key', () => {
    const res = filterDocs(cats, 'chat', id);
    const types = res.flatMap((c) => c.nodes.map((n) => n.type));
    expect(types).toContain('tg.sendMessage');
  });

  it('drops empty categories and returns [] when nothing matches', () => {
    const res = filterDocs(cats, 'definitely-no-such-node-xyz', id);
    expect(res).toEqual([]);
    expect(totalNodes(res)).toBe(0);
  });
});

describe('node-docs model — against the live catalog endpoint', () => {
  it('builds docs from GET /api/node-types (fake server)', async () => {
    const srv = createFakeServer();
    const client = new ApiClient({ fetchImpl: srv.fetch });
    await createAuthStore(client).getState().login('admin', 'pw');
    const nodeTypes = await client.listNodeTypes();
    const cats = buildDocs(nodeTypes);
    expect(totalNodes(cats)).toBe(nodeTypes.length);
    // every documented node carries a non-empty type + label key
    for (const c of cats) {
      for (const n of c.nodes) {
        expect(n.type).toMatch(/\w/);
        expect(n.labelKey).toMatch(/^nodes\./);
      }
    }
  });
});
