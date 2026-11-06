import { ForbiddenException, NotFoundException } from '@nestjs/common';
import type { DataSource } from 'typeorm';

import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { AvailabilitySlot } from '../availability/entities/availability-slot.entity';
import { ProviderStaff } from '../providers/entities/provider-staff.entity';
import { Provider } from '../providers/entities/provider.entity';
import { assertProviderCanConfirmBookings } from '../providers/provider-lifecycle.policy';
import { BookingsService } from './bookings.service';
import { BookingStatusLog } from './entities/booking-status-log.entity';
import { Booking } from './entities/booking.entity';

type Status = Provider['approvalStatus'];
type Row = Record<string, unknown>;

const OWNER = { id: '30', role: 'PROVIDER_OWNER' } as AuthenticatedUser;
const STAFF = { id: '31', role: 'PROVIDER_STAFF' } as AuthenticatedUser;
const INACTIVE_STAFF = { id: '32', role: 'PROVIDER_STAFF' } as AuthenticatedUser;
const CUSTOMER = { id: '20', role: 'CUSTOMER' } as AuthenticatedUser;

/**
 * Transactional in-memory stand-in for the repositories used by the
 * provider booking actions. It records every lock taken, in order, and
 * restores a snapshot when a transaction throws. The real PostgreSQL race
 * with admin suspension is covered by the QA harness.
 */
function createHarness(approvalStatus: Status) {
  const state = {
    providers: [
      { id: '3', ownerId: '30', approvalStatus },
      { id: '4', ownerId: '40', approvalStatus: 'APPROVED' },
    ] as Row[],
    staff: [
      { userId: '31', providerId: '3', status: 'ACTIVE' },
      { userId: '32', providerId: '3', status: 'INACTIVE' },
    ] as Row[],
    bookings: [
      { id: '100', customerId: '20', providerId: '3', slotId: '12', status: 'PENDING_CONFIRMATION' },
      { id: '101', customerId: '20', providerId: '3', slotId: '12', status: 'CONFIRMED' },
      { id: '200', customerId: '21', providerId: '4', slotId: '13', status: 'PENDING_CONFIRMATION' },
    ] as Row[],
    slots: [
      { id: '12', bookedCount: 2, capacity: 3 },
      { id: '13', bookedCount: 1, capacity: 1 },
    ] as Row[],
    logs: [] as Row[],
  };
  const events: string[] = [];
  const writes: string[] = [];

  const queryBuilder = (table: 'bookings' | 'slots') => {
    let lock: string | undefined;
    let id: unknown;
    const builder = {
      setLock: (mode: string) => ((lock = mode), builder),
      innerJoin: () => builder,
      innerJoinAndSelect: () => builder,
      leftJoinAndSelect: () => builder,
      addSelect: () => builder,
      where: (_sql: string, params: Row) => ((id = Object.values(params)[0]), builder),
      getOne: () => {
        events.push(`${table}:${lock ?? 'read'}`);
        const row = state[table].find((candidate) => candidate.id === id);
        return Promise.resolve(row ? { ...row } : null);
      },
      getOneOrFail: () => builder.getOne(),
    };
    return builder;
  };
  const saveTo = (table: 'bookings' | 'slots') => (value: Row) => {
    writes.push(`${table}:${String(value.status ?? value.bookedCount)}`);
    Object.assign(state[table].find((row) => row.id === value.id)!, value);
    return Promise.resolve({ ...value });
  };

  const repositories = new Map<unknown, object>([
    [Provider, {
      findOne: ({ where, lock }: { where: Row; lock?: { mode: string } }) => {
        events.push(`provider:${lock?.mode ?? 'read'}`);
        const row = state.providers.find((provider) =>
          Object.entries(where).every(([key, value]) => provider[key] === value),
        );
        return Promise.resolve(row ? { ...row } : null);
      },
    }],
    [ProviderStaff, {
      findOne: ({ where }: { where: Row }) =>
        Promise.resolve(
          state.staff.find(
            (staff) => staff.userId === where.userId && staff.status === where.status,
          ) ?? null,
        ),
    }],
    [Booking, {
      createQueryBuilder: () => queryBuilder('bookings'),
      save: saveTo('bookings'),
      findOneOrFail: ({ where }: { where: Row }) =>
        Promise.resolve({ ...state.bookings.find((row) => row.id === where.id) }),
    }],
    [AvailabilitySlot, {
      createQueryBuilder: () => queryBuilder('slots'),
      save: saveTo('slots'),
    }],
    [BookingStatusLog, {
      create: (value: Row) => value,
      save: (value: Row) => {
        writes.push('log');
        state.logs.push(value);
        return Promise.resolve(value);
      },
    }],
  ]);
  const manager = { getRepository: (entity: unknown) => repositories.get(entity) };
  const dataSource = {
    manager,
    getRepository: manager.getRepository,
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
    writes,
    bookings: new BookingsService(dataSource as unknown as DataSource),
    status: (id: string) => state.bookings.find((row) => row.id === id)!.status,
  };
}

