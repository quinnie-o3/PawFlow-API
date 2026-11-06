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
import { fingerprintCreateBookingRequest } from './booking-idempotency';
import { BookingsService } from './bookings.service';
import type { CreateBookingDto } from './dto/create-booking.dto';
import { BookingIdempotencyKey } from './entities/booking-idempotency-key.entity';
import { BookingStatusLog } from './entities/booking-status-log.entity';
import { Booking } from './entities/booking.entity';

// Monday 2026-11-02 14:05:30, server local time; the slot is tomorrow 09:00.
const NOW = new Date(2026, 10, 2, 14, 5, 30);
const AFTER_SLOT_START = new Date(2026, 10, 3, 9, 0, 1);
const KEY = '3f0c8a52-6c1e-4f5b-9a7e-2d4b8c1e9f00';
const OTHER_KEY = '8d1e5b7a-0f2c-4c3a-b6d9-7e4f1a2b3c5d';

type Row = Record<string, unknown>;

interface State {
  slot: Row | null;
  pets: Row[];
  bookings: Row[];
  logs: Row[];
  keys: Row[];
  nextId: number;
}

/**
 * Transactional in-memory stand-in for the repositories used by booking
 * creation. A transaction works on the live state and restores a snapshot
 * when its callback throws, mirroring PostgreSQL rollback. Real concurrency
 * (unique-index waits between transactions) is covered by the QA PostgreSQL
 * harness; this spec pins the sequential contract.
 */
function createHarness() {
  const state: State = {
    slot: {
      id: '12',
      providerId: '3',
      serviceId: '5',
      slotDate: '2026-11-03',
      startTime: '09:00:00',
      endTime: '10:00:00',
      capacity: 2,
      bookedCount: 0,
      status: 'OPEN',
    },
    pets: [
      { id: '8', ownerId: '20', status: 'ACTIVE' },
      { id: '9', ownerId: '20', status: 'ACTIVE' },
      { id: '31', ownerId: '21', status: 'ACTIVE' },
    ],
    bookings: [],
    logs: [],
    keys: [],
    nextId: 100,
  };
  const events: string[] = [];
  const failures: { logSave?: Error } = {};
  // Relations requested from the pet and booking repositories (P2-08B).
  const relations: Array<[string, unknown]> = [];

  const keysRepository = {
    createQueryBuilder: () => {
      let values: Row = {};
      const insert = {
        insert: () => insert,
        values: (value: Row) => {
          values = value;
          return insert;
        },
        orIgnore: () => insert,
        returning: () => insert,
        execute: () => {
          events.push('key.insert');
          const taken = state.keys.some(
            (key) =>
              key.customerId === values.customerId &&
              key.idempotencyKey === values.idempotencyKey,
          );

          if (taken) {
            return Promise.resolve({ raw: [] });
          }

          const id = String(state.nextId++);
          state.keys.push({ ...values, id });
          return Promise.resolve({ raw: [{ id }] });
        },
      };
      return insert;
    },
    findOne: ({ where }: { where: Row }) =>
      Promise.resolve(
        state.keys.find(
          (key) =>
            key.customerId === where.customerId &&
            key.idempotencyKey === where.idempotencyKey,
        ) ?? null,
      ),
    update: (criteria: Row, patch: Row) => {
      Object.assign(state.keys.find((key) => key.id === criteria.id)!, patch);
      return Promise.resolve({});
    },
  };

  const slotQuery = {
    setLock: () => slotQuery,
    where: () => slotQuery,
    getOne: () => {
      events.push('slot.lock');
      return Promise.resolve(state.slot ? { ...state.slot } : null);
    },
  };

  const repositories = new Map<unknown, object>([
    [BookingIdempotencyKey, keysRepository],
    [AvailabilitySlot, {
      createQueryBuilder: () => slotQuery,
      save: (value: Row) => {
        state.slot = { ...value };
        return Promise.resolve(value);
      },
    }],
    [Pet, {
      findOne: ({ where, relations: requested }: { where: Row; relations?: unknown }) => {
        relations.push(['pet', requested]);
        return Promise.resolve(
          state.pets.find(
            (pet) =>
              pet.id === where.id &&
              pet.ownerId === where.ownerId &&
              pet.status === where.status,
          ) ?? null,
        );
      },
    }],
    [Service, {
      findOne: () =>
        Promise.resolve({
          id: '5',
          providerId: '3',
          price: '150000.00',
          durationMinutes: 60,
          status: 'ACTIVE',
          category: { status: 'ACTIVE' },
        }),
    }],
    [Provider, {
      findOne: () => Promise.resolve({ id: '3', approvalStatus: 'APPROVED' }),
    }],
    [ProviderWorkingHour, {
      find: ({ where }: { where: { dayOfWeek: number } }) =>
        Promise.resolve([
          { dayOfWeek: where.dayOfWeek, startTime: '00:00:00', endTime: '23:59:00' },
        ]),
    }],
    [Booking, {
      create: (value: Row) => value,
      save: (value: Row) => {
        events.push('booking.insert');
        const saved = { ...value, id: String(state.nextId++) };
        state.bookings.push(saved);
        return Promise.resolve({ ...saved });
      },
      findOne: ({ where, relations: requested }: { where: Row; relations?: unknown }) => {
        relations.push(['booking', requested]);
        const found = state.bookings.find(
          (booking) =>
            booking.id === where.id && booking.customerId === where.customerId,
        );
        return Promise.resolve(found ? { ...found } : null);
      },
    }],
    [BookingStatusLog, {
      create: (value: Row) => value,
      save: (value: Row) => {
        if (failures.logSave) {
          return Promise.reject(failures.logSave);
        }

        state.logs.push(value);
        return Promise.resolve(value);
      },
    }],
  ]);
  const manager = { getRepository: (entity: unknown) => repositories.get(entity) };

  const dataSource = {
    transaction: async (work: (m: object) => Promise<unknown>) => {
      const snapshot = structuredClone(state);

      try {
        return await work(manager);
      } catch (error) {
        Object.assign(state, snapshot);
        throw error;
      }
    },
  };

  return {
    state,
    events,
    failures,
    relations,
    bookings: new BookingsService(dataSource as unknown as DataSource),
  };
}

