/**
 * tg.menu — Menu (NODES.md §Telegram). Sends a message with inline buttons;
 * EACH BUTTON IS AN OUTPUT PORT ("btn:<key>").
 *
 * execute() runs ONCE per pause: sends (or edits, edit_in_place) the menu,
 * then returns WAIT with a callback WaitSpec carrying the accepted keys plus
 * per-key label/value metadata. The update router resumes through the clicked
 * button's port with `{ json: { clicked: { key, label, value } } }` — this
 * node NEVER re-executes on resume (Decision Log #13 applies to menus too).
 * `answer_callback_text` rides the WaitSpec; the router answers the
 * callbackQuery from it.
 *
 * edit_in_place: edits the message the click came from ($json.clicked
 * .message_id, set by callbackItem) instead of sending a new message —
 * falls back to a fresh send when there is no prior menu message or the
 * edit fails (e.g. identical content / message too old).
 *
 * Ports: dynamic — one "btn:<key>" per unique button key (+ `timeout` when
 * params.timeout is set), via dynamicOutputs (registry + canvas use it).
 */
import {
  fail,
  menuOutputs,
  TgMenuParamsSchema,
  wait,
  type NodeDef,
  type TgMenuParams,
  type WaitSpec,
} from '@ctb/shared';
import { deadlineFrom } from '../lib/duration';

export const tgMenu: NodeDef<TgMenuParams> = {
  type: 'tg.menu',
  category: 'telegram',
  meta: { labelKey: 'nodes.tg.menu.label', descriptionKey: 'nodes.tg.menu.desc', icon: 'list' },
  ports: { inputs: ['main'], outputs: [] },
  dynamicOutputs: (params) => menuOutputs(params),
  paramsSchema: TgMenuParamsSchema,
  async execute(ctx, params, items) {
    if (ctx.chatId === null) {
      return fail('tg.menu requires a chat context (flow not started from Telegram?)');
    }
    if (!ctx.tg) return fail('tg.menu: no Telegram sender injected');

    const payload: Record<string, unknown> = {
      chat_id: ctx.chatId,
      text: params.text,
      reply_markup: {
        inline_keyboard: params.buttons.map((row) =>
          row.map((b) => ({ text: b.text, callback_data: `btn:${b.key}` })),
        ),
      },
    };
    if (params.parse_mode) payload['parse_mode'] = params.parse_mode;

    // edit_in_place: re-use the message the user just clicked (chained menus).
    const prevId = previousMenuMessageId(items[0]?.json);
    let messageId: number | undefined;
    if (params.edit_in_place && prevId !== undefined && ctx.tg.editMessageText) {
      try {
        await ctx.tg.editMessageText({ ...payload, message_id: prevId });
        messageId = prevId;
      } catch (err) {
        ctx.log('warn', `tg.menu: edit_in_place failed, sending new message: ${err instanceof Error ? err.message : err}`);
      }
    }
    if (messageId === undefined) {
      const sent = await ctx.tg.sendMessage({ ...payload, type: 'text' });
      messageId = sent.messageId;
    }

    // Unique keys + per-key metadata → the router enriches the resume item.
    const buttons: Record<string, { label?: string; value?: string }> = {};
    for (const b of params.buttons.flat()) {
      if (!(b.key in buttons)) {
        buttons[b.key] = { label: b.text, ...(b.value !== undefined ? { value: b.value } : {}) };
      }
    }

    const spec: WaitSpec = {
      kind: 'callback',
      nodeId: 'UNSET', // stamped by the executor (nodes don't know their graph id)
      messageId,
      keys: Object.keys(buttons),
      buttons,
      ...(params.answer_callback_text !== undefined
        ? { answerText: params.answer_callback_text }
        : {}),
      timeoutAt: params.timeout ? deadlineFrom(ctx.now(), params.timeout) : null,
    };
    return wait(spec);
  },
};

/** message_id of the menu message the incoming click belongs to (if any). */
function previousMenuMessageId(json: Record<string, unknown> | undefined): number | undefined {
  const clicked = json?.['clicked'];
  if (clicked === null || typeof clicked !== 'object') return undefined;
  const id = (clicked as Record<string, unknown>)['message_id'];
  return typeof id === 'number' ? id : undefined;
}
