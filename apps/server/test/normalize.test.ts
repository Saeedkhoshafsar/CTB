/**
 * P1-T5 — table-driven normalization tests: raw Update → TgEvent.
 */
import type { Update } from 'grammy/types';
import { describe, expect, it } from 'vitest';
import { normalizeUpdate, parseCommand } from '../src/telegram/normalize';

const FROM = {
  id: 111,
  is_bot: false,
  first_name: 'سعید',
  last_name: 'خوش',
  username: 'saeed',
  language_code: 'fa',
};
const CHAT = { id: -222, type: 'group' as const, title: 'g' };
const PRIVATE = { id: 111, type: 'private' as const, first_name: 'سعید' };

function msgUpdate(message: Record<string, unknown>): Update {
  return {
    update_id: 7,
    message: { message_id: 42, date: 0, from: FROM, chat: PRIVATE, ...message },
  } as unknown as Update;
}

describe('parseCommand', () => {
  it.each([
    ['/start', { command: 'start', payload: '' }],
    ['/start ref_abc', { command: 'start', payload: 'ref_abc' }],
    ['/Start', { command: 'start', payload: '' }], // case-insensitive command
    ['/help@MyBot extra  words', { command: 'help', payload: 'extra  words' }],
    ['hello /start', null], // command must be at position 0
    ['سلام', null],
    ['/', null],
  ])('%s', (text, expected) => {
    expect(parseCommand(text)).toEqual(expected);
  });
});

describe('normalizeUpdate (table-driven)', () => {
  it('command message → kind=command with payload', () => {
    const ev = normalizeUpdate('b1', msgUpdate({ text: '/start ref99' }));
    expect(ev).toMatchObject({
      kind: 'command',
      botId: 'b1',
      updateId: 7,
      command: 'start',
      payload: 'ref99',
      text: '/start ref99',
      messageId: 42,
      user: { id: 111, firstName: 'سعید', lastName: 'خوش', username: 'saeed', lang: 'fa', isBot: false },
      chat: { id: 111, type: 'private' },
    });
    expect(ev?.raw).toBeDefined();
  });

  it('plain fa text → kind=text', () => {
    const ev = normalizeUpdate('b1', msgUpdate({ text: 'سلام دنیا' }));
    expect(ev).toMatchObject({ kind: 'text', text: 'سلام دنیا' });
  });

  it('photo → largest size file_id + caption', () => {
    const ev = normalizeUpdate(
      'b1',
      msgUpdate({
        caption: 'cap',
        photo: [
          { file_id: 'small', file_unique_id: 'us', width: 90, height: 90 },
          { file_id: 'BIG', file_unique_id: 'ub', width: 800, height: 800 },
        ],
      }),
    );
    expect(ev).toMatchObject({ kind: 'photo', fileId: 'BIG', fileUniqueId: 'ub', caption: 'cap' });
  });

  it('document → file metadata', () => {
    const ev = normalizeUpdate(
      'b1',
      msgUpdate({
        document: {
          file_id: 'doc1',
          file_unique_id: 'ud',
          file_name: 'گزارش.pdf',
          mime_type: 'application/pdf',
          file_size: 1234,
        },
      }),
    );
    expect(ev).toMatchObject({
      kind: 'document',
      fileId: 'doc1',
      fileName: 'گزارش.pdf',
      mime: 'application/pdf',
      size: 1234,
    });
  });

  it('contact → normalized contact', () => {
    const ev = normalizeUpdate(
      'b1',
      msgUpdate({ contact: { phone_number: '+98912', first_name: 'علی', user_id: 5 } }),
    );
    expect(ev).toMatchObject({
      kind: 'contact',
      contact: { phoneNumber: '+98912', firstName: 'علی', userId: 5 },
    });
  });

  it('location → lat/lon', () => {
    const ev = normalizeUpdate('b1', msgUpdate({ location: { latitude: 35.7, longitude: 51.4 } }));
    expect(ev).toMatchObject({ kind: 'location', location: { latitude: 35.7, longitude: 51.4 } });
  });

  it('callback_query → kind=callback with message chat + id', () => {
    const update = {
      update_id: 9,
      callback_query: {
        id: 'cbq1',
        from: FROM,
        chat_instance: 'ci',
        data: 'btn:buy',
        message: { message_id: 77, date: 0, chat: CHAT },
      },
    } as unknown as Update;
    const ev = normalizeUpdate('b1', update);
    expect(ev).toMatchObject({
      kind: 'callback',
      callbackQueryId: 'cbq1',
      data: 'btn:buy',
      messageId: 77,
      chat: { id: -222, type: 'group' },
      user: { id: 111 },
    });
  });

  it('new_chat_members → kind=chat_join', () => {
    const ev = normalizeUpdate(
      'b1',
      msgUpdate({ chat: CHAT, new_chat_members: [FROM, { id: 9, is_bot: false, first_name: 'X' }] }),
    );
    expect(ev).toMatchObject({ kind: 'chat_join' });
    expect(ev?.kind === 'chat_join' && ev.joined.map((u) => u.id)).toEqual([111, 9]);
  });

  it('unsupported updates → null (sticker message, edited message, no-from)', () => {
    expect(normalizeUpdate('b1', msgUpdate({ sticker: { file_id: 's' } }))).toBeNull();
    expect(
      normalizeUpdate('b1', {
        update_id: 1,
        edited_message: { message_id: 1, date: 0, from: FROM, chat: PRIVATE, text: 'x' },
      } as unknown as Update),
    ).toBeNull();
    expect(
      normalizeUpdate('b1', {
        update_id: 2,
        message: { message_id: 1, date: 0, chat: PRIVATE, text: 'channel-ish' },
      } as unknown as Update),
    ).toBeNull();
  });
});
