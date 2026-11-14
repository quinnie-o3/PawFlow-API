import { BadRequestException, NotFoundException, ValidationPipe } from '@nestjs/common';
import type { DataSource } from 'typeorm';

import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { GLOBAL_VALIDATION_PIPE_OPTIONS } from '../common/pipes/validation-pipe.options';
import { MarkAllNotificationsReadDto, NotificationListQueryDto } from './dto/notification.dto';
import {
  type CreateNotificationInput,
  normalizeNotificationInput,
  NOTIFICATION_TYPES,
  NOTIFICATION_TYPE_TARGETS,
  NotificationInputError,
} from './notification-types';
import { NotificationsController } from './notifications.controller';
import { NotificationRecipientNotFoundError, NotificationsService } from './notifications.service';

const base: CreateNotificationInput = {
  recipientUserId: '7',
  type: 'BOOKING_CONFIRMED',
  title: 'Booking confirmed',
  body: 'Your appointment on 12 Dec at 09:00 was confirmed.',
  payload: { serviceName: 'Full grooming', startTime: '2026-12-12T09:00:00+07:00', price: 150000, paid: false, note: null },
  target: { type: 'BOOKING', id: '42' },
  eventKey: 'booking:42:CONFIRMED',
};

describe('normalizeNotificationInput (P3-BE04)', () => {
  it('accepts a valid notification and trims text', () => {
    expect(normalizeNotificationInput({ ...base, title: '  Booking confirmed  ' })).toEqual({
      recipientUserId: '7',
      type: 'BOOKING_CONFIRMED',
      title: 'Booking confirmed',
      body: base.body,
      payload: base.payload,
      targetType: 'BOOKING',
      targetId: '42',
      eventKey: 'booking:42:CONFIRMED',
    });
  });

  it('defaults: no payload -> {}, no target, no event key', () => {
    expect(normalizeNotificationInput({ recipientUserId: '1', type: 'SYSTEM_ANNOUNCEMENT', title: 'Hi', body: 'Maintenance tonight.' })).toMatchObject({
      payload: {},
      targetType: null,
      targetId: null,
      eventKey: null,
    });
  });

  it('every type has a defined target rule', () => {
    expect(NOTIFICATION_TYPES).toHaveLength(14);
    for (const type of NOTIFICATION_TYPES) expect(NOTIFICATION_TYPE_TARGETS[type] === null || typeof NOTIFICATION_TYPE_TARGETS[type] === 'string').toBe(true);
  });

  it.each<[string, Partial<CreateNotificationInput> & Record<string, unknown>, string]>([
    ['recipient not a bigint string', { recipientUserId: 7 as never }, 'recipientUserId'],
    ['recipient 0', { recipientUserId: '0' }, 'recipientUserId'],
    ['recipient injection', { recipientUserId: '1 OR 1=1' }, 'recipientUserId'],
    ['unknown type', { type: 'HACKED' as never }, 'unknown type'],
    ['empty title', { title: '   ' }, 'title must not be empty'],
    ['title too long', { title: 'x'.repeat(151) }, 'title must be at most 150'],
    ['body too long', { body: 'x'.repeat(1001) }, 'body must be at most 1000'],
    ['control chars in body', { body: 'a\u0000b' }, 'control characters'],
    ['target of the wrong type', { target: { type: 'COMPLAINT', id: '1' } }, 'can only target BOOKING'],
    ['target on an announcement', { type: 'SYSTEM_ANNOUNCEMENT', target: { type: 'BOOKING', id: '1' } }, 'cannot have a target'],
    ['target id not bigint', { target: { type: 'BOOKING', id: '-1' } }, 'target.id'],
    ['bad event key', { eventKey: 'has spaces' }, 'eventKey'],
    ['payload array', { payload: [] as never }, 'plain object'],
    ['payload nested object', { payload: { a: { b: 1 } } as never }, 'no nesting'],
    ['payload URL', { payload: { next: 'https://evil.example/login' } }, 'must not be a URL'],
    ['payload javascript:', { payload: { next: 'javascript:alert(1)' } }, 'must not be a URL'],
    ['payload www.', { payload: { site: 'www.evil.example' } }, 'must not be a URL'],
    ['payload token key', { payload: { resetToken: 'abc' } }, 'sensitive'],
    ['payload password key', { payload: { password: 'x' } }, 'sensitive'],
    ['payload email key', { payload: { customerEmail: 'a@b.c' } }, 'sensitive'],
    ['payload phone key', { payload: { phone: '0901' } }, 'sensitive'],
    ['payload link key', { payload: { deepLink: '/bookings/1' } }, 'sensitive'],
    ['payload bad key', { payload: { 'bad-key': 1 } }, 'not allowed'],
    ['payload NaN', { payload: { n: Number.NaN } }, 'finite'],
    ['payload too many keys', { payload: Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`k${i}`, i])) }, 'at most 20 keys'],
    ['payload string too long', { payload: { note: 'x'.repeat(301) } }, 'too long'],
  ])('rejects %s', (_label, patch, message) => {
    expect(() => normalizeNotificationInput({ ...base, ...patch } as CreateNotificationInput)).toThrow(NotificationInputError);
    expect(() => normalizeNotificationInput({ ...base, ...patch } as CreateNotificationInput)).toThrow(message);
  });

  it('allows ordinary text with a colon (not a URL)', () => {
    expect(normalizeNotificationInput({ ...base, payload: { reason: 'Reason: provider unavailable', time: '09:30' } }).payload).toEqual({
      reason: 'Reason: provider unavailable',
      time: '09:30',
    });
  });
});

