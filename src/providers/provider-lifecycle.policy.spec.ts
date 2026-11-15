import { ForbiddenException } from '@nestjs/common';
import type { DataSource, Repository } from 'typeorm';

import { AvailabilityService } from '../availability/availability.service';
import { AvailabilitySlot } from '../availability/entities/availability-slot.entity';
import { ServiceCategory } from '../services/entities/service-category.entity';
import { Service } from '../services/entities/service.entity';
import { ServicesService } from '../services/services.service';
import { ProviderStaff } from './entities/provider-staff.entity';
import { ProviderWorkingHour } from './entities/provider-working-hour.entity';
import { Provider } from './entities/provider.entity';
import {
  assertProviderCanManageResources,
  assertProviderCanUpdateProfile,
} from './provider-lifecycle.policy';
import { ProvidersService } from './providers.service';

type Status = Provider['approvalStatus'];

describe('Provider lifecycle policy (C-02)', () => {
  describe('authorization matrix', () => {
    it.each([
      ['PENDING', true, true],
      ['APPROVED', true, true],
      ['REJECTED', true, false],
      ['SUSPENDED', false, false],
    ] as Array<[Status, boolean, boolean]>)(
      '%s: update profile=%s, manage resources=%s',
      (approvalStatus, canUpdateProfile, canManage) => {
        const provider = { approvalStatus };
        const profile = () => assertProviderCanUpdateProfile(provider);
        const manage = () => assertProviderCanManageResources(provider);

        if (canUpdateProfile) {
          expect(profile).not.toThrow();
        } else {
          expect(profile).toThrow(ForbiddenException);
        }

        if (canManage) {
          expect(manage).not.toThrow();
        } else {
          expect(manage).toThrow(
            new ForbiddenException(
              `A ${approvalStatus} provider cannot manage services, availability or staff`,
            ),
          );
        }
      },
    );
  });

  describe.each(['REJECTED', 'SUSPENDED'] as Status[])(
    'a %s provider is blocked before any resource lookup',
    (approvalStatus) => {
      const ownerUserId = '10';
      const provider = { id: '1', ownerId: ownerUserId, approvalStatus } as Provider;

      it('services: create, update and deactivate', async () => {
        const servicesRepository = { findOne: jest.fn(), save: jest.fn() };
        const categoriesRepository = { findOne: jest.fn() };
        const service = new ServicesService(
          servicesRepository as unknown as Repository<Service>,
          categoriesRepository as unknown as Repository<ServiceCategory>,
          { findOne: jest.fn().mockResolvedValue(provider) } as unknown as Repository<Provider>,
        );

        await expect(
          service.createMyService(ownerUserId, {
            categoryId: '1',
            name: 'Bath',
            price: 10,
            durationMinutes: 30,
          }),
        ).rejects.toBeInstanceOf(ForbiddenException);
        await expect(
          service.updateMyService(ownerUserId, '5', { name: 'X' }),
        ).rejects.toBeInstanceOf(ForbiddenException);
        await expect(
          service.deactivateMyService(ownerUserId, '5'),
        ).rejects.toBeInstanceOf(ForbiddenException);

        expect(servicesRepository.findOne).not.toHaveBeenCalled();
        expect(categoriesRepository.findOne).not.toHaveBeenCalled();
        expect(servicesRepository.save).not.toHaveBeenCalled();
      });

      it('services: reads stay allowed', async () => {
        const servicesRepository = { find: jest.fn().mockResolvedValue([]) };
        const service = new ServicesService(
          servicesRepository as unknown as Repository<Service>,
          {} as Repository<ServiceCategory>,
          { findOne: jest.fn().mockResolvedValue(provider) } as unknown as Repository<Provider>,
        );

        await expect(service.getMyServices(ownerUserId)).resolves.toEqual([]);
      });

      it('availability: create, update and deactivate', async () => {
        const slotsRepository = {
          createQueryBuilder: jest.fn(),
          save: jest.fn(),
          manager: { transaction: jest.fn() },
        };
        const servicesRepository = { findOne: jest.fn() };
        const availability = new AvailabilityService(
          slotsRepository as unknown as Repository<AvailabilitySlot>,
          { findOne: jest.fn().mockResolvedValue(provider) } as unknown as Repository<Provider>,
          servicesRepository as unknown as Repository<Service>,
        );

        await expect(
          availability.createMySlot(ownerUserId, {
            serviceId: '5',
            slotDate: '2099-01-01',
            startTime: '09:00',
            endTime: '10:00',
            capacity: 1,
          }),
        ).rejects.toBeInstanceOf(ForbiddenException);
        await expect(
          availability.updateMySlot(ownerUserId, '7', { capacity: 2 }),
        ).rejects.toBeInstanceOf(ForbiddenException);
        await expect(
          availability.deactivateMySlot(ownerUserId, '7'),
        ).rejects.toBeInstanceOf(ForbiddenException);

        expect(servicesRepository.findOne).not.toHaveBeenCalled();
        expect(slotsRepository.manager.transaction).not.toHaveBeenCalled();
        expect(slotsRepository.save).not.toHaveBeenCalled();
      });

      it('working hours: create, update and deactivate', async () => {
        const workingHoursRepository = { findOne: jest.fn(), save: jest.fn() };
        const providers = new ProvidersService(
          { findOne: jest.fn().mockResolvedValue(provider) } as unknown as Repository<Provider>,
          {} as Repository<ProviderStaff>,
          workingHoursRepository as unknown as Repository<ProviderWorkingHour>,
          {} as DataSource,
        );

        await expect(
          providers.createMyWorkingHour(ownerUserId, {
            dayOfWeek: 1,
            startTime: '09:00',
            endTime: '17:00',
          }),
        ).rejects.toBeInstanceOf(ForbiddenException);
        await expect(
          providers.updateMyWorkingHour(ownerUserId, '3', { isActive: false }),
        ).rejects.toBeInstanceOf(ForbiddenException);
        await expect(
          providers.deactivateMyWorkingHour(ownerUserId, '3'),
        ).rejects.toBeInstanceOf(ForbiddenException);

        expect(workingHoursRepository.findOne).not.toHaveBeenCalled();
        expect(workingHoursRepository.save).not.toHaveBeenCalled();
      });
    },
  );

  describe('profile update', () => {
    const makeService = (approvalStatus: Status) => {
      const provider = { id: '1', ownerId: '10', approvalStatus } as Provider;
      const providersRepository = {
        findOne: jest.fn().mockResolvedValue(provider),
        save: jest.fn((value: Provider) => Promise.resolve(value)),
      };

      return {
        providersRepository,
        service: new ProvidersService(
          providersRepository as unknown as Repository<Provider>,
          {} as Repository<ProviderStaff>,
          {} as Repository<ProviderWorkingHour>,
          {} as DataSource,
        ),
      };
    };

    it.each(['PENDING', 'APPROVED', 'REJECTED'] as Status[])(
      'allows a %s provider to update its profile without changing approval status',
      async (approvalStatus) => {
        const { service } = makeService(approvalStatus);

        await expect(
          service.updateMyProvider('10', { businessName: 'New Name' }),
        ).resolves.toMatchObject({ businessName: 'New Name', approvalStatus });
      },
    );

    it('blocks a SUSPENDED provider from updating its profile', async () => {
      const { service, providersRepository } = makeService('SUSPENDED');

      await expect(
        service.updateMyProvider('10', { businessName: 'New Name' }),
      ).rejects.toThrow(
        new ForbiddenException('A SUSPENDED provider cannot update its profile'),
      );
      expect(providersRepository.save).not.toHaveBeenCalled();
    });

    it.each(['PENDING', 'APPROVED', 'REJECTED', 'SUSPENDED'] as Status[])(
      'lets a %s provider read its own profile',
      async (approvalStatus) => {
        const { service } = makeService(approvalStatus);

        await expect(service.getMyProvider('10')).resolves.toMatchObject({
          approvalStatus,
        });
      },
    );
  });
});
