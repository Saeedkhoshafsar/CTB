/**
 * P2-T3.5 — NDV run data: json-tree flattening, step-log → per-node mapping,
 * and the run-data store loading the latest execution through the typed
 * client + fake server (mirrors GET /api/executions[/:id]).
 */
import type { ExecLogEntry, ExecutionDetail } from '@ctb/shared';
import { describe, expect, it } from 'vitest';
import { ApiClient } from '../src/api/client';
import { childRows, pathToExpression } from '../src/canvas/json-tree';
import {
  flattenOutputForPin,
  mapRunData,
  mapRunErrors,
  PIN_ITEMS_CAP,
  safeItemJson,
  safeItems,
} from '../src/canvas/run-data';
import { FIELD_DRAG_MIME } from '../src/form/expression';
import { createAuthStore } from '../src/stores/auth';
import { createRunDataStore } from '../src/stores/run-data';
import { createFakeServer } from './fake-fetch';

// ---------------------------------------------------------------------------
// json-tree — childRows / pathToExpression
// ---------------------------------------------------------------------------

describe('json-tree — childRows', () => {
  it('flattens object children one level deep with dotted paths', () => {
    const rows = childRows({ name: 'علی', age: 17, ok: true, tags: ['a', 'b'] }, '', 0);
    expect(rows.map((r) => r.path)).toEqual(['name', 'age', 'ok', 'tags']);
    expect(rows[0]).toMatchObject({ key: 'name', kind: 'string', preview: 'علی', childCount: 0 });
    expect(rows[1]).toMatchObject({ kind: 'number', preview: '17' });
    expect(rows[2]).toMatchObject({ kind: 'boolean', preview: 'true' });
    // branches have no preview but a child count
    expect(rows[3]).toMatchObject({ kind: 'array', preview: null, childCount: 2 });
  });

  it('nests with basePath and uses bracket access for array indices', () => {
    const rows = childRows([{ text: 'hi' }], 'words', 1);
    expect(rows[0]).toMatchObject({ path: 'words[0]', key: '[0]', kind: 'object', childCount: 1 });
    const inner = childRows({ text: 'hi' }, 'words[0]', 2);
    expect(inner[0]?.path).toBe('words[0].text');
  });

  it('uses bracket access for exotic keys so the expression evaluates', () => {
    const rows = childRows({ 'first-name': 'x', "it's": 'y' }, 'user', 1);
    expect(rows[0]?.path).toBe("user['first-name']");
    expect(rows[1]?.path).toBe("user['it\\'s']");
  });

  it('truncates long previews and returns [] for scalars', () => {
    const long = 'x'.repeat(200);
    const rows = childRows({ long }, '', 0);
    expect(rows[0]?.preview?.length).toBeLessThanOrEqual(61); // 60 + ellipsis
    expect(childRows('scalar', '', 0)).toEqual([]);
    expect(childRows(null, '', 0)).toEqual([]);
  });
});

describe('json-tree — pathToExpression', () => {
  it('builds {{ $json.path }} (dot join; bracket paths attach directly)', () => {
    expect(pathToExpression('user.first_name')).toBe('{{ $json.user.first_name }}');
    expect(pathToExpression('[0].text')).toBe('{{ $json[0].text }}');
  });

  it('drag MIME is the shared constant from the form engine (single source)', () => {
    expect(FIELD_DRAG_MIME).toBe('application/x-ctb-field-expr');
  });
});

// ---------------------------------------------------------------------------
// run-data — mapRunData
// ---------------------------------------------------------------------------

const item = (json: Record<string, unknown>) => ({ json });

function logRow(over: Partial<ExecLogEntry>): ExecLogEntry {
  return {
    id: 1,
    nodeId: null,
    level: 'debug',
    message: 'executed x',
    input: null,
    output: null,
    error: null,
    durationMs: 3,
    ts: '2026-06-11T10:00:00.000Z',
    ...over,
  };
}

