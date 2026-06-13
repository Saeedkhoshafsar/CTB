import type { ZodType } from 'zod';
import { z } from 'zod';
import type { FlowItem } from './item';
import type { NodeId, PortName } from './flow';
import type { WaitSpec } from './execution';

/**
 * NodeResult — what a node's execute() returns to the executor (ARCHITECTURE §7).
 * Discriminated union so the executor switch is exhaustive.
 */
export type NodeResult =
  /** Items routed per output port. Missing ports = no items emitted there. */
  | { kind: 'items'; outputs: Partial<Record<PortName, FlowItem[]>> }
  /** Pause: persist state and return; router resumes later per WaitSpec. */
  | { kind: 'wait'; wait: WaitSpec }
  /** Jump to another node, feeding it the given items on "main". */
  | { kind: 'goto'; nodeId: NodeId; items: FlowItem[] }
  /** Finish successfully. */
  | { kind: 'end' }
  /** Finish with error (recorded on the execution + exec_logs). */
  | { kind: 'error'; message: string };

/** Helper constructors keep node code terse and typo-free. */
export const out = (outputs: Partial<Record<PortName, FlowItem[]>>): NodeResult => ({ kind: 'items', outputs });
export const wait = (w: WaitSpec): NodeResult => ({ kind: 'wait', wait: w });
export const goto = (nodeId: NodeId, items: FlowItem[]): NodeResult => ({ kind: 'goto', nodeId, items });
export const end = (): NodeResult => ({ kind: 'end' });
export const fail = (message: string): NodeResult => ({ kind: 'error', message });

/**
 * NodeCtx — capabilities injected by the host (invariant I3/I6).
 * core defines the shape; apps/server provides implementations.
 * Nodes NEVER touch globals — everything arrives through ctx.
 */
export interface NodeCtx {
  readonly executionId: string;
  readonly flowId: string;
  readonly botId: string;
  readonly chatId: number | null;
  /** Evaluate a {{ }} expression template against an item + $vars. */
  eval(template: string, itemJson: Record<string, unknown>): Promise<string>;
  /** Execution-scoped variables ($vars). */
  vars: {
    get(key: string): unknown;
    set(key: string, value: unknown): void;
    all(): Record<string, unknown>;
  };
  /** Persistent key-value store (data.kv backing). */
  kv: {
    get(scope: 'user' | 'bot' | 'flow', key: string): Promise<unknown>;
    set(scope: 'user' | 'bot' | 'flow', key: string, value: unknown): Promise<void>;
    delete(scope: 'user' | 'bot' | 'flow', key: string): Promise<void>;
  };
  /** Outbound HTTP (host-limited). */
  http: {
    request(opts: {
      method: string;
      url: string;
      headers?: Record<string, string>;
      body?: string | Record<string, unknown>;
      timeoutMs?: number;
    }): Promise<{ status: number; headers: Record<string, string>; body: unknown }>;
  };
  /** Telegram sender (centralized, rate-limited). Null when flow has no chat context. */
  tg: {
    sendMessage(opts: Record<string, unknown>): Promise<{ messageId: number }>;
    /** editMessageText — optional capability (tg.menu edit_in_place, P2-T6). */
    editMessageText?(opts: Record<string, unknown>): Promise<void>;
  } | null;
  /** Structured logging into exec_logs. */
  log(level: 'debug' | 'info' | 'warn' | 'error', message: string, data?: unknown): void;
  /** Current time — injected (executor clock) so nodes computing deadlines stay testable. */
  now(): Date;
  /**
   * Sandboxed user-code runner (data.code, ARCH §8 / P2-T7). Runs `source`
   * inside the worker-pool sandbox with the standard `$` scope built from
   * `items` ($items, $json = items[0].json, plus $vars/$execution/$flow/…
   * assembled by the executor) and host-limited `$http`/`$kv` capability
   * proxies (invariant I6 — the allow-list and caps are enforced host-side).
   * Returns the script's `return` value plus captured console output.
   */
  code: {
    run(
      source: string,
      items: FlowItem[],
      opts?: { timeoutMs?: number },
    ): Promise<{ value: unknown; logs: string[] }>;
  };
}

export const NodeCategorySchema = z.enum(['trigger', 'telegram', 'flow', 'data', 'ai']);
export type NodeCategory = z.infer<typeof NodeCategorySchema>;

/**
 * NodeDef — the implementation contract for packages/nodes (NODES.md §contract).
 * paramsSchema drives BOTH server-side validation and the editor's auto-form.
 */
export interface NodeDef<P = unknown> {
  type: string; // "tg.sendMessage"
  category: NodeCategory;
  /** Display metadata for the editor palette (i18n keys, not literals). */
  meta: { labelKey: string; descriptionKey?: string; icon?: string };
  ports: { inputs: PortName[]; outputs: PortName[] };
  /**
   * Some nodes (Menu, Switch) derive extra output ports from params.
   * Editor and engine both call this; defaults to static ports.outputs.
   */
  dynamicOutputs?(params: P): PortName[];
  /**
   * Top-level param keys the executor must NOT expression-resolve before
   * execute() (Decision Log #16). data.code lists `code` here: `{{ }}` is
   * valid JavaScript and must reach the sandbox verbatim — resolving it
   * would corrupt user programs.
   */
  rawParamKeys?: readonly string[];
  paramsSchema: ZodType<P>;
  execute(ctx: NodeCtx, params: P, items: FlowItem[]): Promise<NodeResult>;
}
