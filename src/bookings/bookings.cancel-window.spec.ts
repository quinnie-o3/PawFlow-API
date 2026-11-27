import { ConflictException, NotFoundException } from '@nestjs/common';
import type { DataSource } from 'typeorm';

import { OwnershipService } from '../auth/authorization/ownership.service';
import { AvailabilitySlot } from '../availability/entities/availability-slot.entity';
import type { BookingEventsService } from './booking-events.service';
import { BookingsService } from './bookings.service';
import { BookingStatusLog } from './entities/booking-status-log.entity';
import { Booking } from './entities/booking.entity';

// Monday 2026-11-02 14:05:30.250, server local time.
const NOW = new Date(2026, 10, 2, 14, 5, 30, 250);
const TODAY = '2026-11-02';
const TOMORROW = '2026-11-03';
const YESTERDAY = '2026-11-01';

const STARTED_MESSAGE =
  'Bookings can only be cancelled before the appointment starts';

describe('BookingsService.cancelMyBooking cancellation window (BR-07)', () => {
  let booking: Record<string, unknown>;
  let slot: Record<string, unknown>;
  let writes: string[];
  let record: jest.Mock;
  let bookings: BookingsService;

  beforeEach(() => {
    booking = {
      id: '100',
      customerId: '20',
      providerId: '3',
      slotId: '12',
      status: 'CONFIRMED',
    };
    slot = {
      id: '12',
      slotDate: TOMORROW,
      startTime: '09:00:00',
      endTime: '10:00:00',
      capacity: 2,
      bookedCount: 1,
      status: 'OPEN',
    };
    writes = [];
    record = jest.fn().mockResolvedValue(undefined);

    const lockedQuery = (load: () => Record<string, unknown>) => {
      const query: Record<string, jest.Mock> = {};
      query.setLock = jest.fn(() => query);
      query.where = jest.fn(() => query);
      query.getOne = jest.fn(() => Promise.resolve(load()));
      return query;
    };

    const repositories = new Map<unknown, object>([
      [Booking, {
        createQueryBuilder: () => lockedQuery(() => booking),
        save: jest.fn((value: Record<string, unknown>) => {
          writes.push(`booking.status=${String(value.status)}`);
          return Promise.resolve(value);
        }),
        findOneOrFail: jest.fn(() => Promise.resolve(booking)),
      }],
      [AvailabilitySlot, {
        createQueryBuilder: () => lockedQuery(() => slot),
        save: jest.fn((value: Record<string, unknown>) => {
          writes.push(`slot.bookedCount=${String(value.bookedCount)}`);
          return Promise.resolve(value);
        }),
      }],
      [BookingStatusLog, {
        create: (value: object) => value,
        save: jest.fn(() => {
          writes.push('log');
          return Promise.resolve({ id: '700' });
        }),
      }],
    ]);

    const dataSource = {
      transaction: (work: (manager: object) => Promise<unknown>) =>
        work({ getRepository: (entity: unknown) => repositories.get(entity) }),
    };

    bookings = new BookingsService(
      dataSource as unknown as DataSource,
      { record } as unknown as BookingEventsService,
      new OwnershipService(dataSource as unknown as DataSource),
    );
  });

  const cancel = (customerId = '20') =>
    bookings.cancelMyBooking(customerId, '100', { reason: 'x' }, NOW);

  describe('before the appointment starts', () => {
    it.each([
      ['on a later day', TOMORROW, '00:00:00'],
      ['one second from now', TODAY, '14:05:31'],
    ])('cancels a slot starting %s and releases its capacity', async (_case, slotDate, startTime) => {
      slot = { ...slot, slotDate, startTime };

      await expect(cancel()).resolves.toMatchObject({ status: 'CANCELLED' });
      expect(writes).toEqual([
        'booking.status=CANCELLED',
        'slot.bookedCount=0',
        'log',
      ]);
      expect(record).toHaveBeenCalledTimes(1);
    });

    it('applies to a PENDING_CONFIRMATION booking as well', async () => {
      booking.status = 'PENDING_CONFIRMATION';
      slot = { ...slot, slotDate: TODAY, startTime: '14:05:31' };

      await expect(cancel()).resolves.toMatchObject({ status: 'CANCELLED' });
    });
  });

  describe('at or after the appointment start', () => {
    it.each([
      ['starting in the same second as now', TODAY, '14:05:30'],
      ['that started earlier today', TODAY, '09:00:00'],
      ['on an earlier day', YESTERDAY, '23:00:00'],
    ])('rejects a slot %s with 409, writes nothing and records no event', async (_case, slotDate, startTime) => {
      slot = { ...slot, slotDate, startTime };

      await expect(cancel()).rejects.toThrow(
        new ConflictException(STARTED_MESSAGE),
      );
      expect(writes).toEqual([]);
      expect(slot.bookedCount).toBe(1);
      expect(booking.status).toBe('CONFIRMED');
      expect(record).not.toHaveBeenCalled();
    });
  });

  describe('earlier guards still take precedence', () => {
    beforeEach(() => {
      slot = { ...slot, slotDate: YESTERDAY };
    });

    it("hides another customer's booking as 404", async () => {
      await expect(cancel('21')).rejects.toThrow(
        new NotFoundException('Booking not found'),
      );
    });

    it('keeps the non-cancellable status message', async () => {
      booking.status = 'COMPLETED';

      await expect(cancel()).rejects.toThrow(
        'Only pending confirmation or confirmed bookings can be cancelled',
      );
    });
  });
});