describe('run-data — mapRunData', () => {
  it('keeps the LAST executed row per node and skips rows without input', () => {
    const logs: ExecLogEntry[] = [
      logRow({ id: 1, nodeId: 'a', input: [item({ v: 1 })], output: { main: [item({ v: 2 })] } }),
      logRow({ id: 2, nodeId: 'a', message: 'generic debug' }), // no input — ignored
      logRow({ id: 3, nodeId: 'a', input: [item({ v: 10 })], output: { main: [item({ v: 20 })] }, durationMs: 7 }),
      logRow({ id: 4, nodeId: null, input: [item({ x: 1 })] }), // no node — ignored
    ];
    const map = mapRunData(logs);
    expect(map.size).toBe(1);
    const a = map.get('a');
    expect(a?.input).toEqual([item({ v: 10 })]);
    expect(a?.output).toEqual({ main: [item({ v: 20 })] });
    expect(a?.durationMs).toBe(7);
  });

  it('normalizes null output (e.g. wait steps) to {}', () => {
    const map = mapRunData([logRow({ nodeId: 'w', input: [item({ q: 1 })], output: null })]);
    expect(map.get('w')?.output).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// run-data — mapRunErrors (H-T3, gap G15: canvas error surfacing)
// ---------------------------------------------------------------------------

describe('run-data — mapRunErrors', () => {
  it("collects error-level rows mapRunData skips (no input snapshot)", () => {
    const logs: ExecLogEntry[] = [
      logRow({ id: 1, nodeId: 'a', input: [item({ v: 1 })], output: { main: [item({ v: 2 })] } }),
      logRow({ id: 2, nodeId: 'b', level: 'error', error: 'boom', input: null }),
    ];
    // mapRunData drops the error-only row; mapRunErrors keeps exactly it.
    expect(mapRunData(logs).has('b')).toBe(false);
    const errs = mapRunErrors(logs);
    expect(errs.size).toBe(1);
    expect(errs.get('b')).toBe('boom');
  });

  it('prefers the structured error column, falls back to message', () => {
    const errs = mapRunErrors([
      logRow({ nodeId: 'a', level: 'error', error: 'TypeError: x', message: 'step failed' }),
      logRow({ nodeId: 'b', level: 'error', error: null, message: 'no token' }),
      logRow({ nodeId: 'c', level: 'error', error: null, message: '' }),
    ]);
    expect(errs.get('a')).toBe('TypeError: x');
    expect(errs.get('b')).toBe('no token');
    // empty error AND empty message → a stable non-empty placeholder
    expect(errs.get('c')).toBe('error');
  });

  it('keeps the LAST error per node and ignores non-error / nodeless rows', () => {
    const errs = mapRunErrors([
      logRow({ nodeId: 'a', level: 'error', error: 'first' }),
      logRow({ nodeId: 'a', level: 'error', error: 'latest' }), // loop revisit
      logRow({ nodeId: 'a', level: 'warn', error: 'a warning' }), // not an error
      logRow({ nodeId: null, level: 'error', error: 'flow-level' }), // no node
    ]);
    expect(errs.size).toBe(1);
    expect(errs.get('a')).toBe('latest');
  });
});

// ---------------------------------------------------------------------------
// run-data store — load latest execution via fake /api/executions
// ---------------------------------------------------------------------------

function fakeExecution(over: Partial<ExecutionDetail>): ExecutionDetail {
  return {
    id: 'exec-1',
    flowId: 'flow-x',
    botId: 'bot-x',
    chatId: 42,
    status: 'done',
    error: null,
    startedAt: '2026-06-11T10:00:00.000Z',
    updatedAt: '2026-06-11T10:00:01.000Z',
    wait: null,
    logs: [],
    ...over,
  };
}

describe('run-data store', () => {
  async function setup() {
    const srv = createFakeServer();
    const client = new ApiClient({ fetchImpl: srv.fetch });
    await createAuthStore(client).getState().login('admin', 'pw');
    return { srv, client, useRun: createRunDataStore(client) };
  }

  it('loads the LATEST execution of the flow and maps its logs', async () => {
    const { srv, useRun } = await setup();
    srv.executions.set('exec-old', fakeExecution({ id: 'exec-old', startedAt: '2026-06-11T09:00:00.000Z' }));
    srv.executions.set(
      'exec-new',
      fakeExecution({
        id: 'exec-new',
        startedAt: '2026-06-11T11:00:00.000Z',
        logs: [logRow({ nodeId: 'greet', input: [item({ name: 'علی' })], output: { main: [item({ greeted: true })] } })],
      }),
    );
    await useRun.getState().load('flow-x');
    const s = useRun.getState();
    expect(s.execution?.id).toBe('exec-new');
    expect(s.byNode.get('greet')?.input).toEqual([item({ name: 'علی' })]);
    expect(s.loading).toBe(false);
    expect(s.error).toBeNull();
  });

  it('flow that never ran → null execution, empty maps (no error)', async () => {
    const { useRun } = await setup();
    await useRun.getState().load('flow-never');
    const s = useRun.getState();
    expect(s.execution).toBeNull();
    expect(s.byNode.size).toBe(0);
    expect(s.errorsByNode.size).toBe(0);
    expect(s.error).toBeNull();
  });

  it('H-T3: a failed execution exposes the failing node via errorsByNode', async () => {
    const { srv, useRun } = await setup();
    // fixture: a run where node "send" succeeded but node "fetch" threw.
    srv.executions.set(
      'exec-fail',
      fakeExecution({
        id: 'exec-fail',
        status: 'error',
        error: 'Request failed',
        startedAt: '2026-06-11T12:00:00.000Z',
        logs: [
          logRow({ id: 1, nodeId: 'send', input: [item({ chat: 1 })], output: { main: [item({ ok: true })] } }),
          logRow({ id: 2, nodeId: 'fetch', level: 'error', error: 'HTTP 500: upstream', input: null }),
        ],
      }),
    );
    await useRun.getState().load('flow-x');
    const s = useRun.getState();
    expect(s.execution?.status).toBe('error');
    // the canvas overlay can now glow the offending node + read its message
    expect(s.errorsByNode.get('fetch')).toBe('HTTP 500: upstream');
    expect(s.errorsByNode.has('send')).toBe(false);
    // the successful node still carries its I/O snapshot for the NDV
    expect(s.byNode.get('send')?.output).toEqual({ main: [item({ ok: true })] });
  });

  it('refresh re-fetches; reset clears everything', async () => {
    const { srv, useRun } = await setup();
    await useRun.getState().load('flow-x');
    expect(useRun.getState().execution).toBeNull();

    srv.executions.set(
      'exec-1',
      fakeExecution({ logs: [logRow({ nodeId: 'n1', input: [item({ a: 1 })] })] }),
    );
    await useRun.getState().refresh();
    expect(useRun.getState().execution?.id).toBe('exec-1');
    expect(useRun.getState().byNode.has('n1')).toBe(true);

    useRun.getState().reset();
    const s = useRun.getState();
    expect(s.flowId).toBeNull();
    expect(s.execution).toBeNull();
    expect(s.byNode.size).toBe(0);
    expect(s.errorsByNode.size).toBe(0);
  });
});

describe('flattenOutputForPin — I-T1 (gap G4)', () => {
  it('returns null for null/undefined/empty output', () => {
    expect(flattenOutputForPin(null)).toBeNull();
    expect(flattenOutputForPin(undefined)).toBeNull();
    expect(flattenOutputForPin({})).toBeNull();
    expect(flattenOutputForPin({ main: [] })).toBeNull();
  });

  it('flattens a single-port output to a flat FlowItem[]', () => {
    expect(flattenOutputForPin({ main: [item({ a: 1 }), item({ a: 2 })] })).toEqual([
      { json: { a: 1 } },
      { json: { a: 2 } },
    ]);
  });

  it('orders `main` first, then other ports', () => {
    const out = flattenOutputForPin({
      false: [item({ p: 'F' })],
      main: [item({ p: 'M' })],
      true: [item({ p: 'T' })],
    });
    expect(out?.[0]).toEqual({ json: { p: 'M' } });
    // the rest follow main, both present
    expect(out).toHaveLength(3);
    expect(out).toContainEqual({ json: { p: 'F' } });
    expect(out).toContainEqual({ json: { p: 'T' } });
  });

  it('caps the result at PIN_ITEMS_CAP items', () => {
    const many = { main: Array.from({ length: PIN_ITEMS_CAP + 10 }, (_, i) => item({ i })) };
    expect(flattenOutputForPin(many)).toHaveLength(PIN_ITEMS_CAP);
  });
});

// ---------------------------------------------------------------------------
// safeItems / safeItemJson — crash-hardening for the data panes (black-screen fix)
// ---------------------------------------------------------------------------

describe('safeItems / safeItemJson — never throw on malformed run data', () => {
  it('safeItems returns the array unchanged when it is an array', () => {
    const arr = [{ json: { a: 1 } }, { json: { b: 2 } }];
    expect(safeItems(arr)).toBe(arr);
  });

  it('safeItems coerces non-arrays (null/undefined/object/primitive) to []', () => {
    expect(safeItems(null)).toEqual([]);
    expect(safeItems(undefined)).toEqual([]);
    expect(safeItems({ json: { a: 1 } })).toEqual([]);
    expect(safeItems('oops')).toEqual([]);
    expect(safeItems(42)).toEqual([]);
  });

  it('safeItemJson returns the json object for a well-formed item', () => {
    expect(safeItemJson({ json: { name: 'Sara', age: 9 } })).toEqual({ name: 'Sara', age: 9 });
  });

  it('safeItemJson returns {} for a missing / non-object / array json (no throw)', () => {
    expect(safeItemJson(null)).toEqual({});
    expect(safeItemJson(undefined)).toEqual({});
    expect(safeItemJson({})).toEqual({});
    expect(safeItemJson({ json: null })).toEqual({});
    expect(safeItemJson({ json: 'text' })).toEqual({});
    expect(safeItemJson({ json: 7 })).toEqual({});
    expect(safeItemJson({ json: [1, 2, 3] })).toEqual({});
    expect(safeItemJson('not-an-item')).toEqual({});
  });
});