describe('notification DTOs (production ValidationPipe)', () => {
  const pipe = new ValidationPipe(GLOBAL_VALIDATION_PIPE_OPTIONS);
  const query = (value: object) => pipe.transform(value, { type: 'query', metatype: NotificationListQueryDto });
  const body = (value: unknown) => pipe.transform(value, { type: 'body', metatype: MarkAllNotificationsReadDto });

  it('list query: defaults and canonical numbers', async () => {
    await expect(query({})).resolves.toMatchObject({ page: 1, limit: 20, status: 'all' });
    await expect(query({ page: '2', limit: '50', status: 'unread', maxId: '128' })).resolves.toMatchObject({ page: 2, limit: 50, status: 'unread', maxId: '128' });
  });

  it.each([{ page: '0' }, { page: '1001' }, { limit: '51' }, { limit: '1e1' }, { status: 'new' }, { maxId: '0' }, { maxId: 'abc' }, { maxId: '99999999999999999999' }, { userId: '2' }, { recipientUserId: '2' }])(
    'list query rejects %j',
    async (value) => {
      await expect(query(value)).rejects.toBeInstanceOf(BadRequestException);
    },
  );

  it('read-all body: optional upToId (string or safe integer); no other fields', async () => {
    await expect(body({})).resolves.toEqual({});
    await expect(body({ upToId: '12' })).resolves.toEqual({ upToId: '12' });
    await expect(body({ upToId: 12 })).resolves.toEqual({ upToId: '12' });
    for (const bad of [{ upToId: '0' }, { upToId: -1 }, { upToId: 'x' }, { userId: '3' }]) {
      await expect(body(bad)).rejects.toBeInstanceOf(BadRequestException);
    }
  });
});

/** Records SQL; replies are queued per call. */
function fakeDataSource(...replies: unknown[]) {
  const calls: { sql: string; params: unknown[] }[] = [];
  const query = (sql: string, params: unknown[] = []) => {
    calls.push({ sql, params });
    const reply = replies.shift();
    return reply instanceof Error ? Promise.reject(reply) : Promise.resolve(reply);
  };
  const manager = { query };
  return { calls, ds: { query, manager, transaction: (fn: (m: unknown) => unknown) => fn(manager) } as unknown as DataSource };
}

const row = (extra: Record<string, unknown> = {}) => ({
  id: '5',
  type: 'BOOKING_CONFIRMED',
  title: 'Booking confirmed',
  body: 'b',
  payload: {},
  target_type: 'BOOKING',
  target_id: '42',
  read_at: null,
  created_at: new Date('2026-12-01T00:00:00Z'),
  ...extra,
});

