/**
 * tg.waitForReply — the conversation primitive (NODES.md §Telegram).
 *
 * execute() runs ONCE per pause: sends the optional prompt, then returns
 * WAIT with a reply WaitSpec. Everything that happens to the reply afterwards
 * (expect-type check, regex/min/max validation, fa-digit normalization,
 * re-prompt with retry budget, save_to → $vars) is performed by the update
 * router from the durable WaitSpec — this node NEVER re-executes on resume
 * (Decision Logs #13/#14). The executor stamps wait.nodeId.
 *
 * Ports: reply (validated answer) · timeout · invalid (retries exhausted).
 */
import {
  fail,
  TgWaitForReplyParamsSchema,
  wait,
  type NodeDef,
  type TgWaitForReplyParams,
  type WaitSpec,
} from '@ctb/shared';
import { deadlineFrom } from '../lib/duration';
import { buildSendPayload } from '../lib/telegram';

export const tgWaitForReply: NodeDef<TgWaitForReplyParams> = {
  type: 'tg.waitForReply',
  category: 'telegram',
  meta: { labelKey: 'nodes.tg.waitForReply.label', descriptionKey: 'nodes.tg.waitForReply.desc', icon: 'message-circle-question' },
  ports: { inputs: ['main'], outputs: ['reply', 'timeout', 'invalid'] },
  paramsSchema: TgWaitForReplyParamsSchema,
  async execute(ctx, params) {
    if (ctx.chatId === null) {
      return fail('tg.waitForReply requires a chat context (flow not started from Telegram?)');
    }

    if (params.prompt !== undefined) {
      if (!ctx.tg) return fail('tg.waitForReply: prompt set but no Telegram sender injected');
      const p = typeof params.prompt === 'string' ? { text: params.prompt } : params.prompt;
      await ctx.tg.sendMessage(
        buildSendPayload({
          chatId: ctx.chatId,
          type: 'text',
          text: p.text,
          parseMode: typeof params.prompt === 'string' ? undefined : params.prompt.parse_mode,
          keyboard: typeof params.prompt === 'string' ? undefined : params.prompt.keyboard,
        }),
      );
    }

    const spec: WaitSpec = {
      kind: 'reply',
      nodeId: 'UNSET', // stamped by the executor (nodes don't know their graph id)
      expect: params.expect,
      retriesLeft: params.max_retries,
      timeoutAt: params.timeout ? deadlineFrom(ctx.now(), params.timeout) : null,
      ...(params.validation ? { validation: params.validation } : {}),
      ...(params.invalid_message !== undefined ? { invalidMessage: params.invalid_message } : {}),
      ...(params.save_to !== undefined ? { saveTo: params.save_to } : {}),
    };
    return wait(spec);
  },
};
