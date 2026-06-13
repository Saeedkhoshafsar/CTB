/**
 * @ctb/nodes — built-in node implementations (specs: docs/NODES.md).
 * Wave 1 (P1-T7): tg.trigger, tg.sendMessage, tg.waitForReply,
 * flow.if, data.setFields, flow.stopError.
 * Wave 2 (P2-T6): tg.menu, flow.switch, flow.wait, http.request,
 * data.kv, flow.manualTrigger.
 * P2-T7: data.code (sandboxed JavaScript — the escape hatch).
 *
 * Param schemas live in @ctb/shared (invariant I5); implementations here only
 * consume injected capabilities via NodeCtx (invariants I3/I6).
 */
import type { NodeRegistry } from '@ctb/core';
import type { NodeDef } from '@ctb/shared';
import { dataCode } from './data/code';
import { dataKv } from './data/kv';
import { dataSetFields } from './data/set-fields';
import { dataUserProfile } from './data/user-profile';
import { httpRequest } from './data/http-request';
import { flowExecuteSubFlow } from './flow/execute-subflow';
import { flowIf } from './flow/if';
import { flowLoop } from './flow/loop';
import { flowManualTrigger } from './flow/manual-trigger';
import { flowMerge } from './flow/merge';
import { flowReturn } from './flow/return';
import { flowStopError } from './flow/stop-error';
import { flowSwitch } from './flow/switch';
import { flowWait } from './flow/wait';
import { tgAnswerCallback } from './tg/answer-callback';
import { tgChatAction } from './tg/chat-action';
import { tgDeleteMessage } from './tg/delete-message';
import { tgEditMessage } from './tg/edit-message';
import { tgMenu } from './tg/menu';
import { tgSendMessage } from './tg/send-message';
import { tgTrigger } from './tg/trigger';
import { tgWaitForReply } from './tg/wait-for-reply';

export { dataCode, normalizeReturn, CODE_TIMEOUT_CAP_MS } from './data/code';
export { dataKv } from './data/kv';
export { dataSetFields } from './data/set-fields';
export { dataUserProfile } from './data/user-profile';
export { httpRequest } from './data/http-request';
export { flowExecuteSubFlow } from './flow/execute-subflow';
export { flowIf } from './flow/if';
export { flowLoop, LOOP_STATE_PREFIX } from './flow/loop';
export { flowManualTrigger } from './flow/manual-trigger';
export { flowMerge, MERGE_STATE_PREFIX } from './flow/merge';
export { flowReturn, SUBFLOW_RETURN_VAR } from './flow/return';
export { flowStopError } from './flow/stop-error';
export { flowSwitch } from './flow/switch';
export { flowWait } from './flow/wait';
export { tgAnswerCallback } from './tg/answer-callback';
export { tgChatAction } from './tg/chat-action';
export { tgDeleteMessage } from './tg/delete-message';
export { tgEditMessage } from './tg/edit-message';
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
  tgEditMessage,
  tgDeleteMessage,
  tgAnswerCallback,
  tgChatAction,
  flowIf,
  flowSwitch,
  flowWait,
  dataSetFields,
  dataKv,
  dataCode,
  dataUserProfile,
  httpRequest,
  flowLoop,
  flowMerge,
  flowStopError,
  flowExecuteSubFlow,
  flowReturn,
] as NodeDef<never>[];

/** Register every built-in node on a registry (server boot, tests). */
export function registerBuiltinNodes(registry: NodeRegistry): NodeRegistry {
  for (const def of builtinNodes) registry.register(def);
  return registry;
}
