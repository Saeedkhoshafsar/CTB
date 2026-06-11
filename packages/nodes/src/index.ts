/**
 * @ctb/nodes — built-in node implementations (specs: docs/NODES.md).
 * Wave 1 (P1-T7): tg.trigger, tg.sendMessage, tg.waitForReply,
 * flow.if, data.setFields, flow.stopError.
 * Wave 2 (P2-T6): tg.menu, flow.switch, flow.wait, http.request,
 * data.kv, flow.manualTrigger.
 *
 * Param schemas live in @ctb/shared (invariant I5); implementations here only
 * consume injected capabilities via NodeCtx (invariants I3/I6).
 */
import type { NodeRegistry } from '@ctb/core';
import type { NodeDef } from '@ctb/shared';
import { dataKv } from './data/kv';
import { dataSetFields } from './data/set-fields';
import { httpRequest } from './data/http-request';
import { flowIf } from './flow/if';
import { flowManualTrigger } from './flow/manual-trigger';
import { flowStopError } from './flow/stop-error';
import { flowSwitch } from './flow/switch';
import { flowWait } from './flow/wait';
import { tgMenu } from './tg/menu';
import { tgSendMessage } from './tg/send-message';
import { tgTrigger } from './tg/trigger';
import { tgWaitForReply } from './tg/wait-for-reply';

export { dataKv } from './data/kv';
export { dataSetFields } from './data/set-fields';
export { httpRequest } from './data/http-request';
export { flowIf } from './flow/if';
export { flowManualTrigger } from './flow/manual-trigger';
export { flowStopError } from './flow/stop-error';
export { flowSwitch } from './flow/switch';
export { flowWait } from './flow/wait';
export { tgMenu } from './tg/menu';
export { tgSendMessage } from './tg/send-message';
export { tgTrigger } from './tg/trigger';
export { tgWaitForReply } from './tg/wait-for-reply';
export { compareValues } from './lib/compare';
export { deadlineFrom, parseDuration } from './lib/duration';
export { buildSendPayload, keyboardToMarkup } from './lib/telegram';

/** All built-ins (waves 1+2), palette order: triggers → telegram → flow → data. */
export const builtinNodes: NodeDef<never>[] = [
  tgTrigger,
  flowManualTrigger,
  tgSendMessage,
  tgWaitForReply,
  tgMenu,
  flowIf,
  flowSwitch,
  flowWait,
  dataSetFields,
  dataKv,
  httpRequest,
  flowStopError,
] as NodeDef<never>[];

/** Register every built-in node on a registry (server boot, tests). */
export function registerBuiltinNodes(registry: NodeRegistry): NodeRegistry {
  for (const def of builtinNodes) registry.register(def);
  return registry;
}
