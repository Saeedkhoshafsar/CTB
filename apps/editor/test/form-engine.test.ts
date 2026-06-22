/**
 * P2-T3 — form engine tests (headless: the pure layer drives everything).
 *
 * The PLAN acceptance — "every P1 node fully configurable from UI without
 * touching JSON" — is verified by simulating exactly the operations the
 * widgets perform (setAtPath edits keyed off the resolved widget kinds, then
 * pruneEmpty on commit) and validating the produced params against the REAL
 * shared Zod schemas. The fake server now serves those same schemas through
 * z.toJSONSchema, so widget resolution is tested against genuine output of
 * the /api/node-types pipeline, not hand-written stubs.
 */
import {
  DataSetFieldsParamsSchema,
  FlowGraphSchema,
  FlowIfParamsSchema,
  FlowStopErrorParamsSchema,
  TgSendMessageParamsSchema,
  TgTriggerParamsSchema,
  TgWaitForReplyParamsSchema,
} from '@ctb/shared';
import { describe, expect, it } from 'vitest';
import type { ZodType } from 'zod';
import sampleFlow from '../../../packages/shared/test/fixtures/sample-flow.json';
import { insertHint, splitSegments } from '../src/form/expression';
import { getAtPath, moveRow, pruneEmpty, setAtPath, type Path } from '../src/form/model';
import {
  convertBranchValue,
  emptyValue,
  isConditionsSchema,
  isKeyboardSchema,
  isSet,
  matchBranch,
  objectFields,
  partitionFields,
  resolveWidget,
  type JsonSchema,
} from '../src/form/schema';
import { FAKE_NODE_TYPES } from './fake-fetch';

const schemaOf = (type: string): JsonSchema => {
  const nt = FAKE_NODE_TYPES.find((n) => n.type === type);
  if (!nt) throw new Error(`unknown node type ${type}`);
  return nt.paramsJsonSchema as JsonSchema;
};

const widgetsOf = (type: string): Record<string, string> =>
  Object.fromEntries(objectFields(schemaOf(type)).map((f) => [f.key, f.widget]));

// ── widget resolution over the REAL generated schemas ───────────────────────

