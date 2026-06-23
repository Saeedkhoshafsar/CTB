/**
 * Fake nodes + harness for executor tests (P1-T4 acceptance).
 * Nodes here are deliberately tiny — they exist to exercise the LOOP,
 * not to be useful. Real nodes live in packages/nodes (P1-T6+).
 */
import { z } from 'zod';
import {
  end,
  fail,
  goto,
  out,
  wait,
  type FlowGraph,
  type FlowItem,
  type NodeDef,
} from '@ctb/shared';
import { Executor, type ExecutorServices, type StepLogEntry } from '../src/engine/executor';
import { NodeRegistry } from '../src/registry/registry';
import { MemoryExecutionStore } from '../src/store/memory';

/** test.emit — appends its `tag` param to every item's json.trail array. */
const emitNode: NodeDef<{ tag: string }> = {
  type: 'test.emit',
  category: 'data',
  meta: { labelKey: 'test.emit' },
  ports: { inputs: ['main'], outputs: ['main'] },
  paramsSchema: z.object({ tag: z.string() }),
  async execute(_ctx, params, items) {
    const next = items.map((i) => ({
      ...i,
      json: { ...i.json, trail: [...((i.json.trail as string[]) ?? []), params.tag] },
    }));
    return out({ main: next });
  },
};

/** test.branch — routes items to "true"/"false" based on json[field]. */
const branchNode: NodeDef<{ field: string }> = {
  type: 'test.branch',
  category: 'flow',
  meta: { labelKey: 'test.branch' },
  ports: { inputs: ['main'], outputs: ['true', 'false'] },
  paramsSchema: z.object({ field: z.string() }),
  async execute(_ctx, params, items) {
    const yes = items.filter((i) => Boolean(i.json[params.field]));
    const no = items.filter((i) => !i.json[params.field]);
    return out({ true: yes, false: no });
  },
};

/** test.goto — jumps to `target`, passing items through. */
const gotoNode: NodeDef<{ target: string }> = {
  type: 'test.goto',
  category: 'flow',
  meta: { labelKey: 'test.goto' },
  ports: { inputs: ['main'], outputs: [] },
  paramsSchema: z.object({ target: z.string() }),
  async execute(_ctx, params, items) {
    return goto(params.target, items);
  },
};

/** test.ask — first visit: WAIT for a reply; resume routes via "reply" port. */
const askNode: NodeDef<{ question: string }> = {
  type: 'test.ask',
  category: 'telegram',
  meta: { labelKey: 'test.ask' },
  ports: { inputs: ['main'], outputs: ['reply', 'timeout'] },
  paramsSchema: z.object({ question: z.string() }),
  async execute(ctx, params, _items) {
    ctx.log('info', `asking: ${params.question}`);
    return wait({ kind: 'reply', nodeId: 'UNSET', expect: 'text', retriesLeft: 0, timeoutAt: null });
  },
};

/** test.saveVar — copies json[from] into $vars[name] (conversation state). */
const saveVarNode: NodeDef<{ name: string; from: string }> = {
  type: 'test.saveVar',
  category: 'data',
  meta: { labelKey: 'test.saveVar' },
  ports: { inputs: ['main'], outputs: ['main'] },
  paramsSchema: z.object({ name: z.string(), from: z.string() }),
  async execute(ctx, params, items) {
    ctx.vars.set(params.name, items[0]?.json[params.from]);
    return out({ main: items });
  },
};

/** test.fail / test.end / test.boom — terminal behaviors. */
const failNode: NodeDef<{ message: string }> = {
  type: 'test.fail',
  category: 'flow',
  meta: { labelKey: 'test.fail' },
  ports: { inputs: ['main'], outputs: [] },
  paramsSchema: z.object({ message: z.string() }),
  async execute(_ctx, params) {
    return fail(params.message);
  },
};
const endNode: NodeDef<Record<string, never>> = {
  type: 'test.end',
  category: 'flow',
  meta: { labelKey: 'test.end' },
  ports: { inputs: ['main'], outputs: [] },
  paramsSchema: z.object({}),
  async execute() {
    return end();
  },
};
const boomNode: NodeDef<Record<string, never>> = {
  type: 'test.boom',
  category: 'data',
  meta: { labelKey: 'test.boom' },
  ports: { inputs: ['main'], outputs: ['main'] },
  paramsSchema: z.object({}),
  async execute() {
    throw new Error('kaboom');
  },
};

/**
 * test.provider — a `role:'provider'` sub-node (PB-T1). It throws if executed,
 * so any test that reaches `end` proves the executor SKIPPED it as a data step
 * rather than running it (providers are resolved as a consumer's config).
 */
const providerNode: NodeDef<Record<string, never>> = {
  type: 'test.provider',
  category: 'ai',
  role: 'provider',
  provides: 'ai:model',
  meta: { labelKey: 'test.provider' },
  ports: { inputs: [], outputs: [] },
  paramsSchema: z.object({}),
  async execute() {
    throw new Error('provider must never run as a data step');
  },
};

export function makeRegistry(): NodeRegistry {
  return new NodeRegistry()
    .register(emitNode)
    .register(branchNode)
    .register(gotoNode)
    .register(askNode)
    .register(saveVarNode)
    .register(failNode)
    .register(endNode)
    .register(boomNode)
    .register(providerNode);
}

export interface Harness {
  executor: Executor;
  store: MemoryExecutionStore;
  logs: StepLogEntry[];
  /** Items captured by the terminal "sink" pattern: read trail from store. */
}

export function makeHarness(overrides: Partial<ExecutorServices> = {}): Harness {
  let tick = 0;
  const store = new MemoryExecutionStore(() => new Date(1750000000000 + tick++ * 10));
  const logs: StepLogEntry[] = [];
  const services: ExecutorServices = {
    kv: () => ({
      get: async () => undefined,
      set: async () => undefined,
      delete: async () => undefined,
    }),
    http: {
      request: async () => ({ status: 200, headers: {}, body: null }),
    },
    tg: () => null,
    log: (e) => logs.push(e),
    clock: () => new Date(1750000000000 + tick++ * 10),
    ...overrides,
  };
  const executor = new Executor(makeRegistry(), store, services);
  return { executor, store, logs };
}

export function graph(nodes: { id: string; type: string; params?: Record<string, unknown>; disabled?: boolean; pinnedData?: FlowItem[] }[], edges: [string, string, string?, string?][]): FlowGraph {
  return {
    nodes: nodes.map((n) => ({
      id: n.id,
      type: n.type,
      params: n.params ?? {},
      position: { x: 0, y: 0 },
      disabled: n.disabled ?? false,
      ...(n.pinnedData !== undefined ? { pinnedData: n.pinnedData } : {}),
    })),
    edges: edges.map(([from, to, fromPort, toPort], i) => ({
      id: `e${i}`,
      from: { node: from, port: fromPort ?? 'main' },
      to: { node: to, port: toPort ?? 'main' },
    })),
  };
}

export const item = (json: Record<string, unknown>): FlowItem => ({ json });
export const FLOW = { id: 'flow1', name: 'تست' };
