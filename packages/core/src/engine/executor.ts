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
  /**
   * Items that entered the node on this step (capped, P2-T3.5) — feeds the
   * editor's node detail view (input panel). Present only on "executed" rows.
   */
  input?: FlowItem[];
  /** Items the node emitted per output port (capped) — NDV output panel. */
  output?: Record<string, FlowItem[]>;
  durationMs?: number;
  ts: string;
}
export type StepLogger = (entry: StepLogEntry) => void;

/**
 * Cap for items recorded into step logs (per port). Logs are a debugging
 * window, not an archive — full data still flows through the engine.
 */
export const LOG_ITEMS_CAP = 20;

function capItems(items: FlowItem[]): FlowItem[] {
  return items.length > LOG_ITEMS_CAP ? items.slice(0, LOG_ITEMS_CAP) : items;
}

function capOutputs(
  outputs: Partial<Record<PortName, FlowItem[]>>,
): Record<string, FlowItem[]> {
  const capped: Record<string, FlowItem[]> = {};
  for (const [port, items] of Object.entries(outputs)) {
    if (items && items.length > 0) capped[port] = capItems(items);
  }
  return capped;
}

/**
 * Sandboxed user-code runner factory (data.code, P2-T7). The host (server
 * wire.ts) builds it over the @ctb/sandbox pool with $http/$kv capability
 * proxies whose limits are enforced host-side (invariant I6). `core` only
 * knows the contract — it never imports the sandbox for this (I3): the
 * scope is assembled here, execution happens behind the injected function.
 */
export type CodeRunner = (
  source: string,
  scope: Record<string, unknown>,
  opts: { botId: string; chatId: number | null; timeoutMs?: number },
) => Promise<{ value: unknown; logs: string[] }>;

