/**
 * Executor — the step loop of ARCHITECTURE §7 (P1-T4).
 *
 *   resolve node → eval param expressions → validate (Zod) → execute →
 *   route items per output port via edges → handle WAIT / GOTO / END / ERROR
 *
 * Durability (invariant I4): state is persisted through the ExecutionStore at
 * every WAIT, every `checkpointEvery` steps, and at finalization. `resume()`
 * reconstructs the loop from the stored state and injects the router's items
 * as the wait node's output on a chosen port.
 *
 * v1 scope notes (documented limits, not accidents):
 *  - Sequential engine: one active node at a time. Synchronous fan-out
 *    (multiple edges firing in one step) is handled with an in-run FIFO; if a
 *    WAIT occurs while other branches are still queued, the run fails loudly
 *    rather than silently dropping branches (per-chat mutex, ARCH §7).
 */
import {
  ExecutionBudgetError,
  UnknownNodeTypeError,
  type Execution,
  type ExecutionState,
  type FlowGraph,
  type FlowItem,
  type FlowNode,
  type NodeCtx,
  type NodeId,
  type NodeResult,
  type PortName,
  type WaitSpec,
} from '@ctb/shared';
import type { EvaluateOptions } from '../expression/evaluator';
import { renderTemplate } from '../expression/evaluator';
import { buildScope, type ExpressionScope } from '../expression/scope';
import type { NodeRegistry } from '../registry/registry';
import type { ExecutionStore } from '../store/types';
import { resolveParams } from './params';

export const DEFAULT_MAX_STEPS = 1000;
export const DEFAULT_CHECKPOINT_EVERY = 25;

/** Per-step structured logging hook — server wires this to exec_logs. */
export interface StepLogEntry {
  executionId: string;
  nodeId: NodeId | null;
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
  data?: unknown;
  durationMs?: number;
  ts: string;
}
export type StepLogger = (entry: StepLogEntry) => void;

/** Host-injected capabilities handed to nodes via NodeCtx (invariant I3/I6). */
export interface ExecutorServices {
  kv: NodeCtx['kv'];
  http: NodeCtx['http'];
  /** Telegram sender factory — null when the execution has no chat context. */
  tg: (chatId: number | null) => NodeCtx['tg'];
  log?: StepLogger;
  evalOptions?: EvaluateOptions;
  clock?: () => Date;
  maxSteps?: number;
  checkpointEvery?: number;
}

export interface FlowRef {
  id: string;
  name: string;
}

export interface StartInput {
  executionId: string;
  flow: FlowRef;
  graph: FlowGraph;
  botId: string;
  chatId?: number | null;
  userId?: string | null;
  /** Where the run enters the graph (the trigger's target) + initial items. */
  entry: { nodeId: NodeId; items?: Record<PortName, FlowItem[]> };
}

export interface ResumeInput {
  executionId: string;
  graph: FlowGraph;
  flow: FlowRef;
  /** Output port of the wait node the injected items leave through. */
  port: PortName;
  items: FlowItem[];
  /**
   * $vars entries applied before the loop continues (durable — part of the
   * persisted state). Used by the router for WaitSpec.saveTo (Decision Log #14):
   * the wait node never re-executes on resume, so it can't save its own reply.
   */
  varsPatch?: Record<string, unknown>;
}

export interface RunResult {
  status: Execution['status'];
  steps: number;
  error: string | null;
  /** Set when status === 'waiting'. */
  wait: WaitSpec | null;
}

/** One pending node activation inside a single run (in-memory frontier). */
interface Activation {
  nodeId: NodeId;
  items: Record<PortName, FlowItem[]>;
}

export class Executor {
  private readonly clock: () => Date;
  private readonly maxSteps: number;
  private readonly checkpointEvery: number;

