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
import { aiAgent } from './ai/agent';
import { aiClassify } from './ai/classify';
import { aiExtract } from './ai/extract';
import { aiLlmChat } from './ai/llm-chat';
import { aiMcpClient } from './ai/mcp-client';
import { collectionRecordChanged } from './data/record-changed';
import { dataCode } from './data/code';
import { dataCollection } from './data/collection';
import { dataKv } from './data/kv';
import { dataSetFields } from './data/set-fields';
import { dataEditFields } from './data/edit-fields';
import { dataFilter } from './data/filter';
import { dataSplitOut } from './data/split-out';
import { dataAggregate } from './data/aggregate';
import { dataSort } from './data/sort';
import { dataLimit } from './data/limit';
import { dataRemoveDuplicates } from './data/remove-duplicates';
import { dataUserProfile } from './data/user-profile';
import { httpRequest } from './data/http-request';
import { flowExecuteSubFlow } from './flow/execute-subflow';
import { flowIf } from './flow/if';
import { flowLoop } from './flow/loop';
import { flowManualTrigger } from './flow/manual-trigger';
import { flowMerge } from './flow/merge';
import { flowRespondToWebhook } from './flow/respond-to-webhook';
import { flowReturn } from './flow/return';
import { flowStopError } from './flow/stop-error';
import { flowSwitch } from './flow/switch';
import { flowWait } from './flow/wait';
import { scheduleTrigger } from './flow/schedule-trigger';
import { webhookTrigger } from './flow/webhook-trigger';
import { tgAnswerCallback } from './tg/answer-callback';
import { tgChatAction } from './tg/chat-action';
import { tgDeleteMessage } from './tg/delete-message';
import { tgEditMessage } from './tg/edit-message';
import { tgMenu } from './tg/menu';
import { tgSendMedia } from './tg/send-media';
import { tgGetFile } from './tg/get-file';
import { tgSendMessage } from './tg/send-message';
import { tgTrigger } from './tg/trigger';
import { tgWaitForReply } from './tg/wait-for-reply';

export { aiAgent, parseToolArguments, type AgentStopReason } from './ai/agent';
export { aiClassify } from './ai/classify';
export { aiExtract } from './ai/extract';
export { aiLlmChat, AI_MEMORY_KEY_PREFIX } from './ai/llm-chat';
export { aiMcpClient } from './ai/mcp-client';
export { collectionRecordChanged } from './data/record-changed';
export { dataCode, normalizeReturn, CODE_TIMEOUT_CAP_MS } from './data/code';
export { dataCollection } from './data/collection';
export { dataKv } from './data/kv';
export { dataSetFields } from './data/set-fields';
export { dataEditFields } from './data/edit-fields';
export { dataFilter } from './data/filter';
export { dataSplitOut } from './data/split-out';
export { dataAggregate } from './data/aggregate';
export { dataSort } from './data/sort';
export { dataLimit } from './data/limit';
export { dataRemoveDuplicates } from './data/remove-duplicates';
export { dataUserProfile } from './data/user-profile';
export { httpRequest } from './data/http-request';
export { flowExecuteSubFlow } from './flow/execute-subflow';
export { flowIf } from './flow/if';
export { flowLoop, LOOP_STATE_PREFIX } from './flow/loop';
export { flowManualTrigger } from './flow/manual-trigger';
export { flowMerge, MERGE_STATE_PREFIX } from './flow/merge';
export {
  flowRespondToWebhook,
  WEBHOOK_RESPONSE_VAR,
  type ParkedWebhookResponse,
} from './flow/respond-to-webhook';
export { flowReturn, SUBFLOW_RETURN_VAR } from './flow/return';
export { flowStopError } from './flow/stop-error';
export { flowSwitch } from './flow/switch';
export { flowWait } from './flow/wait';
export { scheduleTrigger } from './flow/schedule-trigger';
export { webhookTrigger } from './flow/webhook-trigger';
export { tgAnswerCallback } from './tg/answer-callback';
export { tgChatAction } from './tg/chat-action';
export { tgDeleteMessage } from './tg/delete-message';
export { tgEditMessage } from './tg/edit-message';
export { tgMenu } from './tg/menu';
export { tgSendMedia } from './tg/send-media';
export { tgGetFile } from './tg/get-file';
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
  collectionRecordChanged,
  webhookTrigger,
  scheduleTrigger,
  tgSendMessage,
  tgSendMedia,
  tgGetFile,
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
  dataEditFields,
  dataFilter,
  dataSplitOut,
  dataAggregate,
  dataSort,
  dataLimit,
  dataRemoveDuplicates,
  dataKv,
  dataCode,
  dataUserProfile,
  dataCollection,
  httpRequest,
  flowLoop,
  flowMerge,
  flowStopError,
  flowExecuteSubFlow,
  flowReturn,
  flowRespondToWebhook,
  aiLlmChat,
  aiClassify,
  aiExtract,
  aiMcpClient,
  aiAgent,
] as NodeDef<never>[];

/** Register every built-in node on a registry (server boot, tests). */
export function registerBuiltinNodes(registry: NodeRegistry): NodeRegistry {
  for (const def of builtinNodes) registry.register(def);
  return registry;
}
