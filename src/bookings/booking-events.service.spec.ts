import type { EntityManager } from 'typeorm';

import type { CreateNotificationInput } from '../notifications/notification-types';
import type { NotificationsService } from '../notifications/notifications.service';
import type { EnqueueResult, PushOutboxService } from '../push-delivery/push-outbox.service';
import { BOOKING_EVENT_RULES, BookingEventError, bookingEventKey, BookingEventsService, type BookingEventStatus } from './booking-events.service';

const DETAILS = {
  bookingId: '9',
  customerId: '1',
  ownerId: '2',
  staffUserIds: ['3', '4'],
  serviceName: 'Grooming',
  petName: 'Milo',
  slotDate: '2026-12-12',
  startTime: '09:00:00',
};

function harness(details: Record<string, unknown> | null = DETAILS, outboxResult?: Partial<EnqueueResult>) {
  let next = 100;
  const createMany = jest.fn((inputs: CreateNotificationInput[]) =>
    Promise.resolve(inputs.map((i) => ({ created: true, notification: { id: String(next++), recipientUserId: i.recipientUserId } }))),
  );
  const enqueue = jest.fn((_m: unknown, ids: string[]) => Promise.resolve({ enqueued: ids, alreadyQueued: [], skipped: null, ...outboxResult }));
  const query = jest.fn().mockResolvedValue(details ? [details] : []);
  const transaction = jest.fn();
  const manager = { query, transaction } as unknown as EntityManager;
  const service = new BookingEventsService({ createMany } as unknown as NotificationsService, { enqueue } as unknown as PushOutboxService);
  const inputs = () => createMany.mock.calls.at(-1)![0];
  return { service, manager, createMany, enqueue, query, transaction, inputs };
}

const event = (newStatus: BookingEventStatus, actorUserId: string, statusLogId = '55') => ({ bookingId: '9', statusLogId, newStatus, actorUserId });

describe('BOOKING_EVENT_RULES (BE06-01 matrix)', () => {
  it('covers every booking status with the P3-BE04 type and audience', () => {
    expect(Object.fromEntries(Object.entries(BOOKING_EVENT_RULES).map(([s, r]) => [s, [r.type, r.audience]]))).toEqual({
      PENDING_CONFIRMATION: ['BOOKING_CREATED', 'PROVIDER'],
      CONFIRMED: ['BOOKING_CONFIRMED', 'CUSTOMER'],
      REJECTED: ['BOOKING_REJECTED', 'CUSTOMER'],
      CANCELLED: ['BOOKING_CANCELLED', 'PROVIDER'],
      COMPLETED: ['BOOKING_COMPLETED', 'CUSTOMER'],
      NO_SHOW: ['BOOKING_NO_SHOW', 'CUSTOMER'],
    });
  });

  it('event key = booking:{bookingId}:log:{statusLogId} and matches the P3-BE04 key pattern', () => {
    expect(bookingEventKey('42', '1873')).toBe('booking:42:log:1873');
    expect(bookingEventKey('9223372036854775807', '9223372036854775807')).toMatch(/^[A-Za-z0-9:._-]{1,200}$/);
  });
});