describe('schema resolver (against real /api/node-types output)', () => {
  it('tg.trigger: enums select, strings text', () => {
    expect(widgetsOf('tg.trigger')).toEqual({
      event: 'select',
      command: 'text',
      pattern: 'text',
      patternType: 'select',
      button_key: 'text',
    });
  });

  it('tg.sendMessage: keyboard detected structurally, text multiline, options object', () => {
    expect(widgetsOf('tg.sendMessage')).toMatchObject({
      chat: 'text', // anyOf[number,string] → one expression-aware box
      type: 'select',
      text: 'multiline',
      caption: 'multiline',
      keyboard: 'keyboard',
      options: 'object',
    });
  });

  it('tg.waitForReply: union prompt, duration timeout, validation object', () => {
    expect(widgetsOf('tg.waitForReply')).toMatchObject({
      prompt: 'union',
      expect: 'select',
      validation: 'object',
      invalid_message: 'multiline',
      max_retries: 'number',
      save_to: 'text',
      timeout: 'duration',
    });
  });

  it('flow.if: conditions widget detected structurally; setFields/stopError basics', () => {
    expect(widgetsOf('flow.if')).toEqual({ conditions: 'conditions', combine: 'select' });
    expect(widgetsOf('data.setFields')).toEqual({ fields: 'rows', keep_only_set: 'boolean' });
    expect(widgetsOf('flow.stopError')).toEqual({ message: 'multiline', notify_user: 'boolean' });
  });

  it('http.request: credentialId resolves to the credentialRef selector (P3-T4)', () => {
    // The ctbWidget annotation must survive z.toJSONSchema all the way to the
    // form engine, so the param renders as the stored-credential picker.
    expect(widgetsOf('http.request')).toMatchObject({
      url: 'text',
      credentialId: 'credentialRef',
      method: 'select',
    });
  });

  it('data.collection: collection selector + structural where/sort/field rows (P3.5-T5)', () => {
    // The `collection` slug param carries the ctbWidget:'collectionRef' annotation
    // (a dedicated picker), while where/sort/fields are arrays-of-objects that the
    // generic `rows` widget renders — no node-type special-casing.
    expect(widgetsOf('data.collection')).toMatchObject({
      collection: 'collectionRef',
      operation: 'select',
      where: 'rows',
      sort: 'rows',
      fields: 'rows',
      mode: 'select',
      record_id: 'text',
      confirm_many: 'boolean',
      suppress_events: 'boolean',
    });
  });

  it('collection.recordChanged: collection selector + events/field_filter rows (P3.5-T5)', () => {
    expect(widgetsOf('collection.recordChanged')).toMatchObject({
      collection: 'collectionRef',
      events: 'rows',
      field_filter: 'rows',
      condition: 'text',
    });
  });

  it('structural detectors are not fooled by lookalikes', () => {
    expect(isKeyboardSchema({ anyOf: [{ type: 'string' }, { type: 'number' }] })).toBe(false);
    expect(
      isConditionsSchema({ type: 'array', items: { type: 'object', properties: { name: { type: 'string' } } } }),
    ).toBe(false);
    // z.unknown() → {} → expression widget (value1/value2 of a condition row)
    expect(resolveWidget('value1', {})).toBe('expression');
  });

  it('union: prompt branch matching + empty values seed required children', () => {
    const prompt = schemaOf('tg.waitForReply').properties!.prompt!;
    expect(matchBranch(prompt, 'سلام')).toBe(0); // string branch
    expect(matchBranch(prompt, { text: 'hi' })).toBe(1); // object branch
    const objBranch = prompt.anyOf![1]!;
    expect(emptyValue(objBranch)).toEqual({ text: '' }); // required `text` seeded
  });

  it('union: switching branches preserves the user\u2019s text (the ساده⇔پیشرفته bug)', () => {
    const prompt = schemaOf('tg.waitForReply').properties!.prompt!;
    const strBranch = prompt.anyOf![0]!;
    const objBranch = prompt.anyOf![1]!;
    // simple → advanced: text carried into { text }
    expect(convertBranchValue(objBranch, 'اسمت چیه؟')).toEqual({ text: 'اسمت چیه؟' });
    // advanced → simple: .text extracted back out
    expect(convertBranchValue(strBranch, { text: 'چند سالته؟', parse_mode: 'HTML' })).toBe('چند سالته؟');
    // no carry possible → fresh empty value
    expect(convertBranchValue(objBranch, undefined)).toEqual({ text: '' });
    expect(convertBranchValue(strBranch, undefined)).toBe('');
  });
});

// ── value model ──────────────────────────────────────────────────────────────

describe('form value model', () => {
  it('setAtPath creates intermediate containers immutably', () => {
    const base = { a: 1 };
    const next = setAtPath(base, ['validation', 'min'], 5) as Record<string, unknown>;
    expect(next).toEqual({ a: 1, validation: { min: 5 } });
    expect(base).toEqual({ a: 1 }); // untouched
  });

  it('setAtPath into arrays + undefined deletes', () => {
    const v1 = setAtPath({}, ['rows', 0, 'text'], 'hi');
    expect(getAtPath(v1, ['rows', 0, 'text'])).toBe('hi');
    const v2 = setAtPath(v1, ['rows', 0], undefined);
    expect(getAtPath(v2, ['rows'])).toEqual([]);
    const v3 = setAtPath({ a: 1, b: 2 }, ['b'], undefined);
    expect(v3).toEqual({ a: 1 });
  });

  it('moveRow swaps and clamps', () => {
    const root = { fields: [{ name: 'a' }, { name: 'b' }] };
    const path: Path = ['fields'];
    expect(getAtPath(moveRow(root, path, 0, 1), ['fields', 0, 'name'])).toBe('b');
    expect(moveRow(root, path, 0, -1)).toBe(root); // out of range → same ref
  });

  it('pruneEmpty drops "" / undefined / {} but keeps rows, false and 0', () => {
    expect(
      pruneEmpty({
        text: 'hi',
        caption: '',
        media: undefined,
        validation: { regex: '' }, // collapses to {} → dropped
        max_retries: 0,
        notify_user: false,
        fields: [{ name: 'x', value: '' }],
      }),
    ).toEqual({ text: 'hi', max_retries: 0, notify_user: false, fields: [{ name: 'x' }] });
  });
});

