/**
 * Small shared coercers for the Telegram nodes (P3-T3). Chat ids and message
 * ids arrive as numbers OR expression-resolved strings; these normalize them to
 * integers (or undefined when blank/invalid) so each node validates the same
 * way. `messageIdFromItem` implements the "default to the message this item
 * carries" convention used by tg.editMessage / tg.deleteMessage.
 */

/** number | string → integer chat id, or undefined if blank/non-integer. */
export function coerceChatId(chat: number | string): number | undefined {
  if (typeof chat === 'number') return Number.isInteger(chat) ? chat : undefined;
  const t = chat.trim();
  if (t === '') return undefined;
  const n = Number(t);
  return Number.isInteger(n) ? n : undefined;
}

/** number | string → integer message id, or undefined if blank/non-integer. */
export function coerceMessageId(id: number | string): number | undefined {
  return coerceChatId(id); // identical numeric-id semantics
}

/**
 * The message id an item implicitly refers to: a message tg.sendMessage just
 * sent (`json.sent_message_id`) or the one a button click came from
 * (`json.clicked.message_id`). Returns undefined when neither is present.
 */
export function messageIdFromItem(json: Record<string, unknown>): number | undefined {
  const sent = json['sent_message_id'];
  if (typeof sent === 'number' && Number.isInteger(sent)) return sent;
  const clicked = json['clicked'];
  if (clicked !== null && typeof clicked === 'object') {
    const mid = (clicked as Record<string, unknown>)['message_id'];
    if (typeof mid === 'number' && Number.isInteger(mid)) return mid;
  }
  return undefined;
}

/** Callback query id an item carries (router sets json.callback_query_id). */
export function callbackQueryIdFromItem(json: Record<string, unknown>): string | undefined {
  const id = json['callback_query_id'];
  return typeof id === 'string' && id !== '' ? id : undefined;
}