describe('BookingEventsService.record', () => {
  it.each([
    ['PENDING_CONFIRMATION', '1', ['2', '3', '4'], 'BOOKING_CREATED', 'New booking request', 'Grooming for Milo on 2026-12-12 at 09:00 is waiting for your confirmation.'],
    ['CONFIRMED', '3', ['1'], 'BOOKING_CONFIRMED', 'Booking confirmed', 'Your Grooming booking for Milo on 2026-12-12 at 09:00 was confirmed.'],
    ['REJECTED', '2', ['1'], 'BOOKING_REJECTED', 'Booking declined', 'Your Grooming booking for Milo on 2026-12-12 at 09:00 was declined by the provider.'],
    ['CANCELLED', '1', ['2', '3', '4'], 'BOOKING_CANCELLED', 'Booking cancelled', 'The Grooming booking for Milo on 2026-12-12 at 09:00 was cancelled by the customer.'],
    ['COMPLETED', '4', ['1'], 'BOOKING_COMPLETED', 'Booking completed', 'Your Grooming booking for Milo on 2026-12-12 at 09:00 was completed. You can now leave a review.'],
    ['NO_SHOW', '2', ['1'], 'BOOKING_NO_SHOW', 'Booking marked as no-show', 'Your Grooming booking for Milo on 2026-12-12 at 09:00 was marked as a no-show.'],
  ] as const)('%s (actor %s) -> recipients %j, %s', async (status, actor, recipients, type, title, body) => {
    const h = harness();
    const result = await h.service.record(h.manager, event(status, actor));

    expect(h.inputs().map((i) => i.recipientUserId)).toEqual(recipients);
    for (const i of h.inputs()) {
      expect(i).toEqual({
        recipientUserId: i.recipientUserId,
        type,
        title,
        body,
        payload: { bookingId: '9', status, serviceName: 'Grooming', petName: 'Milo', slotDate: '2026-12-12', startTime: '09:00' },
        target: { type: 'BOOKING', id: '9' },
        eventKey: 'booking:9:log:55',
      });
    }
    expect(result).toMatchObject({ eventType: type, eventKey: 'booking:9:log:55', recipientUserIds: recipients });
  });

  it('provider-side events: the acting staff member / owner is excluded, duplicates removed', async () => {
    // owner also listed as ACTIVE staff (defensive): appears once
    const h = harness({ ...DETAILS, staffUserIds: ['2', '3', '3'] });
    await h.service.record(h.manager, event('PENDING_CONFIRMATION', '1'));
    expect(h.inputs().map((i) => i.recipientUserId)).toEqual(['2', '3']);

    // a customer who is also ACTIVE staff of the provider and cancels: not notified of their own action
    const h2 = harness({ ...DETAILS, customerId: '3' });
    await h2.service.record(h2.manager, event('CANCELLED', '3'));
    expect(h2.inputs().map((i) => i.recipientUserId)).toEqual(['2', '4']);
  });

  it('customer acting on their own booking as staff: no recipient, nothing written or enqueued', async () => {
    const h = harness({ ...DETAILS, customerId: '3' });
    const result = await h.service.record(h.manager, event('CONFIRMED', '3'));
    expect(h.createMany).not.toHaveBeenCalled();
    expect(h.enqueue).toHaveBeenCalledWith(h.manager, []);
    expect(result.recipientUserIds).toEqual([]);
  });

  it('recipients come from the booking query only (no staff -> owner only)', async () => {
    const h = harness({ ...DETAILS, staffUserIds: [] });
    await h.service.record(h.manager, event('PENDING_CONFIRMATION', '1'));
    expect(h.inputs().map((i) => i.recipientUserId)).toEqual(['2']);
    const [sql, params] = h.query.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/ps\.status = 'ACTIVE'/);
    expect(params).toEqual(['9']);
  });

  it('uses the caller manager for every write and never opens a transaction', async () => {
    const h = harness();
    await h.service.record(h.manager, event('CONFIRMED', '2'));
    expect(h.createMany).toHaveBeenCalledWith(expect.any(Array), h.manager);
    expect(h.enqueue).toHaveBeenCalledWith(h.manager, ['100']);
    expect(h.transaction).not.toHaveBeenCalled();
  });

  it('only newly created notifications are enqueued (event-key duplicates are not)', async () => {
    const h = harness();
    h.createMany.mockResolvedValueOnce([
      { created: false, notification: { id: '100', recipientUserId: '2' } },
      { created: true, notification: { id: '101', recipientUserId: '3' } },
      { created: false, notification: { id: '102', recipientUserId: '4' } },
    ]);
    const result = await h.service.record(h.manager, event('PENDING_CONFIRMATION', '1'));
    expect(h.enqueue).toHaveBeenCalledWith(h.manager, ['101']);
    expect(result).toMatchObject({ notificationIds: ['100', '101', '102'], createdNotificationIds: ['101'] });
  });

  it('push disabled: the outbox result is passed through (inbox still written)', async () => {
    const h = harness(DETAILS, { enqueued: [], skipped: 'PUSH_DISABLED' });
    const result = await h.service.record(h.manager, event('CONFIRMED', '2'));
    expect(h.createMany).toHaveBeenCalledTimes(1);
    expect(result.outbox).toEqual({ enqueued: [], alreadyQueued: [], skipped: 'PUSH_DISABLED' });
  });

  it('content never contains the free-text reason or contact data', async () => {
    const h = harness();
    await h.service.record(h.manager, event('REJECTED', '2'));
    expect(JSON.stringify(h.inputs())).not.toMatch(/reason|@|phone|email|price/i);
  });

  it('notification and outbox failures propagate (the caller transaction aborts)', async () => {
    const h = harness();
    h.createMany.mockRejectedValueOnce(new Error('insert failed'));
    await expect(h.service.record(h.manager, event('CONFIRMED', '2'))).rejects.toThrow('insert failed');
    expect(h.enqueue).not.toHaveBeenCalled();

    const h2 = harness();
    h2.enqueue.mockRejectedValueOnce(new Error('outbox failed'));
    await expect(h2.service.record(h2.manager, event('CONFIRMED', '2'))).rejects.toThrow('outbox failed');
  });

  it.each([
    [{ statusLogId: undefined }],
    [{ statusLogId: '' }],
    [{ bookingId: 'abc' }],
    [{ actorUserId: '0' }],
    [{ newStatus: 'ARCHIVED' }],
  ])('invalid event %j -> BookingEventError before any query', async (patch) => {
    const h = harness();
    await expect(h.service.record(h.manager, { ...event('CONFIRMED', '2'), ...patch } as never)).rejects.toBeInstanceOf(BookingEventError);
    expect(h.query).not.toHaveBeenCalled();
  });

  it('unknown booking -> BookingEventError, nothing written', async () => {
    const h = harness(null);
    await expect(h.service.record(h.manager, event('CONFIRMED', '2'))).rejects.toBeInstanceOf(BookingEventError);
    expect(h.createMany).not.toHaveBeenCalled();
  });
});