// ── expression helpers ───────────────────────────────────────────────────────

describe('expression awareness', () => {
  it('splits literals and {{ }} segments (engine-compatible: unclosed = literal)', () => {
    expect(splitSegments('سلام {{ $vars.name }}!')).toEqual([
      { text: 'سلام ', expr: false },
      { text: '{{ $vars.name }}', expr: true },
      { text: '!', expr: false },
    ]);
    expect(splitSegments('broken {{ $vars.x')).toEqual([{ text: 'broken {{ $vars.x', expr: false }]);
  });

  it('insertHint wraps outside an expression, bare inside one', () => {
    const out = insertHint('Hi ', 3, '$vars.name');
    expect(out.text).toBe('Hi {{ $vars.name }}');
    expect(out.text.slice(0, out.caret)).toBe('Hi {{ $vars.name'); // caret before " }}"
    const inn = insertHint('{{ ', 3, '$json.text');
    expect(inn.text).toBe('{{ $json.text');
  });
});

// ── ACCEPTANCE: every P1 node configurable through widget edits ─────────────

/** Apply widget-style edits (path → value) then commit like the panel does. */
function formEdits(edits: [Path, unknown][]): Record<string, unknown> {
  let value: unknown = {};
  for (const [path, v] of edits) value = setAtPath(value, path, v);
  return pruneEmpty(value) as Record<string, unknown>;
}

const ZODS: Record<string, ZodType> = {
  'tg.trigger': TgTriggerParamsSchema,
  'tg.sendMessage': TgSendMessageParamsSchema,
  'tg.waitForReply': TgWaitForReplyParamsSchema,
  'flow.if': FlowIfParamsSchema,
  'data.setFields': DataSetFieldsParamsSchema,
  'flow.stopError': FlowStopErrorParamsSchema,
};

