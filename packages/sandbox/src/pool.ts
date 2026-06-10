/**
 * SandboxPool — host side of the CTB sandbox primitive (P1-T2, ARCHITECTURE §8).
 *
 * `runInSandbox(code, scope, opts)` executes untrusted JS on a `worker_threads`
 * pool with:
 *  - a fresh frozen vm realm per run (no require/process/fs — invariant I6),
 *  - capability proxies (`$kv`, `$http`, …) that round-trip over MessagePort
 *    so ALL limits are enforced host-side,
 *  - console capture returned alongside the result,
 *  - two-layer timeout: vm CPU timeout inside the worker (sync `while(true)`
 *    dies without losing the worker) + a host hard-kill timer for async hangs
 *    (worker is terminated and replaced — the pool always survives).
 */
import { Worker } from 'node:worker_threads';
import { SandboxError } from '@ctb/shared';
import { WORKER_SOURCE } from './worker-source';

/** Host-side capability implementations, e.g. `{ $kv: { get: async (k) => … } }`. */
export type CapabilityHost = Record<
  string,
  Record<string, (...args: unknown[]) => unknown | Promise<unknown>>
>;

export interface SandboxRunOptions {
  /** Hard wall-clock budget for the whole run (default 10_000ms). */
  timeoutMs?: number;
  /** Capability objects exposed inside the realm (invariant I6: no ambient authority). */
  capabilities?: CapabilityHost;
  /**
   * 'expression' wraps code as `( code )` and returns its value (used by the
   * expression engine); 'script' (default) wraps as an async function body —
   * use `return` to produce a value (Code node).
   */
  mode?: 'expression' | 'script';
}

export interface SandboxResult {
  value: unknown;
  /** console.* output captured inside the realm, in order. */
  logs: string[];
}

export interface SandboxPoolOptions {
  /** Max parallel workers (default 4). */
  maxWorkers?: number;
  /** Per-worker old-space cap in MB (default 64, per NODES.md Code limits). */
  maxOldGenerationSizeMb?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;

interface Job {
  code: string;
  scope: Record<string, unknown>;
  opts: Required<Pick<SandboxRunOptions, 'timeoutMs' | 'mode'>> & {
    capabilities: CapabilityHost;
  };
  resolve: (r: SandboxResult) => void;
  reject: (e: Error) => void;
}

interface PooledWorker {
  worker: Worker;
  busy: boolean;
}

/** `$now`-style helper marker: functions can't cross the MessagePort. */
function marshalScopeValue(value: unknown): unknown {
  if (
    value !== null &&
    typeof value === 'object' &&
    typeof (value as { ts?: unknown }).ts === 'function' &&
    typeof (value as { format?: unknown }).format === 'function'
  ) {
    return { __ctbKind: 'now', ts: (value as { ts: () => number }).ts() };
  }
  return value;
}

export class SandboxPool {
  private readonly maxWorkers: number;
  private readonly maxOldGenerationSizeMb: number;
  private readonly workers: PooledWorker[] = [];
  private readonly queue: Job[] = [];
  private nextRunId = 1;
  private destroyed = false;

  constructor(opts: SandboxPoolOptions = {}) {
    this.maxWorkers = opts.maxWorkers ?? 4;
    this.maxOldGenerationSizeMb = opts.maxOldGenerationSizeMb ?? 64;
  }

  run(
    code: string,
    scope: Record<string, unknown> = {},
    opts: SandboxRunOptions = {},
  ): Promise<SandboxResult> {
    if (this.destroyed) {
      return Promise.reject(new SandboxError('sandbox pool is destroyed'));
    }
    return new Promise<SandboxResult>((resolve, reject) => {
      this.queue.push({
        code,
        scope,
        opts: {
          timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          mode: opts.mode ?? 'script',
          capabilities: opts.capabilities ?? {},
        },
        resolve,
        reject,
      });
      this.pump();
    });
  }

  /** Terminate every worker and reject queued jobs. Tests MUST call this. */
  async destroy(): Promise<void> {
    this.destroyed = true;
    for (const job of this.queue.splice(0)) {
      job.reject(new SandboxError('sandbox pool destroyed'));
    }
    await Promise.all(this.workers.splice(0).map((p) => p.worker.terminate()));
  }

  private pump(): void {
    if (this.destroyed || this.queue.length === 0) return;
    let slot = this.workers.find((w) => !w.busy);
    if (!slot && this.workers.length < this.maxWorkers) {
      slot = this.spawn();
    }
    if (!slot) return; // all busy → job stays queued
    const job = this.queue.shift();
    if (!job) return;
    this.execute(slot, job);
  }

  private spawn(): PooledWorker {
    const worker = new Worker(WORKER_SOURCE, {
      eval: true,
      resourceLimits: { maxOldGenerationSizeMb: this.maxOldGenerationSizeMb },
    });
    worker.unref(); // never keep the host process alive
    const pooled: PooledWorker = { worker, busy: false };
    this.workers.push(pooled);
    return pooled;
  }

  private retire(pooled: PooledWorker): void {
    const i = this.workers.indexOf(pooled);
    if (i !== -1) this.workers.splice(i, 1);
    void pooled.worker.terminate();
  }