  constructor(
    private readonly registry: NodeRegistry,
    private readonly store: ExecutionStore,
    private readonly services: ExecutorServices,
  ) {
    this.clock = services.clock ?? (() => new Date());
    this.maxSteps = services.maxSteps ?? DEFAULT_MAX_STEPS;
    this.checkpointEvery = services.checkpointEvery ?? DEFAULT_CHECKPOINT_EVERY;
  }

  /** Trigger fired: create the execution row and run until wait/end/error. */
  async start(input: StartInput): Promise<RunResult> {
    const state: ExecutionState = {
      cursor: input.entry.nodeId,
      items: input.entry.items ?? { main: [{ json: {} }] },
      vars: {},
      steps: 0,
    };
    const exec = await this.store.create({
      id: input.executionId,
      flowId: input.flow.id,
      botId: input.botId,
      chatId: input.chatId ?? null,
      userId: input.userId ?? null,
      state,
    });
    return this.runLoop(exec, input.graph, input.flow, state);
  }

  /**
   * Router matched an update (or a timeout fired): inject `items` as the wait
   * node's output on `port` and continue from the stored state (ARCH §7).
   */
  async resume(input: ResumeInput): Promise<RunResult> {
    const exec = await this.store.load(input.executionId);
    if (!exec) throw new Error(`execution ${input.executionId} not found`);
    if (exec.status !== 'waiting' || !exec.wait) {
      throw new Error(`execution ${input.executionId} is not waiting (status=${exec.status})`);
    }
    const state: ExecutionState = structuredClone(exec.state);
    if (input.varsPatch) Object.assign(state.vars, input.varsPatch);
    const edges = indexEdges(input.graph);
    const next = routeOutputs(edges, exec.wait.nodeId, { [input.port]: input.items });
    // waiting → running, wait cleared (the wait is consumed by this injection)
    await this.store.save({ id: exec.id, status: 'running', state, wait: null });

    if (next.length === 0) {
      // wait node's port is unconnected → conversation simply ends
      await this.finalize(exec.id, state, 'done', null);
      return { status: 'done', steps: state.steps, error: null, wait: null };
    }
    const first = next[0]!;
    const rest = next.slice(1);
    state.cursor = first.nodeId;
    state.items = first.items;
    return this.runLoop({ ...exec, status: 'running' }, input.graph, input.flow, state, rest);
  }

  // ── internals ────────────────────────────────────────────────────────────