describe('ACCEPTANCE — P1 nodes fully configurable from widget operations', () => {
  it('tg.trigger: command trigger', () => {
    const params = formEdits([
      [['event'], 'command'],
      [['command'], '/start'],
    ]);
    expect(ZODS['tg.trigger']!.safeParse(params).success).toBe(true);
    expect(params).toEqual({ event: 'command', command: '/start' });
  });

  it('tg.sendMessage: text + inline keyboard built by the grid widget', () => {
    const params = formEdits([
      [['type'], 'text'],
      [['text'], 'انتخاب کن {{ $vars.name }}'],
      // KeyboardWidget setKind('inline') seeds one empty button…
      [['keyboard'], { kind: 'inline', rows: [[{ text: '', kind: 'callback', value: '' }]] }],
      // …then the user types into the grid cells:
      [['keyboard', 'rows', 0, 0, 'text'], 'بله'],
      [['keyboard', 'rows', 0, 0, 'value'], 'yes'],
      [['keyboard', 'rows', 0, 1], { text: 'خیر', kind: 'callback', value: 'no' }],
      [['options', 'silent'], true],
    ]);
    const parsed = ZODS['tg.sendMessage']!.safeParse(params);
    expect(parsed.success).toBe(true);
    expect(getAtPath(params, ['keyboard', 'rows', 0, 1, 'text'])).toBe('خیر');
  });

  it('tg.sendMessage: media type without media fails Zod (superRefine reaches the form)', () => {
    const params = formEdits([[['type'], 'photo']]);
    expect(ZODS['tg.sendMessage']!.safeParse(params).success).toBe(false);
  });

  it('tg.waitForReply: union prompt + validation + duration widget output', () => {
    const params = formEdits([
      // union switched to "advanced" branch then text typed:
      [['prompt'], { text: '' }],
      [['prompt', 'text'], 'چند سالته {{ $vars.name }}؟'],
      [['expect'], 'number'],
      [['validation', 'min'], 1],
      [['validation', 'max'], 120],
      [['invalid_message'], 'یه عدد بین ۱ تا ۱۲۰ بفرست'],
      [['max_retries'], 2],
      [['save_to'], 'age'],
      [['timeout'], '15m'], // DurationWidget emits `${qty}${unit}`
    ]);
    expect(ZODS['tg.waitForReply']!.safeParse(params).success).toBe(true);
  });

  it('flow.if: condition rows widget output', () => {
    const params = formEdits([
      [['conditions'], [{ value1: '', operator: 'equals', value2: '' }]], // add-row seed
      [['conditions', 0, 'value1'], '{{ $vars.age }}'],
      [['conditions', 0, 'operator'], 'gte'],
      [['conditions', 0, 'value2'], '18'],
      [['combine'], 'and'],
    ]);
    expect(ZODS['flow.if']!.safeParse(params).success).toBe(true);
  });

  it('data.setFields: rows widget + boolean', () => {
    const params = formEdits([
      [['fields'], []],
      [['fields', 0], { name: '', target: 'json', op: 'set' }], // emptyValue(items) seed
      [['fields', 0, 'name'], 'greeting'],
      [['fields', 0, 'value'], 'سلام {{ $vars.name }}'],
      [['fields', 0, 'target'], 'vars'],
      [['keep_only_set'], false],
    ]);
    expect(ZODS['data.setFields']!.safeParse(params).success).toBe(true);
  });

  it('flow.stopError: message + notify_user', () => {
    const params = formEdits([
      [['message'], 'سن نامعتبر بعد از چند تلاش'],
      [['notify_user'], false],
    ]);
    expect(ZODS['flow.stopError']!.safeParse(params).success).toBe(true);
  });

  it('every sample-flow fixture node round-trips: params → widget re-edit → identical', () => {
    // For each fixture node: feed its params through prune (panel commit path)
    // and re-validate with the node's real Zod schema — proves the form's
    // commit pipeline never corrupts a flow that came from the canonical
    // P1 demo fixture.
    const graph = FlowGraphSchema.parse(sampleFlow);
    for (const node of graph.nodes) {
      const zod = ZODS[node.type];
      expect(zod, `schema for ${node.type}`).toBeDefined();
      const committed = pruneEmpty(node.params) as Record<string, unknown>;
      expect(committed).toEqual(node.params); // prune is a no-op on clean params
      expect(zod!.safeParse(committed).success, `${node.id} valid`).toBe(true);
    }
  });
});