describe('BookingsService idempotent booking creation (P2-07)', () => {
  let h: ReturnType<typeof createHarness>;
  const dto: CreateBookingDto = { petId: '8', slotId: '12', customerNote: 'gentle' };
  const book = (
    customerId = '20',
    body: CreateBookingDto = dto,
    key = KEY,
    now = NOW,
  ) => h.bookings.createBookingIdempotently(customerId, body, key, now);

  beforeEach(() => {
    h = createHarness();
  });

  it('creates one booking on first use and stores the key against it', async () => {
    const result = await book();

    expect(result.replayed).toBe(false);
    expect(result.booking).toMatchObject({
      customerId: '20',
      petId: '8',
      slotId: '12',
      status: 'PENDING_CONFIRMATION',
      bookedPrice: '150000.00',
    });
    expect(h.state.bookings).toHaveLength(1);
    expect(h.state.slot?.bookedCount).toBe(1);
    expect(h.state.logs).toHaveLength(1);
    expect(h.state.keys).toEqual([
      expect.objectContaining({
        customerId: '20',
        idempotencyKey: KEY,
        requestFingerprint: fingerprintCreateBookingRequest(dto),
        bookingId: result.booking.id,
      }),
    ]);
  });

  it('acquires the key before locking the slot (lock order key -> slot)', async () => {
    await book();

    expect(h.events).toEqual(['key.insert', 'slot.lock', 'booking.insert']);
  });

  it('replays the original booking for the same key and payload without new writes', async () => {
    const first = await book();
    h.events.length = 0;

    const second = await book();
    const third = await book();

    expect(second).toEqual({
      booking: expect.objectContaining({ id: first.booking.id }),
      replayed: true,
    });
    expect(third.booking.id).toBe(first.booking.id);
    expect(h.events).toEqual(['key.insert', 'key.insert']);
    expect(h.state.bookings).toHaveLength(1);
    expect(h.state.slot?.bookedCount).toBe(1);
    expect(h.state.logs).toHaveLength(1);
    expect(h.state.keys).toHaveLength(1);
  });

  it('replays the booking in its current state', async () => {
    const first = await book();
    h.state.bookings[0].status = 'CONFIRMED';

    const replay = await book();

    expect(replay.booking).toMatchObject({ id: first.booking.id, status: 'CONFIRMED' });
  });

  it.each([
    ['another pet', { ...dto, petId: '9' }],
    ['another slot', { ...dto, slotId: '13' }],
    ['another note', { ...dto, customerNote: 'rough' }],
    ['no note', { petId: '8', slotId: '12' }],
  ])('rejects the same key with %s as 409 without writes', async (_label, other) => {
    await book();

    await expect(book('20', other)).rejects.toThrow(
      new ConflictException(
        'This Idempotency-Key was already used for a different booking request',
      ),
    );
    expect(h.state.bookings).toHaveLength(1);
    expect(h.state.slot?.bookedCount).toBe(1);
    expect(h.state.logs).toHaveLength(1);
  });

  it('keeps keys independent between customers and never returns another customer\'s booking', async () => {
    const mine = await book('20');
    const theirs = await book('21', { petId: '31', slotId: '12' });

    expect(theirs.replayed).toBe(false);
    expect(theirs.booking.id).not.toBe(mine.booking.id);
    expect(theirs.booking.customerId).toBe('21');
    expect(h.state.bookings).toHaveLength(2);
    expect(h.state.slot?.bookedCount).toBe(2);
    expect(h.state.keys).toHaveLength(2);
  });

  it('treats different keys with an identical payload as separate attempts', async () => {
    const first = await book('20', dto, KEY);
    const second = await book('20', dto, OTHER_KEY);

    expect(second.replayed).toBe(false);
    expect(second.booking.id).not.toBe(first.booking.id);
    expect(h.state.slot?.bookedCount).toBe(2);
    expect(h.state.logs).toHaveLength(2);
  });

  it('returns the original booking after the slot becomes full', async () => {
    const first = await book();
    await book('21', { petId: '31', slotId: '12' }, OTHER_KEY);
    expect(h.state.slot?.bookedCount).toBe(2);

    await expect(book('20', dto, 'fresh-attempt-key-0001')).rejects.toThrow(
      new ConflictException('Availability slot is full'),
    );
    const replay = await book();

    expect(replay).toMatchObject({ replayed: true, booking: { id: first.booking.id } });
    expect(h.state.slot?.bookedCount).toBe(2);
  });

  it('returns the original booking after the slot has started', async () => {
    const first = await book();

    await expect(
      book('20', dto, 'fresh-attempt-key-0002', AFTER_SLOT_START),
    ).rejects.toThrow(BadRequestException);
    const replay = await book('20', dto, KEY, AFTER_SLOT_START);

    expect(replay).toMatchObject({ replayed: true, booking: { id: first.booking.id } });
  });

  it('does not store the key when booking fails, so a later retry can succeed', async () => {
    h.state.slot!.bookedCount = 2;

    await expect(book()).rejects.toThrow(
      new ConflictException('Availability slot is full'),
    );
    expect(h.state.keys).toHaveLength(0);

    h.state.slot!.bookedCount = 1;
    const retry = await book();

    expect(retry.replayed).toBe(false);
    expect(h.state.slot?.bookedCount).toBe(2);
    expect(h.state.keys).toHaveLength(1);
  });

  it('rolls back the key, booking and capacity when the transaction fails late', async () => {
    h.failures.logSave = new Error('connection lost');

    await expect(book()).rejects.toThrow('connection lost');
    expect(h.state.keys).toHaveLength(0);
    expect(h.state.bookings).toHaveLength(0);
    expect(h.state.slot?.bookedCount).toBe(0);
    expect(h.state.logs).toHaveLength(0);

    delete h.failures.logSave;
    const retry = await book();

    expect(retry.replayed).toBe(false);
    expect(h.state.bookings).toHaveLength(1);
    expect(h.state.slot?.bookedCount).toBe(1);
    expect(h.state.logs).toHaveLength(1);
  });

  it.each([
    ['missing slot', () => (h.state.slot = null), NotFoundException],
    ['closed slot', () => (h.state.slot!.status = 'CLOSED'), ConflictException],
    ['foreign pet', () => (h.state.pets[0].ownerId = '99'), NotFoundException],
  ])('preserves the original error for a %s and stores nothing', async (_label, arrange, error) => {
    arrange();

    await expect(book()).rejects.toThrow(error);
    expect(h.state.keys).toHaveLength(0);
    expect(h.state.bookings).toHaveLength(0);
  });

  it('does not store a key rejected by the duration rule, so a retry after the fix succeeds (P2-08A)', async () => {
    h.state.slot!.endTime = '09:59:59';

    await expect(book()).rejects.toThrow(
      new ConflictException(
        'The selected availability slot is shorter than the service duration',
      ),
    );
    expect(h.state.keys).toHaveLength(0);
    expect(h.state.slot?.bookedCount).toBe(0);

    h.state.slot!.endTime = '10:00:00';
    const retry = await book();

    expect(retry.replayed).toBe(false);
    expect(h.state.slot?.bookedCount).toBe(1);
  });

  it('replays an existing booking without re-checking the duration (P2-08A)', async () => {
    const first = await book();
    h.state.slot!.endTime = '09:30:00';

    const replay = await book();

    expect(replay).toMatchObject({ replayed: true, booking: { id: first.booking.id } });
    expect(h.state.slot?.bookedCount).toBe(1);
  });

  it('returns created and replayed bookings loaded for the same customer view (P2-08B)', async () => {
    const created = await book();
    await book();

    expect(created.booking).toMatchObject({
      pet: { id: '8' },
      provider: { id: '3' },
      service: { id: '5', durationMinutes: 60 },
      slot: { id: '12', bookedCount: 1 },
    });
    expect(h.relations).toEqual([
      ['pet', { petType: true }],
      ['booking', { pet: { petType: true }, provider: true, service: true, slot: true }],
    ]);
  });

  it('answers 409 for a key whose booking is not recorded (defensive)', async () => {
    h.state.keys.push({
      id: '1',
      customerId: '20',
      idempotencyKey: KEY,
      requestFingerprint: fingerprintCreateBookingRequest(dto),
      bookingId: null,
    });

    await expect(book()).rejects.toThrow(ConflictException);
    expect(h.state.bookings).toHaveLength(0);
  });

  it('leaves the legacy path without a key untouched', async () => {
    const first = await h.bookings.createBooking('20', dto, NOW);
    const second = await h.bookings.createBooking('20', dto, NOW);

    expect(second.id).not.toBe(first.id);
    expect(h.events).not.toContain('key.insert');
    expect(h.state.keys).toHaveLength(0);
    expect(h.state.slot?.bookedCount).toBe(2);
  });
});
