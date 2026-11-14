import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import type { DataSource } from 'typeorm';

import { AvailabilitySlot } from '../availability/entities/availability-slot.entity';
import { Pet } from '../pets/entities/pet.entity';
import { ProviderWorkingHour } from '../providers/entities/provider-working-hour.entity';
import { Provider } from '../providers/entities/provider.entity';
import { Service } from '../services/entities/service.entity';
import type { BookingEventsService } from './booking-events.service';
import { BookingsService } from './bookings.service';
import { BookingStatusLog } from './entities/booking-status-log.entity';
import { Booking } from './entities/booking.entity';

// Monday 2026-11-02 14:05:30.250, server local time.
const NOW = new Date(2026, 10, 2, 14, 5, 30, 250);
const TODAY = '2026-11-02';
const TOMORROW = '2026-11-03'; // Tuesday

describe('BookingsService.createBooking eligibility (P2-06B)', () => {
  let slot: Record<string, unknown>;
  let service: Record<string, unknown> & { category: Record<string, unknown> };
  let provider: Record<string, unknown>;
  let workingIntervals: Array<Record<string, unknown>>;
  let writes: string[];
  let lockModes: Record<string, string | undefined>;
  let bookings: BookingsService;

  beforeEach(() => {
    slot = {
      id: '12',
      providerId: '3',
      serviceId: '5',
      slotDate: TOMORROW,
      startTime: '09:00:00',
      endTime: '10:00:00',
      capacity: 2,
      bookedCount: 0,
      status: 'OPEN',
    };
    service = {
      id: '5',
      providerId: '3',
      price: '150000.00',
      durationMinutes: 60,
      status: 'ACTIVE',
      category: { status: 'ACTIVE' },
    };
    provider = { id: '3', approvalStatus: 'APPROVED' };
    // Open every day 00:00-23:59 unless a test narrows it.
    workingIntervals = [0, 1, 2, 3, 4, 5, 6].map((dayOfWeek) => ({
      dayOfWeek,
      startTime: '00:00:00',
      endTime: '23:59:00',
    }));
    writes = [];
    lockModes = {};

    const slotQuery: {
      setLock: jest.Mock;
      where: jest.Mock;
      getOne: jest.Mock;
    } = {
      setLock: jest.fn((mode: string) => {
        lockModes.slot = mode;
        return slotQuery;
      }),
      where: jest.fn(() => slotQuery),
      getOne: jest.fn(() => Promise.resolve({ ...slot })),
    };
    const repositories = new Map<unknown, object>([
      [AvailabilitySlot, {
        createQueryBuilder: () => slotQuery,
        save: jest.fn((value: Record<string, unknown>) => {
          writes.push(`slot.bookedCount=${String(value.bookedCount)}`);
          return Promise.resolve(value);
        }),
      }],
      [Pet, { findOne: jest.fn().mockResolvedValue({ id: '8', ownerId: '20' }) }],
      [Service, {
        findOne: jest.fn(({ where, lock }: { where: Record<string, string>; lock?: { mode: string } }) => {
          if (lock) {
            lockModes.service = lock.mode;
          }

          return Promise.resolve(
            where.id === service.id && where.providerId === service.providerId
              ? service
              : null,
          );
        }),
      }],
      [Provider, {
        findOne: jest.fn(({ lock }: { lock?: { mode: string } }) => {
          lockModes.provider = lock?.mode;
          return Promise.resolve(provider);
        }),
      }],
      [ProviderWorkingHour, {
        find: jest.fn(({ where }: { where: { dayOfWeek: number } }) =>
          Promise.resolve(
            workingIntervals.filter((interval) => interval.dayOfWeek === where.dayOfWeek),
          ),
        ),
      }],
      [Booking, {
        create: (value: object) => value,
        save: jest.fn((value: object) => {
          writes.push('booking');
          return Promise.resolve({ ...value, id: '100' });
        }),
      }],
      [BookingStatusLog, {
        create: (value: object) => value,
        save: jest.fn(() => {
          writes.push('log');
          return Promise.resolve({});
        }),
      }],
    ]);

    const dataSource = {
      transaction: (work: (manager: object) => Promise<unknown>) =>
        work({ getRepository: (entity: unknown) => repositories.get(entity) }),
    };

    bookings = new BookingsService(dataSource as unknown as DataSource, { record: jest.fn().mockResolvedValue(undefined) } as unknown as BookingEventsService);
  });

  const book = () =>
    bookings.createBooking('20', { petId: '8', slotId: '12' }, NOW);

  it('books an eligible future slot inside working hours, snapshotting the price', async () => {
    await expect(book()).resolves.toMatchObject({
      status: 'PENDING_CONFIRMATION',
      bookedPrice: '150000.00',
      providerId: '3',
      serviceId: '5',
      slotId: '12',
    });
    expect(writes).toEqual(['booking', 'slot.bookedCount=1', 'log']);
  });

  it('locks the slot FOR UPDATE, the service and the provider FOR SHARE', async () => {
    await book();

    expect(lockModes).toEqual({
      slot: 'pessimistic_write',
      service: 'pessimistic_read',
      provider: 'pessimistic_read',
    });
  });

  describe('start time (controlled clock)', () => {
    it.each([
      ['started earlier within the current minute', '14:05:00'],
      ['same second as now', '14:05:30'],
    ])('rejects a slot %s with 400', async (_case, startTime) => {
      slot = { ...slot, slotDate: TODAY, startTime, endTime: '15:00:00' };

      await expect(book()).rejects.toThrow(
        new BadRequestException('The selected availability slot has already started'),
      );
      expect(writes).toEqual([]);
    });

    it('accepts a slot starting one second from now', async () => {
      slot = { ...slot, slotDate: TODAY, startTime: '14:05:31', endTime: '15:05:31' };

      await expect(book()).resolves.toBeDefined();
    });

    it('rejects a slot of an earlier day with 400', async () => {
      slot = { ...slot, slotDate: '2026-11-01', startTime: '23:00:00', endTime: '23:30:00' };

      await expect(book()).rejects.toThrow('The selected availability slot is in the past');
    });
  });

  describe('working hours', () => {
    it('rejects a slot outside working hours with 409 and writes nothing', async () => {
      workingIntervals = [{ dayOfWeek: 2, startTime: '10:00:00', endTime: '17:00:00' }];

      await expect(book()).rejects.toThrow(
        new ConflictException(
          "The selected availability slot is outside the provider's working hours",
        ),
      );
      expect(writes).toEqual([]);
    });

    it('rejects a slot on a closed weekday with 409', async () => {
      workingIntervals = [{ dayOfWeek: 1, startTime: '00:00:00', endTime: '23:59:00' }];

      await expect(book()).rejects.toBeInstanceOf(ConflictException);
    });

    it('accepts a slot that exactly fills a working interval', async () => {
      workingIntervals = [{ dayOfWeek: 2, startTime: '09:00:00', endTime: '10:00:00' }];

      await expect(book()).resolves.toBeDefined();
    });
  });

  describe('service duration (P2-08A)', () => {
    it.each([
      ['exactly the service duration', 60, '10:00:00'],
      ['longer than the service duration', 45, '10:00:00'],
      ['equal including seconds', 60, '10:00:00.000'],
    ])('accepts a slot %s', async (_case, durationMinutes, endTime) => {
      service.durationMinutes = durationMinutes;
      slot = { ...slot, endTime };

      await expect(book()).resolves.toBeDefined();
    });

    it.each([
      ['one second short', '09:59:59'],
      ['one minute short', '09:59:00'],
    ])('rejects a slot %s with 409 and writes nothing', async (_case, endTime) => {
      slot = { ...slot, endTime };

      await expect(book()).rejects.toThrow(
        new ConflictException(
          'The selected availability slot is shorter than the service duration',
        ),
      );
      expect(writes).toEqual([]);
    });

    it('applies the duration read after the service lock (a lengthened service)', async () => {
      service.durationMinutes = 90;

      await expect(book()).rejects.toBeInstanceOf(ConflictException);
      expect(writes).not.toContain('booking');
    });
  });

  describe('existing rules are preserved', () => {
    it.each([
      ['CLOSED slot', () => { slot.status = 'CLOSED'; }, ConflictException],
      ['full slot', () => { slot.bookedCount = 2; }, ConflictException],
      ['inactive service', () => { service.status = 'INACTIVE'; }, BadRequestException],
      ['inactive category', () => { service.category.status = 'INACTIVE'; }, BadRequestException],
      ['SUSPENDED provider', () => { provider.approvalStatus = 'SUSPENDED'; }, BadRequestException],
      ['PENDING provider', () => { provider.approvalStatus = 'PENDING'; }, BadRequestException],
      ['slot/service/provider mismatch', () => { service.providerId = '4'; }, NotFoundException],
    ])('%s -> %p, nothing written', async (_case, arrange, expected) => {
      arrange();

      await expect(book()).rejects.toBeInstanceOf(expected);
      expect(writes).toEqual([]);
    });
  });
});