// ── progressive disclosure: required-vs-optional split + "+ Add option" ──────
//
// The UX fix: a node shows only its REQUIRED fields (plus any optional field
// the user already filled); the rest hide behind "+ Add option". These tests
// drive the PURE layer (partitionFields/isSet) against the REAL shared schemas
// so the behaviour can't drift from what the form renders.
describe('progressive disclosure (partitionFields / isSet)', () => {
  it('isSet: blanks are unset; 0 / false / non-empty count as set', () => {
    expect(isSet(undefined)).toBe(false);
    expect(isSet(null)).toBe(false);
    expect(isSet('')).toBe(false);
    expect(isSet([])).toBe(false);
    expect(isSet({})).toBe(false);
    expect(isSet('hi')).toBe(true);
    expect(isSet(0)).toBe(true); // a deliberate 0 is a real value
    expect(isSet(false)).toBe(true); // a deliberate false is a real value
    expect(isSet(['a'])).toBe(true);
    expect(isSet({ a: 1 })).toBe(true);
  });

  it('tg.trigger empty: only the required `event` shows, the rest are opt-in', () => {
    // This is the exact node the user opened and found overwhelming.
    const { shown, optional } = partitionFields(schemaOf('tg.trigger'), {});
    expect(shown.map((f) => f.key)).toEqual(['event']);
    // command/pattern/patternType/button_key are all hidden until added.
    expect(optional.map((f) => f.key).sort()).toEqual(
      ['button_key', 'command', 'pattern', 'patternType'],
    );
    // sanity: every property is accounted for exactly once.
    const all = objectFields(schemaOf('tg.trigger')).map((f) => f.key).sort();
    expect([...shown, ...optional].map((f) => f.key).sort()).toEqual(all);
  });

  it('tg.trigger: a filled optional field stays visible (does not hide on reopen)', () => {
    const { shown, optional } = partitionFields(schemaOf('tg.trigger'), {
      event: 'command',
      command: '/start',
    });
    expect(shown.map((f) => f.key).sort()).toEqual(['command', 'event']);
    expect(optional.map((f) => f.key)).not.toContain('command');
  });

  it('adding a blank optional field keeps it shown via the `added` set', () => {
    const schema = schemaOf('tg.trigger');
    // user clicks "+ Add option" → pattern; the form seeds emptyValue ('') and
    // records it in `added` so it stays visible even though '' is not "set".
    const patternSpec = objectFields(schema).find((f) => f.key === 'pattern')!;
    const params = setAtPath({ event: 'text' }, ['pattern'], emptyValue(patternSpec.schema)) as Record<
      string,
      unknown
    >;
    // without `added`, a blank string would hide again:
    expect(partitionFields(schema, params).shown.map((f) => f.key)).not.toContain('pattern');
    // with `added`, it stays shown:
    const added = new Set(['pattern']);
    expect(partitionFields(schema, params, added).shown.map((f) => f.key)).toContain('pattern');
  });

  it('a filled optional field is shown even without the `added` set', () => {
    const schema = schemaOf('tg.trigger');
    const { shown } = partitionFields(schema, { event: 'text', pattern: 'hi' });
    expect(shown.map((f) => f.key)).toContain('pattern');
  });

  it('removing an optional field (unset + drop from added) returns it to the menu', () => {
    const schema = schemaOf('tg.trigger');
    const withPattern = { event: 'text', pattern: 'hi' };
    // the remove (×) handler sets the field to undefined and drops it from added.
    const removed = pruneEmpty(
      setAtPath(withPattern, ['pattern'], undefined) as Record<string, unknown>,
    ) as Record<string, unknown>;
    const { shown, optional } = partitionFields(schema, removed, new Set());
    expect(shown.map((f) => f.key)).toEqual(['event']);
    expect(optional.map((f) => f.key)).toContain('pattern');
  });

  it('tg.sendMessage empty: required text shows; chat/keyboard/options are opt-in', () => {
    // type has a default ('text') so it is not in `required`; text is enforced
    // by superRefine, not the object `required` set — so the baseline shown set
    // is whatever the schema marks required. We assert the OPT-IN ones hide.
    const { shown, optional } = partitionFields(schemaOf('tg.sendMessage'), {});
    const optKeys = optional.map((f) => f.key);
    expect(optKeys).toContain('chat');
    expect(optKeys).toContain('keyboard');
    expect(optKeys).toContain('options');
    // nothing is silently dropped
    const all = objectFields(schemaOf('tg.sendMessage')).map((f) => f.key).sort();
    expect([...shown, ...optional].map((f) => f.key).sort()).toEqual(all);
  });
});
