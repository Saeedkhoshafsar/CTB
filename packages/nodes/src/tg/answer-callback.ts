/**
 * tg.answerCallback — Answer Callback (NODES.md §"Answer Callback", P3-T3).
 *
 * Acknowledges a button click (stops Telegram's loading spinner) and optionally
 * shows a toast or modal alert, when handling raw callbacks OUTSIDE the Menu
 * node. The callback query id defaults to `$json.callback_query_id` (set by the
 * router on a click) so the common case needs no params. Acknowledges once per
 * input item, passing items through unchanged. All I/O via ctx.tg (I3/I6).
 */
import {
  fail,
  out,
  TgAnswerCallbackParamsSchema,
  type FlowItem,
  type NodeDef,
  type TgAnswerCallbackParams,
} from '@ctb/shared';
import { callbackQueryIdFromItem, tgNoBotError } from './helpers';

export const tgAnswerCallback: NodeDef<TgAnswerCallbackParams> = {
  type: 'tg.answerCallback',
  category: 'telegram',
  meta: { labelKey: 'nodes.tg.answerCallback.label', descriptionKey: 'nodeDesc.tg.answerCallback', icon: 'bell' },
  ports: { inputs: ['main'], outputs: ['main'] },
  paramsSchema: TgAnswerCallbackParamsSchema,
  async execute(ctx, params, items) {
    if (!ctx.tg) return fail(tgNoBotError('پاسخ به دکمه / answer a callback'));
    if (!ctx.tg.answerCallbackQuery) return fail('tg.answerCallback is not supported by this host');

    const inputs: FlowItem[] = items.length > 0 ? items : [{ json: {} }];
    for (const item of inputs) {
      const queryId =
        params.callback_query_id !== undefined && params.callback_query_id !== ''
          ? params.callback_query_id
          : callbackQueryIdFromItem(item.json);
      if (queryId === undefined) {
        return fail('tg.answerCallback: no callback_query_id — set the param or run this after a button click (callbackItem provides it)');
      }
      const payload: Record<string, unknown> = { callback_query_id: queryId };
      if (params.text !== undefined && params.text !== '') payload.text = params.text;
      if (params.show_alert) payload.show_alert = true;
      await ctx.tg.answerCallbackQuery(payload);
    }
    return out({ main: inputs });
  },
};
