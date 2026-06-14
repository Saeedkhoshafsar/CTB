/**
 * collection.recordChanged — Collection record-change trigger (NODES.md §Record
 * Changed Trigger, P3.5-T5). A pure PASS-THROUGH node like tg.trigger: the
 * matching (slug + event kind + field_filter + condition) and the loop guard
 * all happen HOST-side in the record-write event bus (apps/server,
 * RecordEventBus). By the time execute() runs the host has already decided this
 * flow should fire and pre-built the trigger item; the node just forwards it.
 *
 * Emitted item shape (built by the bus): `{ event, record, record_id, source,
 * previous? }` — `previous` only on `updated`.
 */
import {
  RecordChangedParamsSchema,
  out,
  type NodeDef,
  type RecordChangedParams,
} from '@ctb/shared';

export const collectionRecordChanged: NodeDef<RecordChangedParams> = {
  type: 'collection.recordChanged',
  category: 'trigger',
  meta: {
    labelKey: 'nodes.collection.recordChanged.label',
    descriptionKey: 'nodes.collection.recordChanged.desc',
    icon: 'database',
  },
  ports: { inputs: [], outputs: ['main'] },
  paramsSchema: RecordChangedParamsSchema,
  // Every param here is a HOST-side directive consumed by the RecordEventBus
  // (slug + event kind + field_filter + the `condition` expression), NOT a
  // runtime template for the node. The executor must NOT {{ }}-resolve them —
  // notably `condition` is an expression string the bus evaluates itself, so
  // letting the executor evaluate it (→ boolean) would fail the z.string()
  // re-validation. The node is a pure pass-through (see file header).
  rawParamKeys: ['collection', 'events', 'field_filter', 'condition'],
  async execute(_ctx, _params, items) {
    return out({ main: items });
  },
};
