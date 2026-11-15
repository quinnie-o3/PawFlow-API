import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import type { Repository } from 'typeorm';

import { ProviderWorkingHour } from '../providers/entities/provider-working-hour.entity';
import { Provider } from '../providers/entities/provider.entity';
import { Service } from '../services/entities/service.entity';
import { AvailabilityService } from './availability.service';
import { AvailabilitySlot } from './entities/availability-slot.entity';
import {
  getDayOfWeek,
  SLOT_STARTED_MESSAGE,
  type WorkingInterval,
} from './slot-eligibility';

function futureDate(daysAhead: number): string {
  const date = new Date();
  date.setDate(date.getDate() + daysAhead);

  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');

  return `${date.getFullYear()}-${month}-${day}`;
}

describe('AvailabilityService', () => {
  const ownerUserId = '10';
  const provider = {
    id: '1',
    ownerId: ownerUserId,
    approvalStatus: 'APPROVED',
  } as Provider;
  const activeService = {
    id: '3',
    providerId: provider.id,
    status: 'ACTIVE',
    durationMinutes: 60,
  } as Service;
  const slotDate = futureDate(7);

  // In-memory stand-in for the slot row. Mocks below read and write it so
  // tests can observe exactly which columns the service persists.
  let storedSlot: AvailabilitySlot | null;
  let lockQueryBuilder: {
    setLock: jest.Mock;
    where: jest.Mock;
    andWhere: jest.Mock;
    getOne: jest.Mock;
  };
  let slotsRepository: {
    create: jest.Mock;
    save: jest.Mock;
    createQueryBuilder: jest.Mock;
    update: jest.Mock;
    findOneOrFail: jest.Mock;
    manager: { transaction: jest.Mock };
  };
  let service: AvailabilityService;
  // Active working hours of the provider (all weekdays open by default).
  let workingIntervals: WorkingInterval[];
  let providerLockRepository: { findOne: jest.Mock };
  // Service row read FOR SHARE inside slot transactions (P2-08A).
  let serviceLockRepository: { findOne: jest.Mock };
  let serviceRow: Service;
  let workingHoursRepository: { find: jest.Mock };

  // PostgreSQL TIME columns are returned with seconds.
  const persistedSlot = (
    overrides: Partial<AvailabilitySlot> = {},
  ): AvailabilitySlot =>
    ({
      id: '7',
      providerId: provider.id,
      serviceId: activeService.id,
      slotDate,
      startTime: '09:00:00',
      endTime: '17:00:00',
      capacity: 3,
      bookedCount: 0,
      status: 'OPEN',
      ...overrides,
    }) as AvailabilitySlot;

  beforeEach(() => {
    storedSlot = persistedSlot();
    workingIntervals = [0, 1, 2, 3, 4, 5, 6].map((dayOfWeek) => ({
      dayOfWeek,
      startTime: '00:00:00',
      endTime: '23:59:00',
    }));
    providerLockRepository = {
      findOne: jest.fn().mockResolvedValue(provider),
    };
    serviceRow = { ...activeService };
    serviceLockRepository = {
      findOne: jest.fn(
        ({ where }: { where: { id: string; providerId: string } }) =>
          Promise.resolve(
            where.id === serviceRow.id && where.providerId === serviceRow.providerId
              ? { ...serviceRow }
              : null,
          ),
      ),
    };
    // Mirrors the real `where: { providerId, dayOfWeek, isActive: true }`.
    workingHoursRepository = {
      find: jest.fn(
        ({ where }: { where: { dayOfWeek: number; isActive: boolean } }) =>
          Promise.resolve(
            workingIntervals.filter(
              (interval) =>
                interval.dayOfWeek === where.dayOfWeek &&
                where.isActive === true,
            ),
          ),
      ),
    };

    // The lock query is scoped to the caller's provider, like the real
    // `slot.providerId = :providerId` condition.
    let scopedProviderId: string | undefined;
    lockQueryBuilder = {
      setLock: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn(
        (_expression: string, params: { providerId: string }) => {
          scopedProviderId = params.providerId;
          return lockQueryBuilder;
        },
      ),
      getOne: jest.fn(() =>
        Promise.resolve(
          storedSlot && storedSlot.providerId === scopedProviderId
            ? { ...storedSlot }
            : null,
        ),
      ),
    };

    slotsRepository = {
      create: jest.fn((value: Partial<AvailabilitySlot>) => value),
      save: jest.fn((value: AvailabilitySlot) => Promise.resolve(value)),
      createQueryBuilder: jest.fn(() => lockQueryBuilder),
      update: jest.fn(
        (_criteria: object, changes: Partial<AvailabilitySlot>) => {
          storedSlot = { ...(storedSlot as AvailabilitySlot), ...changes };
          return Promise.resolve({ affected: 1 });
        },
      ),
      findOneOrFail: jest.fn(() =>
        Promise.resolve({ ...(storedSlot as AvailabilitySlot) }),
      ),
      manager: {
        // Emulates transaction rollback by restoring the row on failure.
        transaction: jest.fn(
          async (work: (manager: object) => Promise<unknown>) => {
            const snapshot = storedSlot ? { ...storedSlot } : null;

            try {
              return await work({
                getRepository: (entity: unknown) =>
                  entity === Provider
                    ? providerLockRepository
                    : entity === ProviderWorkingHour
                      ? workingHoursRepository
                      : entity === Service
                        ? serviceLockRepository
                        : slotsRepository,
              });
            } catch (error) {
              storedSlot = snapshot;
              throw error;
            }
          },
        ),
      },
    };

    service = new AvailabilityService(
      slotsRepository as unknown as Repository<AvailabilitySlot>,
      {
        findOne: jest.fn().mockResolvedValue(provider),
      } as unknown as Repository<Provider>,
      {
        findOne: jest.fn().mockResolvedValue(activeService),
      } as unknown as Repository<Service>,
    );
  });

  describe('createMySlot time ranges', () => {
    const createDto = (startTime: string, endTime: string) => ({
      serviceId: activeService.id,
      slotDate,
      startTime,
      endTime,
      capacity: 2,
    });

    it('creates a valid 09:00-17:00 slot', async () => {
      await expect(
        service.createMySlot(ownerUserId, createDto('09:00', '17:00')),
      ).resolves.toMatchObject({ startTime: '09:00', endTime: '17:00' });
    });

    it('accepts boundary values 00:00 and 23:59', async () => {
      await expect(
        service.createMySlot(ownerUserId, createDto('00:00', '23:59')),
      ).resolves.toBeDefined();
    });

    it.each([
      ['17:00', '17:00'],
      ['18:00', '17:00'],
      ['22:00', '02:00'],
    ])('rejects %s-%s with 400', async (startTime, endTime) => {
      await expect(
        service.createMySlot(ownerUserId, createDto(startTime, endTime)),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(slotsRepository.save).not.toHaveBeenCalled();
    });
  });

  describe('updateMySlot partial PATCH time ranges', () => {
    it('rejects startTime only, equal to the persisted 17:00:00 endTime', async () => {
      await expect(
        service.updateMySlot(ownerUserId, '7', { startTime: '17:00' }),
      ).rejects.toThrow('startTime must be earlier than endTime');
      expect(slotsRepository.update).not.toHaveBeenCalled();
    });

    it('rejects endTime only, equal to the persisted 09:00:00 startTime', async () => {
      await expect(
        service.updateMySlot(ownerUserId, '7', { endTime: '09:00' }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(slotsRepository.update).not.toHaveBeenCalled();
    });

    it('accepts startTime only, earlier than the persisted endTime', async () => {
      await expect(
        service.updateMySlot(ownerUserId, '7', { startTime: '16:00' }),
      ).resolves.toMatchObject({ startTime: '16:00', endTime: '17:00:00' });
    });

    it('accepts endTime only, later than the persisted startTime', async () => {
      await expect(
        service.updateMySlot(ownerUserId, '7', { endTime: '18:00' }),
      ).resolves.toMatchObject({ startTime: '09:00:00', endTime: '18:00' });
    });

    it('respects nonzero persisted seconds', async () => {
      storedSlot = persistedSlot({ endTime: '18:00:30' });

      await expect(
        service.updateMySlot(ownerUserId, '7', { startTime: '17:00' }),
      ).resolves.toMatchObject({ startTime: '17:00', endTime: '18:00:30' });
    });

    it('treats 17:00-17:00:30 as a valid range that is shorter than the service (409, not 400)', async () => {
      storedSlot = persistedSlot({ endTime: '17:00:30' });

      await expect(
        service.updateMySlot(ownerUserId, '7', { startTime: '17:00' }),
      ).rejects.toThrow(ConflictException);
    });

    it('preserves an existing valid range when only capacity changes', async () => {
      await expect(
        service.updateMySlot(ownerUserId, '7', { capacity: 5 }),
      ).resolves.toMatchObject({
        startTime: '09:00:00',
        endTime: '17:00:00',
        capacity: 5,
      });
    });
  });

  describe('updateMySlot capacity concurrency (C-10)', () => {
    it('reads the slot under a pessimistic_write lock inside a transaction', async () => {
      await service.updateMySlot(ownerUserId, '7', { capacity: 4 });

      expect(slotsRepository.manager.transaction).toHaveBeenCalledTimes(1);
      expect(lockQueryBuilder.setLock).toHaveBeenCalledWith(
        'pessimistic_write',
      );
    });

    it('updates a slot without reservations', async () => {
      await expect(
        service.updateMySlot(ownerUserId, '7', { capacity: 1 }),
      ).resolves.toMatchObject({ capacity: 1, bookedCount: 0 });
    });

    it('accepts capacity above the current bookedCount', async () => {
      storedSlot = persistedSlot({ bookedCount: 2 });

      await expect(
        service.updateMySlot(ownerUserId, '7', { capacity: 5 }),
      ).resolves.toMatchObject({ capacity: 5, bookedCount: 2 });
    });

    it('accepts capacity equal to the current bookedCount', async () => {
      storedSlot = persistedSlot({ bookedCount: 2 });

      await expect(
        service.updateMySlot(ownerUserId, '7', { capacity: 2 }),
      ).resolves.toMatchObject({ capacity: 2, bookedCount: 2 });
    });

    it('rejects capacity below the current bookedCount with 409', async () => {
      storedSlot = persistedSlot({ bookedCount: 2 });

      await expect(
        service.updateMySlot(ownerUserId, '7', { capacity: 1 }),
      ).rejects.toThrow(
        new ConflictException('capacity cannot be lower than bookedCount'),
      );
      expect(slotsRepository.update).not.toHaveBeenCalled();
      expect(storedSlot).toMatchObject({ capacity: 3, bookedCount: 2 });
    });

    it('validates against the bookedCount read under the lock, not a stale value', async () => {
      // A booking committed before this update acquired the lock.
      storedSlot = persistedSlot({ capacity: 3, bookedCount: 3 });

      await expect(
        service.updateMySlot(ownerUserId, '7', { capacity: 2 }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('never writes bookedCount, so a newer reservation cannot be overwritten', async () => {
      storedSlot = persistedSlot({ bookedCount: 1 });

      slotsRepository.update.mockImplementationOnce(
        (_criteria: object, changes: Partial<AvailabilitySlot>) => {
          // Simulates a reservation landing between read and write; the
          // partial UPDATE must leave it intact.
          storedSlot = {
            ...(storedSlot as AvailabilitySlot),
            bookedCount: 2,
            ...changes,
          };
          return Promise.resolve({ affected: 1 });
        },
      );

      const result = await service.updateMySlot(ownerUserId, '7', {
        capacity: 4,
        status: 'CLOSED',
      });

      const [, changes] = slotsRepository.update.mock.calls[0] as [
        object,
        Record<string, unknown>,
      ];

      expect(Object.keys(changes)).not.toContain('bookedCount');
      expect(result).toMatchObject({
        capacity: 4,
        status: 'CLOSED',
        bookedCount: 2,
      });
    });

    it('rejects schedule changes on a booked slot with 409 (existing rule)', async () => {
      storedSlot = persistedSlot({ bookedCount: 1 });

      await expect(
        service.updateMySlot(ownerUserId, '7', { startTime: '10:00' }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(slotsRepository.update).not.toHaveBeenCalled();
    });

    it('hides a slot owned by another provider with the same 404 as a missing one (C-01)', async () => {
      storedSlot = persistedSlot({ providerId: '999' });

      await expect(
        service.updateMySlot(ownerUserId, '7', { capacity: 5 }),
      ).rejects.toThrow(new NotFoundException('Availability slot not found'));
      expect(slotsRepository.update).not.toHaveBeenCalled();
    });

    it('returns 404 for a missing slot', async () => {
      storedSlot = null;

      await expect(
        service.updateMySlot(ownerUserId, '7', { capacity: 5 }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('maps a unique-slot violation during the transaction to 409', async () => {
      slotsRepository.update.mockRejectedValueOnce(
        Object.assign(new Error('duplicate key value'), { code: '23505' }),
      );

      await expect(
        service.updateMySlot(ownerUserId, '7', { capacity: 5 }),
      ).rejects.toThrow(
        new ConflictException('An identical availability slot already exists'),
      );
      expect(storedSlot).toMatchObject({ capacity: 3 });
    });
  });

  describe('working hours (P2-06B)', () => {
    const weekday = getDayOfWeek(slotDate);
    const createDto = (startTime: string, endTime: string, date = slotDate) => ({
      serviceId: activeService.id,
      slotDate: date,
      startTime,
      endTime,
      capacity: 2,
    });
    const hours = (...ranges: Array<[string, string]>) => {
      workingIntervals = ranges.map(([startTime, endTime]) => ({
        dayOfWeek: weekday,
        startTime,
        endTime,
      }));
    };

    it('creates a slot inside an interval, including exact open/close boundaries', async () => {
      hours(['09:00:00', '17:00:00']);

      await expect(
        service.createMySlot(ownerUserId, createDto('09:00', '17:00')),
      ).resolves.toMatchObject({ status: 'OPEN' });
    });

    it.each([
      ['before opening', '08:00', '09:30'],
      ['after closing', '17:00', '18:00'],
      ['crossing closing', '16:30', '17:30'],
      ['crossing opening', '08:59', '10:00'],
    ])('rejects a slot %s with 409 and writes nothing', async (_case, start, end) => {
      hours(['09:00:00', '17:00:00']);

      await expect(
        service.createMySlot(ownerUserId, createDto(start, end)),
      ).rejects.toThrow(ConflictException);
      expect(slotsRepository.save).not.toHaveBeenCalled();
    });

    it('rejects a slot on a weekday without active working hours (closed day)', async () => {
      workingIntervals = [
        { dayOfWeek: (weekday + 1) % 7, startTime: '00:00:00', endTime: '23:59:00' },
      ];

      await expect(
        service.createMySlot(ownerUserId, createDto('09:00', '10:00')),
      ).rejects.toThrow(
        "The slot must fit entirely within one of the provider's active working hours for that day",
      );
    });

    it('supports several intervals per day (split shift) but not their union', async () => {
      hours(['08:00:00', '12:00:00'], ['13:00:00', '17:00:00']);

      await expect(
        service.createMySlot(ownerUserId, createDto('13:00', '14:00')),
      ).resolves.toBeDefined();
      await expect(
        service.createMySlot(ownerUserId, createDto('11:30', '13:30')),
      ).rejects.toThrow(ConflictException);
    });

    it('checks the weekday of the slot date, not of today', async () => {
      // 2028-02-29 (leap day) is a Tuesday.
      workingIntervals = [{ dayOfWeek: 2, startTime: '09:00:00', endTime: '17:00:00' }];

      await expect(
        service.createMySlot(ownerUserId, createDto('09:00', '10:00', '2028-02-29')),
      ).resolves.toBeDefined();
      expect(workingHoursRepository.find).toHaveBeenCalledWith({
        where: { providerId: provider.id, dayOfWeek: 2, isActive: true },
      });
    });

    it('locks the provider row FOR SHARE inside the slot transaction', async () => {
      await service.createMySlot(ownerUserId, createDto('09:00', '10:00'));

      expect(slotsRepository.manager.transaction).toHaveBeenCalledTimes(1);
      expect(providerLockRepository.findOne).toHaveBeenCalledWith({
        where: { id: provider.id },
        lock: { mode: 'pessimistic_read' },
      });
    });

    it('rejects moving a slot outside working hours and leaves it unchanged', async () => {
      hours(['09:00:00', '17:00:00']);

      await expect(
        service.updateMySlot(ownerUserId, '7', { startTime: '08:00' }),
      ).rejects.toThrow(ConflictException);
      expect(storedSlot).toMatchObject({ startTime: '09:00:00' });
    });

    it('rejects reopening a slot that no longer fits working hours', async () => {
      storedSlot = persistedSlot({ status: 'CLOSED' });
      hours(['10:00:00', '17:00:00']);

      await expect(
        service.updateMySlot(ownerUserId, '7', { status: 'OPEN' }),
      ).rejects.toThrow(ConflictException);
      expect(storedSlot).toMatchObject({ status: 'CLOSED' });
    });

    it('still allows capacity or closing changes on a slot outside current hours', async () => {
      hours(['10:00:00', '17:00:00']);

      await expect(
        service.updateMySlot(ownerUserId, '7', { capacity: 5 }),
      ).resolves.toMatchObject({ capacity: 5 });
      await expect(
        service.updateMySlot(ownerUserId, '7', { status: 'CLOSED' }),
      ).resolves.toMatchObject({ status: 'CLOSED' });
      expect(workingHoursRepository.find).not.toHaveBeenCalled();
    });
  });

  describe('service duration (P2-08A)', () => {
    const createDto = (startTime: string, endTime: string) => ({
      serviceId: activeService.id,
      slotDate,
      startTime,
      endTime,
      capacity: 2,
    });
    const durationMessage = (minutes: number) =>
      new ConflictException(
        `The slot must last at least ${minutes} minutes, the duration of its service`,
      );

    it('accepts a slot exactly as long as the service', async () => {
      await expect(
        service.createMySlot(ownerUserId, createDto('09:00', '10:00')),
      ).resolves.toMatchObject({ startTime: '09:00', endTime: '10:00' });
    });

    it('accepts a slot longer than the service', async () => {
      await expect(
        service.createMySlot(ownerUserId, createDto('09:00', '11:15')),
      ).resolves.toBeDefined();
    });

    it.each([
      ['one minute short', '09:59'],
      ['far shorter', '09:15'],
    ])('rejects a slot %s with 409 and writes nothing', async (_case, endTime) => {
      await expect(
        service.createMySlot(ownerUserId, createDto('09:00', endTime)),
      ).rejects.toThrow(durationMessage(60));
      expect(slotsRepository.save).not.toHaveBeenCalled();
    });

    it('reads the service FOR SHARE, scoped to the provider, inside the transaction', async () => {
      await service.createMySlot(ownerUserId, createDto('09:00', '10:00'));

      expect(serviceLockRepository.findOne).toHaveBeenCalledWith({
        where: { id: activeService.id, providerId: provider.id },
        lock: { mode: 'pessimistic_read' },
      });
    });

    it('uses the duration read under the lock, not the pre-check read', async () => {
      // The pre-check repository still returns 60; the locked row is 90.
      serviceRow = { ...activeService, durationMinutes: 90 };

      await expect(
        service.createMySlot(ownerUserId, createDto('09:00', '10:00')),
      ).rejects.toThrow(durationMessage(90));
    });

    it('measures persisted seconds exactly on update', async () => {
      storedSlot = persistedSlot({ startTime: '09:00:00', endTime: '09:59:59' });

      await expect(
        service.updateMySlot(ownerUserId, '7', { startTime: '08:59' }),
      ).resolves.toMatchObject({ startTime: '08:59', endTime: '09:59:59' });
      await expect(
        service.updateMySlot(ownerUserId, '7', { startTime: '09:00' }),
      ).rejects.toThrow(durationMessage(60));
      expect(storedSlot).toMatchObject({ startTime: '08:59' });
    });

    it('rejects shortening a slot below the service duration and rolls back', async () => {
      await expect(
        service.updateMySlot(ownerUserId, '7', { startTime: '16:30' }),
      ).rejects.toThrow(durationMessage(60));
      expect(storedSlot).toMatchObject({ startTime: '09:00:00', endTime: '17:00:00' });
    });

    it('revalidates when switching to a longer service', async () => {
      storedSlot = persistedSlot({ startTime: '09:00:00', endTime: '10:00:00' });
      serviceLockRepository.findOne.mockResolvedValueOnce({
        ...activeService,
        id: '4',
        durationMinutes: 120,
      });

      await expect(
        service.updateMySlot(ownerUserId, '7', { serviceId: '4' }),
      ).rejects.toThrow(durationMessage(120));
      expect(storedSlot).toMatchObject({ serviceId: activeService.id });
    });

    it('rejects reopening a slot that became shorter than its (lengthened) service', async () => {
      storedSlot = persistedSlot({ startTime: '09:00:00', endTime: '10:00:00', status: 'CLOSED' });
      serviceRow = { ...activeService, durationMinutes: 90 };

      await expect(
        service.updateMySlot(ownerUserId, '7', { status: 'OPEN' }),
      ).rejects.toThrow(durationMessage(90));
      expect(storedSlot).toMatchObject({ status: 'CLOSED' });
    });

    it('still allows capacity or closing changes on a too-short slot without touching the service', async () => {
      storedSlot = persistedSlot({ startTime: '09:00:00', endTime: '09:30:00' });

      await expect(
        service.updateMySlot(ownerUserId, '7', { capacity: 5 }),
      ).resolves.toMatchObject({ capacity: 5 });
      await expect(
        service.updateMySlot(ownerUserId, '7', { status: 'CLOSED' }),
      ).resolves.toMatchObject({ status: 'CLOSED' });
      expect(serviceLockRepository.findOne).not.toHaveBeenCalled();
    });

    it('checks the duration before working hours (both 409)', async () => {
      workingIntervals = [];

      await expect(
        service.createMySlot(ownerUserId, createDto('09:00', '09:30')),
      ).rejects.toThrow(durationMessage(60));
    });
  });

  describe('past slot prevention (P2-08A, controlled clock)', () => {
    // Monday 2026-11-02 14:05:30.250, server local time.
    const NOW = new Date(2026, 10, 2, 14, 5, 30, 250);
    const TODAY = '2026-11-02';
    const create = (slotDate: string, startTime: string, endTime: string, now = NOW) =>
      service.createMySlot(
        ownerUserId,
        { serviceId: activeService.id, slotDate, startTime, endTime, capacity: 2 },
        now,
      );

    it('rejects a slot that started earlier in the current minute', async () => {
      await expect(create(TODAY, '14:05', '15:05')).rejects.toThrow(
        new BadRequestException(SLOT_STARTED_MESSAGE),
      );
      expect(slotsRepository.manager.transaction).not.toHaveBeenCalled();
    });

    it('rejects a slot earlier today', async () => {
      await expect(create(TODAY, '08:00', '09:00')).rejects.toThrow(
        new BadRequestException(SLOT_STARTED_MESSAGE),
      );
    });

    it('keeps the existing message for an earlier date', async () => {
      await expect(create('2026-11-01', '23:00', '23:59')).rejects.toThrow(
        new BadRequestException('slotDate cannot be in the past'),
      );
    });

    it('accepts a slot starting in the next minute', async () => {
      await expect(create(TODAY, '14:06', '15:06')).resolves.toMatchObject({
        slotDate: TODAY,
        startTime: '14:06',
      });
    });

    it('accepts tomorrow 00:00 one tenth of a second before midnight', async () => {
      await expect(
        create('2026-11-03', '00:00', '01:00', new Date(2026, 10, 2, 23, 59, 59, 900)),
      ).resolves.toBeDefined();
    });

    it('rejects today 00:00 just after midnight', async () => {
      await expect(
        create('2026-11-03', '00:00', '01:00', new Date(2026, 10, 3, 0, 0, 0, 1)),
      ).rejects.toThrow(new BadRequestException(SLOT_STARTED_MESSAGE));
    });

    it.each([
      ['an earlier day', '2026-11-01', '09:00:00'],
      ['earlier today', TODAY, '09:00:00'],
      ['earlier in the current minute', TODAY, '14:05:00'],
    ])('rejects reopening a slot of %s and leaves it closed', async (_case, date, startTime) => {
      storedSlot = persistedSlot({ slotDate: date, startTime, endTime: '23:00:00', status: 'CLOSED' });

      await expect(
        service.updateMySlot(ownerUserId, '7', { status: 'OPEN' }, NOW),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(storedSlot).toMatchObject({ status: 'CLOSED' });
    });

    it('reopens a closed slot that starts later today', async () => {
      storedSlot = persistedSlot({ slotDate: TODAY, startTime: '15:00:00', endTime: '16:00:00', status: 'CLOSED' });

      await expect(
        service.updateMySlot(ownerUserId, '7', { status: 'OPEN' }, NOW),
      ).resolves.toMatchObject({ status: 'OPEN' });
    });

    it('rejects moving a slot to a start that has passed', async () => {
      storedSlot = persistedSlot({ slotDate: TODAY, startTime: '15:00:00', endTime: '16:00:00' });

      await expect(
        service.updateMySlot(ownerUserId, '7', { startTime: '14:05' }, NOW),
      ).rejects.toThrow(new BadRequestException(SLOT_STARTED_MESSAGE));
      expect(storedSlot).toMatchObject({ startTime: '15:00:00' });
    });

    it('allows moving a past slot into the future', async () => {
      storedSlot = persistedSlot({ slotDate: '2026-11-01', startTime: '09:00:00', endTime: '10:00:00' });

      await expect(
        service.updateMySlot(ownerUserId, '7', { slotDate: '2026-11-04' }, NOW),
      ).resolves.toMatchObject({ slotDate: '2026-11-04' });
    });

    it('still allows closing, cancelling, capacity changes and deactivation of historical slots', async () => {
      storedSlot = persistedSlot({ slotDate: '2026-10-01', bookedCount: 1 });

      await expect(
        service.updateMySlot(ownerUserId, '7', { capacity: 4 }, NOW),
      ).resolves.toMatchObject({ capacity: 4 });
      await expect(
        service.updateMySlot(ownerUserId, '7', { status: 'CLOSED' }, NOW),
      ).resolves.toMatchObject({ status: 'CLOSED' });
      await expect(
        service.updateMySlot(ownerUserId, '7', { status: 'CANCELLED' }, NOW),
      ).resolves.toMatchObject({ status: 'CANCELLED' });
      await expect(service.deactivateMySlot(ownerUserId, '7')).resolves.toBeUndefined();
      expect(storedSlot).toMatchObject({ bookedCount: 1 });
    });
  });

  describe('deactivateMySlot (C-10)', () => {
    it('soft-cancels a slot with reservations and preserves bookedCount', async () => {
      storedSlot = persistedSlot({ bookedCount: 2 });

      await service.deactivateMySlot(ownerUserId, '7');

      expect(lockQueryBuilder.setLock).toHaveBeenCalledWith(
        'pessimistic_write',
      );
      expect(slotsRepository.update).toHaveBeenCalledWith(
        { id: '7' },
        { status: 'CANCELLED' },
      );
      expect(storedSlot).toMatchObject({
        status: 'CANCELLED',
        bookedCount: 2,
      });
    });

    it('hides a slot owned by another provider with the same 404 as a missing one (C-01)', async () => {
      storedSlot = persistedSlot({ providerId: '999' });

      await expect(
        service.deactivateMySlot(ownerUserId, '7'),
      ).rejects.toThrow(new NotFoundException('Availability slot not found'));
      expect(slotsRepository.update).not.toHaveBeenCalled();
    });
  });
});