describe('NotificationsService (P3-BE04)', () => {
  it('create: inserts with ON CONFLICT on (recipient, event_key) and returns the public view only', async () => {
    const f = fakeDataSource([row()]);
    const res = await new NotificationsService(f.ds).create(base);
    expect(res).toEqual({
      created: true,
      notification: { id: '5', type: 'BOOKING_CONFIRMED', title: 'Booking confirmed', body: 'b', payload: {}, target: { type: 'BOOKING', id: '42' }, isRead: false, readAt: null, createdAt: expect.any(Date) },
    });
    expect(f.calls[0].sql).toMatch(/ON CONFLICT \(recipient_user_id, event_key\) DO NOTHING/);
    expect(f.calls[0].params).toEqual(['7', 'BOOKING_CONFIRMED', 'Booking confirmed', base.body, JSON.stringify(base.payload), 'BOOKING', '42', 'booking:42:CONFIRMED']);
    expect(Object.keys(res.notification)).not.toEqual(expect.arrayContaining(['recipientUserId', 'eventKey']));
  });

  it('create: a duplicate event returns the existing notification with created=false', async () => {
    const f = fakeDataSource([], [row({ id: '3' })]);
    const res = await new NotificationsService(f.ds).create(base);
    expect(res).toMatchObject({ created: false, notification: { id: '3' } });
    expect(f.calls[1].params).toEqual(['7', 'booking:42:CONFIRMED']);
  });

  it('create: unknown recipient (FK 23503) -> NotificationRecipientNotFoundError; invalid input never reaches SQL', async () => {
    const fk = fakeDataSource(Object.assign(new Error('fk'), { code: '23503' }));
    await expect(new NotificationsService(fk.ds).create(base)).rejects.toBeInstanceOf(NotificationRecipientNotFoundError);
    const none = fakeDataSource();
    await expect(new NotificationsService(none.ds).create({ ...base, title: '' })).rejects.toBeInstanceOf(NotificationInputError);
    expect(none.calls).toHaveLength(0);
  });

  it('create: uses the caller transaction manager when given', async () => {
    const f = fakeDataSource();
    const managerCalls: string[] = [];
    const manager = { query: (sql: string) => (managerCalls.push(sql), Promise.resolve([row()])) };
    await new NotificationsService(f.ds).create(base, manager as never);
    expect(managerCalls).toHaveLength(1);
    expect(f.calls).toHaveLength(0);
  });

  it('every read/write query is scoped by the recipient id', async () => {
    const f = fakeDataSource([{ max: '9' }], [{ total: 1 }], [row()], [{ count: 2 }], [row()], [[], 0], [row({ read_at: new Date() })], [[], 3], [{ count: 0 }]);
    const s = new NotificationsService(f.ds);
    await s.list('7', { page: 1, limit: 20, status: 'unread' });
    await s.unreadCount('7');
    await s.findOne('7', '5');
    await s.markRead('7', '5');
    await s.markAllRead('7', '9');
    for (const call of f.calls) {
      expect(call.sql).toMatch(/recipient_user_id = \$(1|2)/);
      expect(call.params).toContain('7');
    }
    // Must order by the bigint column, not the text alias (QA regression: "9" sorted above "30").
    expect(f.calls[2].sql).toMatch(/read_at IS NULL[\s\S]*ORDER BY notifications\.id DESC LIMIT \$3 OFFSET \$4/);
  });

  it('list: empty inbox -> no items, maxId null, no further queries', async () => {
    const f = fakeDataSource([{ max: null }]);
    await expect(new NotificationsService(f.ds).list('7', { page: 1, limit: 20, status: 'all' })).resolves.toEqual({
      items: [],
      meta: { page: 1, limit: 20, totalItems: 0, totalPages: 0, hasNextPage: false, hasPreviousPage: false },
      query: { status: 'all', maxId: null },
    });
    expect(f.calls).toHaveLength(1);
  });

  it('findOne / markRead: another user\'s or a missing notification -> the same 404', async () => {
    const f = fakeDataSource([], [[], 0], []);
    const s = new NotificationsService(f.ds);
    await expect(s.findOne('7', '999')).rejects.toThrow(new NotFoundException('Notification not found'));
    await expect(s.markRead('7', '999')).rejects.toThrow(new NotFoundException('Notification not found'));
  });

  it('markRead is idempotent: an already read row is returned with its original readAt', async () => {
    const readAt = new Date('2026-12-01T01:00:00Z');
    const f = fakeDataSource([[], 0], [row({ read_at: readAt })]);
    await expect(new NotificationsService(f.ds).markRead('7', '5')).resolves.toMatchObject({ isRead: true, readAt });
  });
});

describe('NotificationsController (P3-BE04)', () => {
  it('always uses the authenticated user id, never client input', async () => {
    const service = {
      list: jest.fn().mockResolvedValue('list'),
      unreadCount: jest.fn().mockResolvedValue('count'),
      findOne: jest.fn().mockResolvedValue('one'),
      markRead: jest.fn().mockResolvedValue('read'),
      markAllRead: jest.fn().mockResolvedValue('all'),
    };
    const c = new NotificationsController(service as unknown as NotificationsService);
    const me = { id: '7' } as AuthenticatedUser;
    await c.list(me, { page: 1, limit: 20, status: 'all' } as NotificationListQueryDto);
    await c.unreadCount(me);
    await c.findOne(me, '5');
    await c.markRead(me, '5');
    await c.markAllRead(me, { upToId: '9' });
    expect(service.list).toHaveBeenCalledWith('7', expect.anything());
    expect(service.unreadCount).toHaveBeenCalledWith('7');
    expect(service.findOne).toHaveBeenCalledWith('7', '5');
    expect(service.markRead).toHaveBeenCalledWith('7', '5');
    expect(service.markAllRead).toHaveBeenCalledWith('7', '9');
  });
});
