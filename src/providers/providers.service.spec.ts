import { BadRequestException } from '@nestjs/common';
import type { DataSource, Repository } from 'typeorm';

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
    create: jest.Mock;
    save: jest.Mock;
  };
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
      create: jest.fn((value: Partial<ProviderWorkingHour>) => value),
      save: jest.fn((value: ProviderWorkingHour) => Promise.resolve(value)),
    };

    service = new ProvidersService(
      providersRepository as unknown as Repository<Provider>,
      {} as Repository<ProviderStaff>,
      workingHoursRepository as unknown as Repository<ProviderWorkingHour>,
      {} as DataSource,
    );
  });

  describe('createMyWorkingHour', () => {
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
});