/** Host-injected capabilities handed to nodes via NodeCtx (invariant I3/I6). */
export interface ExecutorServices {
  /** KV factory — per-bot, because one executor serves many bots (DL #15). */
  kv: (botId: string) => NodeCtx['kv'];
  http: NodeCtx['http'];
  /**
   * Stored-credential resolver (P3-T4) — optional: ctx.credentials is null
   * without it. Resolves a credentialId to the auth HEADERS it injects; the
   * host owns decryption so the secret never reaches node code (invariant I7).
   */
  credentials?: NonNullable<NodeCtx['credentials']>;
  /** Sandbox runner for data.code — optional: ctx.code.run throws without it. */
  code?: CodeRunner;
  /**
   * Telegram sender factory — null when no sender applies. Receives the
   * execution's botId because ONE executor serves MANY bots (Decision Log #15):
   * the server resolves the right per-bot rate-limited sender from it.
   */
  tg: (botId: string, chatId: number | null) => NodeCtx['tg'];
  /**
   * Sub-flow runner for flow.executeSubFlow (P3-T1) — optional: ctx.subflow is
   * null without it. Receives the calling execution's botId/depth so the host
   * can enforce same-bot ownership and the recursion-depth cap (invariant I6):
   * the executor never recurses into itself — the host owns the nested run.
   */
  subflow?: (parentBotId: string, depth: number) => {
    run(flowId: string, items: FlowItem[]): Promise<{ items: FlowItem[] }>;
  };
  /**
   * User-profile store for data.userProfile (P3-T5) — optional: ctx.users is
   * null without it. A per-bot factory (one executor serves many bots, DL #15);
   * it also receives the execution's own tg user id so the node can default to
   * "the current user" without learning the chat→user mapping itself.
   */
  users?: (botId: string, defaultTgUserId: number | null) => NonNullable<NodeCtx['users']>;
  /**
   * Collections data layer for data.collection (P3.5-T5) — optional: ctx.collections
   * is null without it. A per-bot factory (one executor serves many bots, DL #15).
   * It also receives the calling flow id so the host's record-write event bus can
   * stamp writes with their origin flow and apply the depth-1 loop guard (a flow's
   * own writes never re-trigger the flow that started it). The node never learns
   * the schema, validation or the event bus — invariant I6 keeps it host-side.
   */
  collections?: (botId: string, flowId: string) => NonNullable<NodeCtx['collections']>;
  /**
   * LLM chat service for ai.llmChat (P5-T1) — optional: ctx.ai is null without
   * it. The host resolves the OpenAI-compatible credential (base_url + key) and
   * performs the chat-completions request, so the decrypted key never reaches
   * node code (invariants I6/I7). It's a simple object (not per-bot) because the
   * credential — not the bot — selects the provider.
   */
  ai?: NonNullable<NodeCtx['ai']>;
  /**
   * MCP client service for ai.mcpClient (P5-T3) — optional: ctx.mcp is null
   * without it. The host resolves the `mcpServer` credential (endpoint + key)
   * and performs the JSON-RPC `tools/list`/`tools/call`, so the decrypted key
   * never reaches node code (invariants I6/I7). A simple object (not per-bot)
   * because the credential — not the bot — selects the MCP server.
   */
  mcp?: NonNullable<NodeCtx['mcp']>;
  /**
   * File-store capability for tg.sendMedia `source:'file'` (PA-T1) + tg.getFile
   * `store:true` (PA-T2) — optional: ctx.files is null without it. The host
   * reads/writes the bytes of a CTB file id on disk so the node never touches
   * the file system (invariant I6). A per-bot factory (DL #15): a `read` by
   * globally-unique id ignores the bot, but a `write` stamps the run's bot so
   * stored files are owned by the right bot.
   */
  files?: (botId: string) => NonNullable<NodeCtx['files']>;
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
  /**
   * Sub-flow nesting depth (flow.executeSubFlow, P3-T1). 0 for a top-level run;
   * a child started by ctx.subflow.run is one deeper. Threaded into ctx.subflow
   * so the host can enforce the recursion-depth cap. Not persisted — relevant
   * only for the synchronous nested run that creates it.
   */
  depth?: number;
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
  /**
   * Sub-flow nesting depth of the run currently in buildCtx's scope (P3-T1).
   * Set per run from StartInput.depth; threaded into ctx.subflow so the host
   * caps recursion. One executor serves many bots but each run is synchronous
   * within a single runLoop, so a per-instance field is sufficient and avoids
   * persisting depth into ExecutionState.
   */
  private currentDepth = 0;

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
    this.currentDepth = input.depth ?? 0;
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
      } else if (this.isProviderNode(node.type)) {
        // Provider sub-nodes (Chat Model / Memory / Tool, PB-T1) are resolved as
        // a consumer's CONFIG, never run as a data step. A correctly-wired graph
        // never routes data into one (their only wire is the dashed slot edge),
        // but if a malformed graph parks the cursor here we end this branch
        // quietly instead of executing the provider as if it were a data node.
        result = { kind: 'items', outputs: {} };
        this.log(exec.id, node.id, 'debug', `provider node "${node.id}" is not a data step — skipped`);
      } else {
        try {
          result = await this.executeNode(exec, flow, node, inputItems, state);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          const tag = err instanceof UnknownNodeTypeError ? 'unknown node type' : 'node failed';
          return this.failRun(exec.id, state, `${tag} at "${node.id}": ${message}`);
        }
      }

      // Structured I/O snapshot for the editor's node detail view (P2-T3.5):
      // what entered the node and what it emitted per port, capped.
      this.services.log?.({
        executionId: exec.id,
        nodeId: node.id,
        level: 'debug',
        message: `executed ${node.type}`,
        data: { kind: result.kind },
        input: capItems(inputItems),
        ...(result.kind === 'items' ? { output: capOutputs(result.outputs) } : {}),
        ...(result.kind === 'goto' ? { output: { main: capItems(result.items) } } : {}),
        durationMs: this.clock().getTime() - stepStart,
        ts: this.clock().toISOString(),
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

  /**
   * True when a node TYPE is a provider sub-node (role `provider`, PB-T1) —
   * resolved as a consumer's config, never executed as a data step. Tolerant of
   * unknown types (returns false) so the normal unknown-type error path runs.
   */
  private isProviderNode(type: string): boolean {
    return this.registry.has(type) && this.registry.get(type).role === 'provider';
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

    // 1. resolve {{ }} expressions inside raw params, 2. validate via Zod.
    // Keys listed in def.rawParamKeys skip resolution (DL #16): data.code's
    // `code` is a JS program where {{ }} is valid syntax, not a template.
    const rawKeys = new Set(def.rawParamKeys ?? []);
    const warnings: string[] = [];
    let resolved: unknown;
    if (rawKeys.size > 0 && node.params !== null && typeof node.params === 'object' && !Array.isArray(node.params)) {
      const entries = Object.entries(node.params as Record<string, unknown>);
      const out: Record<string, unknown> = {};
      for (const [k, v] of entries) {
        out[k] = rawKeys.has(k) ? v : await resolveParams(v, scope, this.services.evalOptions, warnings);
      }
      resolved = out;
    } else {
      resolved = await resolveParams(node.params, scope, this.services.evalOptions, warnings);
    }
    for (const w of warnings) this.log(exec.id, node.id, 'warn', w);
    const params = this.registry.parseParams(node.type, node.id, resolved);

    const ctx = this.buildCtx(exec, flow, node, state, state.items);
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
    inputsByPort: Record<PortName, FlowItem[]>,
  ): NodeCtx {
    const executor = this;
    return {
      executionId: exec.id,
      flowId: flow.id,
      botId: exec.botId,
      chatId: exec.chatId,
      nodeId: node.id,
      // Per-port inputs for branch-aware nodes (flow.merge). Drop empty ports so
      // a node sees only the ports that actually delivered items this step.
      inputsByPort: Object.fromEntries(
        Object.entries(inputsByPort).filter(([, items]) => items.length > 0),
      ),
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
      kv: this.services.kv(exec.botId),
      http: this.services.http,
      credentials: this.services.credentials ?? null,
      tg: this.services.tg(exec.botId, exec.chatId),
      log: (level, message, data) => this.log(exec.id, node.id, level, message, data),
      now: () => this.clock(),
      code: {
        run: async (source, items, opts) => {
          const runner = executor.services.code;
          if (!runner) throw new Error('code runner is not configured on this instance');
          // Same $ scope expressions see (ARCH §6/§8) — built from the items
          // the node passes in, so per-item mode gets the right $json.
          const scope = executor.buildNodeScope(exec, flow, items, state);
          return runner(source, scope as unknown as Record<string, unknown>, {
            botId: exec.botId,
            chatId: exec.chatId,
            ...(opts?.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
          });
        },
      },
      subflow: executor.services.subflow
        ? executor.services.subflow(exec.botId, executor.currentDepth)
        : null,
      users: executor.services.users
        ? executor.services.users(exec.botId, parseTgUserId(exec.userId))
        : null,
      collections: executor.services.collections
        ? executor.services.collections(exec.botId, flow.id)
        : null,
      ai: executor.services.ai ?? null,
      mcp: executor.services.mcp ?? null,
      files: executor.services.files ? executor.services.files(exec.botId) : null,
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

/**
 * The execution stores `userId` as a string (the tg user id stringified by the
 * router). data.userProfile needs the numeric tg id to default to "the current
 * user" — parse it back, null if absent/non-numeric (e.g. sub-flow runs).
 */
function parseTgUserId(userId: string | null): number | null {
  if (userId === null) return null;
  const n = Number(userId);
  return Number.isInteger(n) ? n : null;
}

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
