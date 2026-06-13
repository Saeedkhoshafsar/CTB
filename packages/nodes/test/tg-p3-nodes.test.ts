/**
 * P3-T3 contract tests — tg.editMessage / tg.deleteMessage / tg.answerCallback
 * / tg.chatAction (NODES.md §Telegram). Each node's Telegram I/O is recorded by
 * the harness FakeCtx (edited / editedCaption / editedReplyMarkup / deleted /
 * answeredCallbacks / chatActions). We assert: the right Bot-API payload shape,
 * the message-id / callback-id DEFAULTING convention (read from the input item),
 * pass-through of items, and the loud failures (no chat, no id, unsupported host).
 */
import { describe, expect, it } from 'vitest';
import {
  builtinNodes,
  registerBuiltinNodes,
  tgAnswerCallback,
  tgChatAction,
  tgDeleteMessage,
  tgEditMessage,
} from '@ctb/nodes';
import { NodeRegistry } from '@ctb/core';
import { item, makeCtx, params } from './node-harness';

describe('tg.editMessage', () => {
  it('target=text: editMessageText with chat+message_id from the param (happy)', async () => {
    const ctx = makeCtx({ chatId: 555 });
    const res = await tgEditMessage.execute(
      ctx,
      params(tgEditMessage, { message_id: 42, target: 'text', text: 'updated', parse_mode: 'HTML' }),
      [item({})],
    );
    expect(res.kind).toBe('items');
    expect(ctx.edited).toEqual([{ chat_id: 555, message_id: 42, text: 'updated', parse_mode: 'HTML' }]);
  });

  it('defaults message_id to $json.sent_message_id (edge)', async () => {
    const ctx = makeCtx({ chatId: 555 });
    await tgEditMessage.execute(ctx, params(tgEditMessage, { target: 'text', text: 'x' }), [
      item({ sent_message_id: 99 }),
    ]);
    expect(ctx.edited[0]).toMatchObject({ message_id: 99 });
  });

  it('defaults message_id to $json.clicked.message_id (edge)', async () => {
    const ctx = makeCtx({ chatId: 555 });
    await tgEditMessage.execute(ctx, params(tgEditMessage, { target: 'text', text: 'x' }), [
      item({ clicked: { key: 'a', message_id: 7 } }),
    ]);
    expect(ctx.edited[0]).toMatchObject({ message_id: 7 });
  });

  it('target=caption: uses editMessageCaption with caption field (happy)', async () => {
    const ctx = makeCtx({ chatId: 1 });
    await tgEditMessage.execute(ctx, params(tgEditMessage, { message_id: 5, target: 'caption', text: 'cap' }), [item({})]);
    expect(ctx.editedCaption).toEqual([{ chat_id: 1, message_id: 5, caption: 'cap' }]);
    expect(ctx.edited).toHaveLength(0);
  });

  it('target=keyboard: editMessageReplyMarkup with built markup, no text (happy)', async () => {
    const ctx = makeCtx({ chatId: 1 });
    await tgEditMessage.execute(
      ctx,
      params(tgEditMessage, {
        message_id: 5,
        target: 'keyboard',
        keyboard: { kind: 'inline', rows: [[{ kind: 'callback', text: 'Yes', value: 'y' }]] },
      }),
      [item({})],
    );
    expect(ctx.editedReplyMarkup).toHaveLength(1);
    expect(ctx.editedReplyMarkup[0]).toMatchObject({ chat_id: 1, message_id: 5 });
    expect(ctx.editedReplyMarkup[0]!.reply_markup).toBeDefined();
  });

  it('fails with no message_id anywhere (error)', async () => {
    const ctx = makeCtx({ chatId: 1 });
    const res = await tgEditMessage.execute(ctx, params(tgEditMessage, { target: 'text', text: 'x' }), [item({})]);
    if (res.kind !== 'error') throw new Error('expected error');
    expect(res.message).toMatch(/no message_id/);
  });

  it('fails with no chat context (error)', async () => {
    const ctx = makeCtx({ chatId: null });
    const res = await tgEditMessage.execute(ctx, params(tgEditMessage, { message_id: 1, target: 'text', text: 'x' }), [item({})]);
    if (res.kind !== 'error') throw new Error('expected error');
    expect(res.message).toMatch(/no chat/);
  });

  it('schema: target=text requires non-empty text (error)', () => {
    expect(() => params(tgEditMessage, { target: 'text' })).toThrow(/invalid params/);
  });

  it('schema: target=keyboard requires a keyboard (error)', () => {
    expect(() => params(tgEditMessage, { target: 'keyboard' })).toThrow(/invalid params/);
  });
});