  private execute(pooled: PooledWorker, job: Job): void {
    pooled.busy = true;
    const runId = this.nextRunId++;
    const { worker } = pooled;
    let settled = false;

    const cleanup = () => {
      worker.off('message', onMessage);
      worker.off('error', onError);
      worker.off('exit', onExit);
      clearTimeout(killTimer);
    };

    const finish = (fn: () => void, recycle: boolean) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (recycle) {
        this.retire(pooled);
      } else {
        pooled.busy = false;
      }
      fn();
      this.pump();
    };

    // Host hard-kill: covers async hangs (`await new Promise(()=>{})`) that the
    // vm CPU timeout cannot see. Worker is terminated and replaced.
    const killTimer = setTimeout(() => {
      finish(
        () => job.reject(new SandboxError(`sandbox timeout after ${job.opts.timeoutMs}ms (worker killed)`)),
        true,
      );
    }, job.opts.timeoutMs + 50);

    const onMessage = (msg: {
      type: string;
      runId: number;
      ok?: boolean;
      value?: unknown;
      error?: string;
      timedOut?: boolean;
      logs?: string[];
      capId?: number;
      cap?: string;
      method?: string;
      args?: unknown[];
    }) => {
      if (msg.runId !== runId) return;
      if (msg.type === 'cap') {
        void this.handleCapability(worker, job, msg as Required<typeof msg>);
        return;
      }
      if (msg.type === 'result') {
        if (msg.ok) {
          finish(() => job.resolve({ value: msg.value, logs: msg.logs ?? [] }), false);
        } else if (msg.timedOut) {
          finish(
            () => job.reject(new SandboxError(`sandbox timeout: ${msg.error ?? 'script execution timed out'}`)),
            false, // vm timeout → worker itself is fine, keep it
          );
        } else {
          finish(() => job.reject(new SandboxError(msg.error ?? 'sandbox execution failed')), false);
        }
      }
    };

    const onError = (err: Error) => {
      finish(() => job.reject(new SandboxError(`sandbox worker crashed: ${err.message}`)), true);
    };

    const onExit = (codeNum: number) => {
      finish(
        () => job.reject(new SandboxError(`sandbox worker exited unexpectedly (code ${codeNum})`)),
        true,
      );
    };

    worker.on('message', onMessage);
    worker.on('error', onError);
    worker.on('exit', onExit);

    const scopeWire: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(job.scope)) scopeWire[k] = marshalScopeValue(v);

    const capsWire: Record<string, string[]> = {};
    for (const [cap, methods] of Object.entries(job.opts.capabilities)) {
      capsWire[cap] = Object.keys(methods);
    }

    try {
      worker.postMessage({
        type: 'run',
        runId,
        code: job.code,
        mode: job.opts.mode,
        scope: scopeWire,
        caps: capsWire,
        // vm CPU budget slightly under the host hard-kill so sync loops are
        // killed gracefully without losing the worker.
        vmTimeoutMs: Math.max(1, job.opts.timeoutMs),
      });
    } catch (err) {
      finish(
        () =>
          job.reject(
            new SandboxError(
              `sandbox scope is not serializable: ${err instanceof Error ? err.message : String(err)}`,
            ),
          ),
        false,
      );
    }
  }

  private async handleCapability(
    worker: Worker,
    job: Job,
    msg: { runId: number; capId: number; cap: string; method: string; args: unknown[] },
  ): Promise<void> {
    const impl = job.opts.capabilities[msg.cap]?.[msg.method];
    let reply: { type: 'capResult'; runId: number; capId: number; ok: boolean; value?: unknown; error?: string };
    if (!impl) {
      reply = {
        type: 'capResult', runId: msg.runId, capId: msg.capId, ok: false,
        error: `unknown capability ${msg.cap}.${msg.method}`,
      };
    } else {
      try {
        const value = await impl(...msg.args);
        reply = { type: 'capResult', runId: msg.runId, capId: msg.capId, ok: true, value };
      } catch (err) {
        reply = {
          type: 'capResult', runId: msg.runId, capId: msg.capId, ok: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }
    try {
      worker.postMessage(reply);
    } catch {
      /* worker already terminated by timeout — nothing to do */
    }
  }
}

// ---------------------------------------------------------------------------
// Default shared pool (lazy) + module-level convenience API
// ---------------------------------------------------------------------------

let defaultPool: SandboxPool | null = null;

export function getDefaultSandboxPool(): SandboxPool {
  defaultPool ??= new SandboxPool();
  return defaultPool;
}

/** Run code in the shared default pool. See {@link SandboxPool.run}. */
export function runInSandbox(
  code: string,
  scope: Record<string, unknown> = {},
  opts: SandboxRunOptions = {},
): Promise<SandboxResult> {
  return getDefaultSandboxPool().run(code, scope, opts);
}

/** Tear down the shared default pool (test teardown / graceful shutdown). */
export async function destroyDefaultSandboxPool(): Promise<void> {
  if (defaultPool) {
    const p = defaultPool;
    defaultPool = null;
    await p.destroy();
  }
}
