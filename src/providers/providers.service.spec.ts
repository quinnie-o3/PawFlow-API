import { BadRequestException, ConflictException } from '@nestjs/common';
import type { DataSource, Repository } from 'typeorm';

import { Booking } from '../bookings/entities/booking.entity';

import { ProviderStaff } from './entities/provider-staff.entity';
import { ProviderWorkingHour } from './entities/provider-working-hour.entity';
import { Provider } from './entities/provider.entity';
import { ProvidersService } from './providers.service';

describe('ProvidersService working-hour time ranges', () => {
  const ownerUserId = '10';
  const provider = {
    id: '1',
    ownerId: ownerUserId,
    approvalStatus: 'APPROVED',
  } as Provider;

  let providersRepository: { findOne: jest.Mock };
  let workingHoursRepository: {
    findOne: jest.Mock;
    find: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
  };
  let bookingsRepository: { find: jest.Mock };
  let dataSource: { transaction: jest.Mock };
  let service: ProvidersService;

  // PostgreSQL TIME columns are returned with seconds.
  const persistedWorkingHour = (): ProviderWorkingHour =>
    ({
      id: '5',
      providerId: provider.id,
      dayOfWeek: 1,
      startTime: '09:00:00',
      endTime: '17:00:00',
      isActive: true,
    }) as ProviderWorkingHour;

  beforeEach(() => {
    providersRepository = {
      findOne: jest.fn().mockResolvedValue(provider),
    };
    workingHoursRepository = {
      findOne: jest.fn().mockResolvedValue(persistedWorkingHour()),
      find: jest.fn().mockResolvedValue([persistedWorkingHour()]),
      create: jest.fn((value: Partial<ProviderWorkingHour>) => value),
      save: jest.fn((value: ProviderWorkingHour) => Promise.resolve(value)),
    };
    bookingsRepository = { find: jest.fn().mockResolvedValue([]) };
    // The transaction manager resolves repositories by entity, as TypeORM does.
    dataSource = {
      transaction: jest.fn(
        (work: (manager: object) => Promise<unknown>) =>
          work({
            getRepository: (entity: unknown) =>
              entity === Provider
                ? providersRepository
                : entity === Booking
                  ? bookingsRepository
                  : workingHoursRepository,
          }),
      ),
    };

    service = new ProvidersService(
      providersRepository as unknown as Repository<Provider>,
      {} as Repository<ProviderStaff>,
      workingHoursRepository as unknown as Repository<ProviderWorkingHour>,
      dataSource as unknown as DataSource,
    );
  });

  describe('createMyWorkingHour', () => {
    // No existing entries: the default fake entry would overlap (P2-09B).
    beforeEach(() => workingHoursRepository.find.mockResolvedValue([]));

    it('creates a valid 09:00-17:00 entry', async () => {
      await expect(
        service.createMyWorkingHour(ownerUserId, {
          dayOfWeek: 1,
          startTime: '09:00',
          endTime: '17:00',
        }),
      ).resolves.toMatchObject({ startTime: '09:00', endTime: '17:00' });
    });

    it('accepts boundary values 00:00 and 23:59', async () => {
      await expect(
        service.createMyWorkingHour(ownerUserId, {
          dayOfWeek: 1,
          startTime: '00:00',
          endTime: '23:59',
        }),
      ).resolves.toBeDefined();
    });

    it.each([
      ['17:00', '17:00'],
      ['18:00', '17:00'],
      ['22:00', '02:00'],
    ])('rejects %s-%s with 400', async (startTime, endTime) => {
      await expect(
        service.createMyWorkingHour(ownerUserId, {
          dayOfWeek: 1,
          startTime,
          endTime,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(workingHoursRepository.save).not.toHaveBeenCalled();
    });
  });

  describe('updateMyWorkingHour partial PATCH', () => {
    it('rejects startTime only, equal to the persisted 17:00:00 endTime', async () => {
      await expect(
        service.updateMyWorkingHour(ownerUserId, '5', { startTime: '17:00' }),
      ).rejects.toThrow('startTime must be earlier than endTime');
      expect(workingHoursRepository.save).not.toHaveBeenCalled();
    });

    it('rejects endTime only, equal to the persisted 09:00:00 startTime', async () => {
      await expect(
        service.updateMyWorkingHour(ownerUserId, '5', { endTime: '09:00' }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(workingHoursRepository.save).not.toHaveBeenCalled();
    });

    it('rejects endTime only, earlier than the persisted startTime', async () => {
      await expect(
        service.updateMyWorkingHour(ownerUserId, '5', { endTime: '08:00' }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('accepts startTime only, earlier than the persisted endTime', async () => {
      await expect(
        service.updateMyWorkingHour(ownerUserId, '5', { startTime: '16:59' }),
      ).resolves.toMatchObject({ startTime: '16:59', endTime: '17:00:00' });
    });

    it('accepts endTime only, later than the persisted startTime', async () => {
      await expect(
        service.updateMyWorkingHour(ownerUserId, '5', { endTime: '18:00' }),
      ).resolves.toMatchObject({ startTime: '09:00:00', endTime: '18:00' });
    });

    it('respects nonzero persisted seconds', async () => {
      workingHoursRepository.findOne.mockResolvedValue({
        ...persistedWorkingHour(),
        endTime: '17:00:30',
      });

      await expect(
        service.updateMyWorkingHour(ownerUserId, '5', { startTime: '17:00' }),
      ).resolves.toMatchObject({ startTime: '17:00', endTime: '17:00:30' });
    });

    it('preserves an existing valid range when only isActive changes', async () => {
      await expect(
        service.updateMyWorkingHour(ownerUserId, '5', { isActive: false }),
      ).resolves.toMatchObject({
        startTime: '09:00:00',
        endTime: '17:00:00',
        isActive: false,
      });
    });
  });

  describe('schedule changes vs active bookings (P2-06B)', () => {
    // Next Monday (entry 5 is Monday 09:00-17:00).
    const monday = (() => {
      const date = new Date();
      date.setDate(date.getDate() + ((8 - date.getDay()) % 7 || 7));
      const pad = (value: number) => String(value).padStart(2, '0');

      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
    })();
    const bookingAt = (startTime: string, endTime: string) =>
      ({
        id: '900',
        status: 'CONFIRMED',
        slot: { slotDate: monday, startTime, endTime },
      }) as unknown as Booking;

    it('locks the provider row FOR UPDATE inside one transaction', async () => {
      await service.updateMyWorkingHour(ownerUserId, '5', { endTime: '18:00' });

      expect(dataSource.transaction).toHaveBeenCalledTimes(1);
      expect(providersRepository.findOne).toHaveBeenCalledWith({
        where: { id: provider.id },
        lock: { mode: 'pessimistic_write' },
      });
    });

    it('rejects shortening hours under an active booking with 409 and saves nothing', async () => {
      bookingsRepository.find.mockResolvedValue([bookingAt('16:00:00', '17:00:00')]);

      await expect(
        service.updateMyWorkingHour(ownerUserId, '5', { endTime: '16:30' }),
      ).rejects.toThrow(ConflictException);
      expect(workingHoursRepository.save).not.toHaveBeenCalled();
    });

    it.each([
      ['moving the entry to another weekday', { dayOfWeek: 2 }],
      ['deactivating via PATCH', { isActive: false }],
      ['starting later than the booking', { startTime: '10:00' }],
    ])('rejects %s when it strands an active booking', async (_case, dto) => {
      bookingsRepository.find.mockResolvedValue([bookingAt('09:00:00', '10:00:00')]);

      await expect(
        service.updateMyWorkingHour(ownerUserId, '5', dto),
      ).rejects.toThrow(
        'This working-hour change would leave 1 active booking(s) outside working hours',
      );
    });

    it('rejects DELETE (deactivate) when it strands an active booking', async () => {
      bookingsRepository.find.mockResolvedValue([bookingAt('09:00:00', '10:00:00')]);

      await expect(
        service.deactivateMyWorkingHour(ownerUserId, '5'),
      ).rejects.toThrow(ConflictException);
      expect(workingHoursRepository.save).not.toHaveBeenCalled();
    });

    it('allows a change when another active entry still covers the booking', async () => {
      workingHoursRepository.find.mockResolvedValue([
        persistedWorkingHour(),
        { ...persistedWorkingHour(), id: '6', startTime: '08:00:00', endTime: '12:00:00' },
      ]);
      bookingsRepository.find.mockResolvedValue([bookingAt('09:00:00', '10:00:00')]);

      await expect(
        service.deactivateMyWorkingHour(ownerUserId, '5'),
      ).resolves.toBeUndefined();
      expect(workingHoursRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({ id: '5', isActive: false }),
      );
    });

    it('allows changes that keep every active booking inside working hours', async () => {
      bookingsRepository.find.mockResolvedValue([bookingAt('10:00:00', '11:00:00')]);

      await expect(
        service.updateMyWorkingHour(ownerUserId, '5', { startTime: '10:00', endTime: '11:00' }),
      ).resolves.toMatchObject({ startTime: '10:00', endTime: '11:00' });
    });

    it('allows any change without active bookings (slots without bookings are not modified)', async () => {
      await expect(
        service.deactivateMyWorkingHour(ownerUserId, '5'),
      ).resolves.toBeUndefined();
    });

    it('ignores a booking that was already outside working hours before the change', async () => {
      bookingsRepository.find.mockResolvedValue([bookingAt('18:00:00', '19:00:00')]);

      await expect(
        service.updateMyWorkingHour(ownerUserId, '5', { endTime: '16:00' }),
      ).resolves.toBeDefined();
    });

    it('queries only PENDING_CONFIRMATION/CONFIRMED bookings dated today or later', async () => {
      await service.deactivateMyWorkingHour(ownerUserId, '5');

      const [{ where, relations }] = bookingsRepository.find.mock.calls[0] as [
        { where: Record<string, unknown>; relations: object },
      ];

      expect(where.providerId).toBe(provider.id);
      expect(JSON.stringify(where.status)).toContain('PENDING_CONFIRMATION');
      expect(JSON.stringify(where.status)).toContain('CONFIRMED');
      expect(JSON.stringify(where.slot)).toContain('moreThanOrEqual');
      expect(relations).toEqual({ slot: true });
    });

    it('skips the booking check when an inactive entry is edited', async () => {
      workingHoursRepository.findOne.mockResolvedValue({
        ...persistedWorkingHour(),
        isActive: false,
      });

      await service.updateMyWorkingHour(ownerUserId, '5', { endTime: '10:00' });

      expect(bookingsRepository.find).not.toHaveBeenCalled();
    });
  });
});