describe('tg.deleteMessage', () => {
  it('deletes by param id, passes items through (happy)', async () => {
    const ctx = makeCtx({ chatId: 9 });
    const input = [item({ a: 1 })];
    const res = await tgDeleteMessage.execute(ctx, params(tgDeleteMessage, { message_id: 3 }), input);
    if (res.kind !== 'items') throw new Error('expected items');
    expect(ctx.deleted).toEqual([{ chat_id: 9, message_id: 3 }]);
    expect(res.outputs.main).toEqual(input);
  });

  it('defaults message_id from the item (edge)', async () => {
    const ctx = makeCtx({ chatId: 9 });
    await tgDeleteMessage.execute(ctx, params(tgDeleteMessage, {}), [item({ sent_message_id: 88 })]);
    expect(ctx.deleted[0]).toEqual({ chat_id: 9, message_id: 88 });
  });

  it('deletes one per item (edge)', async () => {
    const ctx = makeCtx({ chatId: 9 });
    await tgDeleteMessage.execute(ctx, params(tgDeleteMessage, {}), [
      item({ sent_message_id: 1 }),
      item({ sent_message_id: 2 }),
    ]);
    expect(ctx.deleted.map((d) => d.message_id)).toEqual([1, 2]);
  });

  it('fails with no id (error)', async () => {
    const ctx = makeCtx({ chatId: 9 });
    const res = await tgDeleteMessage.execute(ctx, params(tgDeleteMessage, {}), [item({})]);
    if (res.kind !== 'error') throw new Error('expected error');
    expect(res.message).toMatch(/no message_id/);
  });
});

describe('tg.answerCallback', () => {
  it('answers using $json.callback_query_id by default, passes items through (happy)', async () => {
    const ctx = makeCtx();
    const input = [item({ callback_query_id: 'cbq-1', clicked: { key: 'ok' } })];
    const res = await tgAnswerCallback.execute(ctx, params(tgAnswerCallback, {}), input);
    if (res.kind !== 'items') throw new Error('expected items');
    expect(ctx.answeredCallbacks).toEqual([{ callback_query_id: 'cbq-1' }]);
    expect(res.outputs.main).toEqual(input);
  });

  it('includes text + show_alert when set (edge)', async () => {
    const ctx = makeCtx();
    await tgAnswerCallback.execute(
      ctx,
      params(tgAnswerCallback, { callback_query_id: 'cbq-2', text: 'Saved!', show_alert: true }),
      [item({})],
    );
    expect(ctx.answeredCallbacks[0]).toEqual({ callback_query_id: 'cbq-2', text: 'Saved!', show_alert: true });
  });

  it('fails when no callback id available (error)', async () => {
    const ctx = makeCtx();
    const res = await tgAnswerCallback.execute(ctx, params(tgAnswerCallback, {}), [item({})]);
    if (res.kind !== 'error') throw new Error('expected error');
    expect(res.message).toMatch(/no callback_query_id/);
  });
});

describe('tg.chatAction', () => {
  it('sends the action once for the run, passes items through (happy)', async () => {
    const ctx = makeCtx({ chatId: 12 });
    const input = [item({ a: 1 }), item({ b: 2 })];
    const res = await tgChatAction.execute(ctx, params(tgChatAction, { action: 'upload_photo' }), input);
    if (res.kind !== 'items') throw new Error('expected items');
    expect(ctx.chatActions).toEqual([{ chat_id: 12, action: 'upload_photo' }]); // ONCE, not per item
    expect(res.outputs.main).toEqual(input);
  });

  it('defaults action to typing (edge)', async () => {
    const ctx = makeCtx({ chatId: 12 });
    await tgChatAction.execute(ctx, params(tgChatAction, {}), [item({})]);
    expect(ctx.chatActions[0]).toEqual({ chat_id: 12, action: 'typing' });
  });

  it('fails with no chat (error)', async () => {
    const ctx = makeCtx({ chatId: null });
    const res = await tgChatAction.execute(ctx, params(tgChatAction, {}), []);
    if (res.kind !== 'error') throw new Error('expected error');
    expect(res.message).toMatch(/no chat/);
  });
});

describe('registry', () => {
  it('registers the P3-T3 node types (exact count owned by the newest task test)', () => {
    const reg = registerBuiltinNodes(new NodeRegistry());
    const types = reg.list().map((d) => d.type);
    // The exact registry count belongs to the LATEST task's test (P3-T5's
    // user-profile-node.test.ts asserts 22); this P3-T3 test only pins that
    // its four node types are present, so adding nodes later never breaks it.
    expect(builtinNodes.length).toBeGreaterThanOrEqual(21);
    for (const t of ['tg.editMessage', 'tg.deleteMessage', 'tg.answerCallback', 'tg.chatAction']) {
      expect(types).toContain(t);
    }
  });
});
