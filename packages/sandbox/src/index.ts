/**
 * @ctb/sandbox — isolated runner for the Code node & expressions (P1-T2).
 * worker_threads pool · fresh frozen vm realm per run · capability proxies
 * over MessagePort · console capture · vm CPU timeout + host hard-kill.
 * See ARCHITECTURE §8 and invariant I6 (no ambient authority).
 */
export {
  SandboxPool,
  runInSandbox,
  getDefaultSandboxPool,
  destroyDefaultSandboxPool,
  type CapabilityHost,
  type SandboxRunOptions,
  type SandboxResult,
  type SandboxPoolOptions,
} from './pool';