  private async runLoop(
    exec: Execution,
    graph: FlowGraph,
    flow: FlowRef,
    state: ExecutionState,
    initialQueue: Activation[] = [],
  ): Promise<RunResult> {
    const nodes = new Map<NodeId, FlowNode>(graph.nodes.map((n) => [n.id, n]));
    const edges = indexEdges(graph);
    const queue: Activation[] = [...initialQueue];
    // Wall-time budget is per RUN (this loop invocation), NOT since the
    // execution started — conversations legitimately span days across waits.
    const runStartMs = this.clock().getTime();

    while (state.cursor !== null) {
      // ── budget ──
      if (state.steps >= this.maxSteps) {
        const err = new ExecutionBudgetError(
          `execution exceeded maxSteps=${this.maxSteps} (possible loop)`,
        );
        return this.failRun(exec.id, state, err.message);
      }
      state.steps += 1;

      const node = nodes.get(state.cursor);
      if (!node) {
        return this.failRun(exec.id, state, `cursor points to unknown node "${state.cursor}"`);
      }

      const inputItems = mergeInputs(state.items);
      let result: NodeResult;
      const stepStart = this.clock().getTime();

      if (node.disabled) {
        // disabled nodes are skipped — items pass through "main"
        result = { kind: 'items', outputs: { main: inputItems } };
        this.log(exec.id, node.id, 'debug', `node "${node.id}" disabled — passing through`);
      } else {
        try {
          result = await this.executeNode(exec, flow, node, inputItems, state);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          const tag = err instanceof UnknownNodeTypeError ? 'unknown node type' : 'node failed';
          return this.failRun(exec.id, state, `${tag} at "${node.id}": ${message}`);
        }
      }

      this.log(exec.id, node.id, 'debug', `executed ${node.type}`, {
        kind: result.kind,
        durationMs: this.clock().getTime() - stepStart,
      });

      // ── route the result ──
      switch (result.kind) {
        case 'items': {
          const next = routeOutputs(edges, node.id, result.outputs);
          queue.push(...next);
          break;
        }
        case 'wait': {
          if (queue.length > 0) {
            return this.failRun(
              exec.id,
              state,
              `node "${node.id}" returned WAIT while ${queue.length} branch(es) are still queued — parallel branches across a wait are not supported in v1`,
            );
          }
          // Nodes don't know their own graph id — the executor stamps it so
          // resume() always routes from the right node.
          const waitSpec: WaitSpec = { ...result.wait, nodeId: node.id };
          // cursor stays on the wait node; resume() routes from it
          state.cursor = node.id;
          await this.store.save({ id: exec.id, status: 'waiting', state, wait: waitSpec });
          this.log(exec.id, node.id, 'info', `waiting (${waitSpec.kind})`);
          return { status: 'waiting', steps: state.steps, error: null, wait: waitSpec };
        }
        case 'goto': {
          if (!nodes.has(result.nodeId)) {
            return this.failRun(exec.id, state, `goto from "${node.id}" to unknown node "${result.nodeId}"`);
          }
          queue.push({ nodeId: result.nodeId, items: { main: result.items } });
          break;
        }
        case 'end': {
          await this.finalize(exec.id, state, 'done', null);
          this.log(exec.id, node.id, 'info', 'flow ended (END)');
          return { status: 'done', steps: state.steps, error: null, wait: null };
        }
        case 'error': {
          return this.failRun(exec.id, state, `node "${node.id}": ${result.message}`);
        }
      }

      // ── advance cursor from the frontier ──
      const next = queue.shift();
      if (next) {
        state.cursor = next.nodeId;
        state.items = next.items;
      } else {
        state.cursor = null; // nothing connected → natural end
        state.items = {};
      }

      // ── periodic checkpoint (crash recovery, I4) ──
      if (state.cursor !== null && state.steps % this.checkpointEvery === 0) {
        await this.store.checkpoint(exec.id, state);
      }

      // ── wall-time safety (uses injectable clock) ──
      if (this.clock().getTime() - runStartMs > 5 * 60_000) {
        return this.failRun(exec.id, state, 'run exceeded wall-time budget (5m)');
      }
    }

    await this.finalize(exec.id, state, 'done', null);
    return { status: 'done', steps: state.steps, error: null, wait: null };
  }

  private async executeNode(
    exec: Execution,
    flow: FlowRef,
    node: FlowNode,
    inputItems: FlowItem[],
    state: ExecutionState,
  ): Promise<NodeResult> {
    const def = this.registry.get(node.type);
    const scope = this.buildNodeScope(exec, flow, inputItems, state);

    // 1. resolve {{ }} expressions inside raw params, 2. validate via Zod
    const warnings: string[] = [];
    const resolved = await resolveParams(node.params, scope, this.services.evalOptions, warnings);
    for (const w of warnings) this.log(exec.id, node.id, 'warn', w);
    const params = this.registry.parseParams(node.type, node.id, resolved);

    const ctx = this.buildCtx(exec, flow, node, state);
    return def.execute(ctx, params, inputItems);
  }

  private buildNodeScope(
    exec: Execution,
    flow: FlowRef,
    items: FlowItem[],
    state: ExecutionState,
  ): ExpressionScope {
    return buildScope({
      json: items[0]?.json ?? {},
      items,
      vars: state.vars,
      execution: { id: exec.id, startedAt: Date.parse(exec.startedAt) },
      flow: { id: flow.id, name: flow.name },
      chat: exec.chatId === null ? null : { id: exec.chatId },
      now: this.clock,
    });
  }

