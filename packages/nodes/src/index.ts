/**
 * @ctb/nodes — built-in node implementations (specs: docs/NODES.md).
 * Wave 1 (P1-T7): tg.trigger, tg.sendMessage, tg.waitForReply,
 * flow.if, data.setFields, flow.stopError.
 *
 * Param schemas live in @ctb/shared (invariant I5); implementations here only
 * consume injected capabilities via NodeCtx (invariants I3/I6).
 */
import type { NodeRegistry } from '@ctb/core';
import type { NodeDef } from '@ctb/shared';
import { dataSetFields } from './data/set-fields';
import { flowIf } from './flow/if';
import { flowStopError } from './flow/stop-error';
import { tgSendMessage } from './tg/send-message';
import { tgTrigger } from './tg/trigger';
import { tgWaitForReply } from './tg/wait-for-reply';

export { dataSetFields } from './data/set-fields';
export { flowIf } from './flow/if';
export { flowStopError } from './flow/stop-error';
export { tgSendMessage } from './tg/send-message';
export { tgTrigger } from './tg/trigger';
export { tgWaitForReply } from './tg/wait-for-reply';
export { deadlineFrom, parseDuration } from './lib/duration';
export { buildSendPayload, keyboardToMarkup } from './lib/telegram';

/** All wave-1 built-ins, palette order. */
export const builtinNodes: NodeDef<never>[] = [
  tgTrigger,
  tgSendMessage,
  tgWaitForReply,
  flowIf,
  dataSetFields,
  flowStopError,
] as NodeDef<never>[];

/** Register every built-in node on a registry (server boot, tests). */
export function registerBuiltinNodes(registry: NodeRegistry): NodeRegistry {
  for (const def of builtinNodes) registry.register(def);
  return registry;
}
