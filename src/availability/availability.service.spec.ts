import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import type { Repository } from 'typeorm';

import { Provider } from '../providers/entities/provider.entity';
import { Service } from '../services/entities/service.entity';
import { AvailabilityService } from './availability.service';
import { AvailabilitySlot } from './entities/availability-slot.entity';

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
              return await work({ getRepository: () => slotsRepository });
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
      storedSlot = persistedSlot({ endTime: '17:00:30' });

      await expect(
        service.updateMySlot(ownerUserId, '7', { startTime: '17:00' }),
      ).resolves.toMatchObject({ startTime: '17:00', endTime: '17:00:30' });
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