  private buildCtx(
    exec: Execution,
    flow: FlowRef,
    node: FlowNode,
    state: ExecutionState,
  ): NodeCtx {
    const executor = this;
    return {
      executionId: exec.id,
      flowId: flow.id,
      botId: exec.botId,
      chatId: exec.chatId,
      async eval(template: string, itemJson: Record<string, unknown>): Promise<string> {
        const scope = buildScope({
          json: itemJson,
          vars: state.vars,
          execution: { id: exec.id, startedAt: Date.parse(exec.startedAt) },
          flow: { id: flow.id, name: flow.name },
          chat: exec.chatId === null ? null : { id: exec.chatId },
          now: executor.clock,
        });
        const res = await renderTemplate(template, scope, executor.services.evalOptions);
        return res.value as string;
      },
      vars: {
        get: (key) => state.vars[key],
        set: (key, value) => {
          state.vars[key] = value;
        },
        all: () => ({ ...state.vars }),
      },
      kv: this.services.kv,
      http: this.services.http,
      tg: this.services.tg(exec.chatId),
      log: (level, message, data) => this.log(exec.id, node.id, level, message, data),
      now: () => this.clock(),
    };
  }

  private async failRun(id: string, state: ExecutionState, message: string): Promise<RunResult> {
    await this.finalize(id, state, 'error', message);
    this.log(id, state.cursor, 'error', message);
    return { status: 'error', steps: state.steps, error: message, wait: null };
  }

  private async finalize(
    id: string,
    state: ExecutionState,
    status: 'done' | 'error',
    error: string | null,
  ): Promise<void> {
    await this.store.save({ id, status, state, wait: null, error });
  }

  private log(
    executionId: string,
    nodeId: NodeId | null,
    level: StepLogEntry['level'],
    message: string,
    data?: unknown,
  ): void {
    this.services.log?.({
      executionId,
      nodeId,
      level,
      message,
      data,
      ts: this.clock().toISOString(),
    });
  }
}

// ── routing helpers (pure) ───────────────────────────────────────────────────

type EdgeIndex = Map<string, { node: NodeId; port: PortName }[]>;

/** Index edges by "fromNode\u0000fromPort" for O(1) routing. */
function indexEdges(graph: FlowGraph): EdgeIndex {
  const idx: EdgeIndex = new Map();
  for (const e of graph.edges) {
    const key = `${e.from.node}\u0000${e.from.port}`;
    const list = idx.get(key) ?? [];
    list.push({ node: e.to.node, port: e.to.port });
    idx.set(key, list);
  }
  return idx;
}

/**
 * Route a node's port outputs through the edges → next activations,
 * grouped per target node (multiple edges into the same node+port concat).
 */
function routeOutputs(
  edges: EdgeIndex,
  fromNode: NodeId,
  outputs: Partial<Record<PortName, FlowItem[]>>,
): Activation[] {
  const byTarget = new Map<NodeId, Record<PortName, FlowItem[]>>();
  const order: NodeId[] = [];
  for (const [port, items] of Object.entries(outputs)) {
    if (!items || items.length === 0) continue;
    const targets = edges.get(`${fromNode}\u0000${port}`) ?? [];
    for (const t of targets) {
      let rec = byTarget.get(t.node);
      if (!rec) {
        rec = {};
        byTarget.set(t.node, rec);
        order.push(t.node);
      }
      rec[t.port] = [...(rec[t.port] ?? []), ...items];
    }
  }
  return order.map((nodeId) => ({ nodeId, items: byTarget.get(nodeId)! }));
}

/** Merge a node's per-port input items into the array execute() receives. */
function mergeInputs(items: Record<string, FlowItem[]>): FlowItem[] {
  const out: FlowItem[] = [];
  for (const arr of Object.values(items)) out.push(...arr);
  return out;
}