describe('Provider suspension and booking lifecycle (P2-09A)', () => {
  describe('policy', () => {
    it.each([
      ['PENDING', false],
      ['APPROVED', true],
      ['REJECTED', false],
      ['SUSPENDED', false],
    ] as Array<[Status, boolean]>)('%s provider can confirm bookings: %s', (approvalStatus, allowed) => {
      const confirm = () => assertProviderCanConfirmBookings({ approvalStatus });

      if (allowed) {
        expect(confirm).not.toThrow();
      } else {
        expect(confirm).toThrow(
          new ForbiddenException(`A ${approvalStatus} provider cannot confirm bookings`),
        );
      }
    });
  });

  describe.each([
    ['owner', OWNER],
    ['active staff', STAFF],
  ])('confirmation by the %s', (_actor, user) => {
    it('succeeds for an APPROVED provider', async () => {
      const h = createHarness('APPROVED');

      await expect(h.bookings.confirmProviderBooking(user, '100')).resolves.toMatchObject({
        id: '100',
        status: 'CONFIRMED',
      });
      expect(h.state.logs).toEqual([
        expect.objectContaining({ oldStatus: 'PENDING_CONFIRMATION', newStatus: 'CONFIRMED', changedBy: user.id }),
      ]);
    });

    it.each(['PENDING', 'REJECTED', 'SUSPENDED'] as Status[])(
      'is 403 for a %s provider, with no booking change or status log',
      async (approvalStatus) => {
        const h = createHarness(approvalStatus);

        await expect(h.bookings.confirmProviderBooking(user, '100')).rejects.toThrow(
          new ForbiddenException(`A ${approvalStatus} provider cannot confirm bookings`),
        );
        expect(h.status('100')).toBe('PENDING_CONFIRMATION');
        expect(h.writes).toEqual([]);
        expect(h.state.logs).toEqual([]);
      },
    );
  });

  it('reads the provider FOR SHARE after locking the booking (booking -> provider)', async () => {
    const h = createHarness('APPROVED');

    await h.bookings.confirmProviderBooking(OWNER, '100');

    expect(h.events.slice(0, 3)).toEqual([
      'provider:read', // resolve the caller's provider (by owner)
      'bookings:pessimistic_write',
      'provider:pessimistic_read',
    ]);
  });

  it('checks the locked row, not the status read while resolving the caller', async () => {
    const h = createHarness('APPROVED');
    const providers = h.state.providers;
    // The suspension commits between resolving the caller and locking the row.
    const original = h.events.push.bind(h.events);
    h.events.push = (...items: string[]) => {
      if (items[0] === 'bookings:pessimistic_write') {
        providers[0].approvalStatus = 'SUSPENDED';
      }
      return original(...items);
    };

    await expect(h.bookings.confirmProviderBooking(OWNER, '100')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(h.status('100')).toBe('PENDING_CONFIRMATION');
  });

  it("keeps 404 for another provider's booking, before the status check", async () => {
    const h = createHarness('SUSPENDED');

    await expect(h.bookings.confirmProviderBooking(OWNER, '200')).rejects.toThrow(
      new NotFoundException('Booking not found'),
    );
    expect(h.events).not.toContain('provider:pessimistic_read');
    expect(h.writes).toEqual([]);
  });

  it('answers 403 before the 409 status check for a suspended provider', async () => {
    const h = createHarness('SUSPENDED');

    await expect(h.bookings.confirmProviderBooking(OWNER, '101')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('keeps the 409 for a non-pending booking of an APPROVED provider', async () => {
    const h = createHarness('APPROVED');

    await expect(h.bookings.confirmProviderBooking(OWNER, '101')).rejects.toThrow(
      'Only a pending confirmation booking can be updated',
    );
  });

  describe.each([
    ['owner', OWNER],
    ['active staff', STAFF],
  ])('a SUSPENDED provider winds down existing bookings (%s)', (_actor, user) => {
    it('rejects a pending booking and releases its capacity', async () => {
      const h = createHarness('SUSPENDED');

      await expect(
        h.bookings.rejectProviderBooking(user, '100', { reason: 'Suspended' }),
      ).resolves.toMatchObject({ status: 'REJECTED' });
      expect(h.state.slots[0].bookedCount).toBe(1);
      expect(h.state.logs).toEqual([
        expect.objectContaining({ newStatus: 'REJECTED', reason: 'Suspended' }),
      ]);
      expect(h.events).not.toContain('provider:pessimistic_read');
    });

    it.each([
      ['complete', 'COMPLETED'],
      ['no-show', 'NO_SHOW'],
    ])('can %s a booking confirmed before the suspension', async (action, status) => {
      const h = createHarness('SUSPENDED');
      const act =
        action === 'complete'
          ? h.bookings.completeProviderBooking(user, '101')
          : h.bookings.noShowProviderBooking(user, '101', {});

      await expect(act).resolves.toMatchObject({ id: '101', status });
      expect(h.state.slots[0].bookedCount).toBe(2);
      expect(h.state.logs).toEqual([
        expect.objectContaining({ oldStatus: 'CONFIRMED', newStatus: status }),
      ]);
    });
  });

  it('keeps the status machine for a suspended provider (cannot complete a pending booking)', async () => {
    const h = createHarness('SUSPENDED');

    await expect(h.bookings.completeProviderBooking(OWNER, '100')).rejects.toThrow(
      'Only a confirmed booking can be updated',
    );
    expect(h.writes).toEqual([]);
  });

  it('never changes existing bookings because of a suspension', async () => {
    const h = createHarness('SUSPENDED');

    await h.bookings.getProviderBookingById(OWNER, '101').catch(() => undefined);

    expect(h.state.bookings.map((booking) => booking.status)).toEqual([
      'PENDING_CONFIRMATION',
      'CONFIRMED',
      'PENDING_CONFIRMATION',
    ]);
    expect(h.writes).toEqual([]);
  });

  it('lets confirmation work again after reactivation to APPROVED', async () => {
    const h = createHarness('SUSPENDED');

    await expect(h.bookings.confirmProviderBooking(STAFF, '100')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    h.state.providers[0].approvalStatus = 'APPROVED';

    await expect(h.bookings.confirmProviderBooking(STAFF, '100')).resolves.toMatchObject({
      status: 'CONFIRMED',
    });
  });

  it('keeps customer cancellation for a suspended provider', async () => {
    const h = createHarness('SUSPENDED');

    await expect(
      h.bookings.cancelMyBooking('20', '101', { reason: 'Provider suspended' }),
    ).resolves.toMatchObject({ status: 'CANCELLED' });
    expect(h.state.slots[0].bookedCount).toBe(1);
  });

  it.each([
    ['inactive staff', INACTIVE_STAFF, 'Active provider staff association is required'],
    ['a customer', CUSTOMER, 'You do not have permission to manage provider bookings'],
  ])('rejects %s with 403 before touching any booking', async (_label, user, message) => {
    const h = createHarness('APPROVED');

    for (const act of [
      () => h.bookings.confirmProviderBooking(user, '100'),
      () => h.bookings.rejectProviderBooking(user, '100', {}),
      () => h.bookings.completeProviderBooking(user, '101'),
      () => h.bookings.noShowProviderBooking(user, '101', {}),
    ]) {
      await expect(act()).rejects.toThrow(new ForbiddenException(message));
    }

    expect(h.events.filter((event) => event.startsWith('bookings'))).toEqual([]);
    expect(h.writes).toEqual([]);
  });
});
