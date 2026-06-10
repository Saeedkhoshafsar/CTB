/**
 * Worker-side source for the CTB sandbox (P1-T2, ARCHITECTURE §8).
 *
 * Shipped as a plain CommonJS string and booted with `new Worker(src, {eval:true})`
 * so it never depends on a TS loader inside the worker. The worker:
 *
 *  - creates a FRESH `vm` realm per run → no `process`/`require`/`fs` exist at all;
 *  - deep-freezes the hydrated scope (structured clone drops frozenness);
 *  - rebuilds the `$now` helper from a `{__ctbKind:'now', ts}` wire marker;
 *  - exposes capability proxies that round-trip over MessagePort to the host;
 *  - captures `console.*` into a log buffer returned with the result;
 *  - enforces the vm-level CPU timeout (sync infinite loops die WITHOUT killing
 *    the worker). Async hangs are covered by the host's hard-kill timer.
 */
export const WORKER_SOURCE = String.raw`
'use strict';
const { parentPort } = require('worker_threads');
const vm = require('vm');

// Names shadowed to 'undefined' inside the realm (defense in depth — a fresh
// vm realm does not have most of these anyway).
const SHADOW = [
  'process', 'require', 'module', 'exports', '__dirname', '__filename',
  'Function', 'eval', 'fetch', 'Buffer', 'WebAssembly', 'structuredClone',
  'setTimeout', 'setInterval', 'setImmediate',
  'clearTimeout', 'clearInterval', 'clearImmediate',
  'queueMicrotask', 'performance', 'atob', 'btoa',
];

function deepFreeze(v, seen) {
  if (v === null || typeof v !== 'object') return v;
  seen = seen || new Set();
  if (seen.has(v)) return v;
  seen.add(v);
  for (const k of Object.keys(v)) deepFreeze(v[k], seen);
  return Object.freeze(v);
}

function pad(n) { return n < 10 ? '0' + n : String(n); }

function makeNow(ts) {
  return Object.freeze({
    ts: function () { return ts; },
    iso: function () { return new Date(ts).toISOString(); },
    date: function () { return new Date(ts); },
    format: function (pattern) {
      const d = new Date(ts);
      return String(pattern)
        .replace(/YYYY/g, String(d.getFullYear()))
        .replace(/MM/g, pad(d.getMonth() + 1))
        .replace(/DD/g, pad(d.getDate()))
        .replace(/HH/g, pad(d.getHours()))
        .replace(/mm/g, pad(d.getMinutes()))
        .replace(/ss/g, pad(d.getSeconds()));
    },
  });
}

// One run at a time per worker; tracks pending capability calls.
let current = null;

parentPort.on('message', function (msg) {
  if (msg && msg.type === 'run') {
    handleRun(msg);
  } else if (msg && msg.type === 'capResult' && current && msg.runId === current.runId) {
    const waiter = current.capWaiters.get(msg.capId);
    if (waiter) {
      current.capWaiters.delete(msg.capId);
      if (msg.ok) waiter.resolve(msg.value);
      else waiter.reject(new Error(msg.error));
    }
  }
});

function stringifyArg(a) {
  if (typeof a === 'string') return a;
  try { return JSON.stringify(a); } catch (_) { return String(a); }
}

async function handleRun(msg) {
  const runId = msg.runId;
  const logs = [];
  current = { runId: runId, capWaiters: new Map(), nextCapId: 1 };

  const sandbox = Object.create(null);

  // Hydrate scope (re-freeze: structured clone loses Object.freeze).
  const scope = msg.scope || {};
  for (const key of Object.keys(scope)) {
    const v = scope[key];
    if (v && typeof v === 'object' && v.__ctbKind === 'now') sandbox[key] = makeNow(v.ts);
    else sandbox[key] = deepFreeze(v);
  }

  // Capability proxies → MessagePort round-trip to the host.
  const caps = msg.caps || {};
  for (const capName of Object.keys(caps)) {
    const proxy = {};
    for (const method of caps[capName]) {
      proxy[method] = function () {
        const args = Array.prototype.slice.call(arguments);
        return new Promise(function (resolve, reject) {
          const capId = current.nextCapId++;
          current.capWaiters.set(capId, { resolve: resolve, reject: reject });
          parentPort.postMessage({ type: 'cap', runId: runId, capId: capId, cap: capName, method: method, args: args });
        });
      };
    }
    sandbox[capName] = Object.freeze(proxy);
  }

  // Console capture.
  function capture(level) {
    return function () {
      const parts = Array.prototype.slice.call(arguments).map(stringifyArg);
      logs.push((level === 'log' ? '' : '[' + level + '] ') + parts.join(' '));
    };
  }
  sandbox.console = Object.freeze({
    log: capture('log'), info: capture('info'), warn: capture('warn'), error: capture('error'), debug: capture('debug'),
  });

  for (const name of SHADOW) {
    if (!(name in sandbox)) sandbox[name] = undefined;
  }

  const wrapped = msg.mode === 'expression'
    ? '"use strict"; (async () => ( ' + msg.code + '\n))()'
    : '"use strict"; (async () => { ' + msg.code + '\n})()';

  try {
    const context = vm.createContext(sandbox, { codeGeneration: { strings: false, wasm: false } });
    // Hide the realm's own globalThis binding so even reflective lookups get undefined.
    try {
      vm.runInContext('Object.defineProperty(globalThis, "globalThis", { value: undefined });', context);
    } catch (_) { /* non-fatal hardening */ }
    const value = await vm.runInContext(wrapped, context, { timeout: msg.vmTimeoutMs });
    current = null;
    postResult({ type: 'result', runId: runId, ok: true, value: value, logs: logs });
  } catch (err) {
    current = null;
    const timedOut = !!(err && err.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT');
    parentPort.postMessage({
      type: 'result', runId: runId, ok: false,
      error: String((err && err.message) || err), timedOut: timedOut, logs: logs,
    });
  }
}

function postResult(payload) {
  try {
    parentPort.postMessage(payload);
  } catch (_) {
    // Result not structured-cloneable (vm-realm exotic object, function, …) → JSON fallback.
    try {
      parentPort.postMessage({ type: 'result', runId: payload.runId, ok: true, value: JSON.parse(JSON.stringify(payload.value)), logs: payload.logs });
    } catch (e2) {
      parentPort.postMessage({ type: 'result', runId: payload.runId, ok: false, error: 'sandbox result is not serializable: ' + String(e2 && e2.message || e2), timedOut: false, logs: payload.logs });
    }
  }
}
`;
