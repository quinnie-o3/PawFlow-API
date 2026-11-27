import { ForbiddenException, NotFoundException } from '@nestjs/common';

import { createOwnershipService } from '../../../test/helpers/ownership-service';
import type { AuthenticatedUser } from '../interfaces/authenticated-user.interface';
import {
  PROVIDER_PROFILE_NOT_FOUND,
  PROVIDER_RESOURCE_FORBIDDEN,
  STAFF_ASSOCIATION_REQUIRED,
} from './ownership.service';

const user = (id: string, role: AuthenticatedUser['role']) =>
  ({ id, role }) as AuthenticatedUser;

describe('OwnershipService (C-01)', () => {
  const ownership = createOwnershipService();

  describe('assertCustomerOwns', () => {
    it('allows the owning customer', () => {
      expect(() =>
        ownership.assertCustomerOwns(user('10', 'CUSTOMER'), '10'),
      ).not.toThrow();
    });

    it('returns 404 with the caller-supplied message for another customer', () => {
      expect(() =>
        ownership.assertCustomerOwns(user('11', 'CUSTOMER'), '10', 'Pet not found'),
      ).toThrow(new NotFoundException('Pet not found'));
    });

    it('keeps 403 for a wrong role', () => {
      expect(() =>
        ownership.assertCustomerOwns(user('10', 'PROVIDER_OWNER'), '10'),
      ).toThrow(ForbiddenException);
    });
  });

  describe('assertProviderOwnerOwns', () => {
    it('allows the owning provider owner', () => {
      expect(() =>
        ownership.assertProviderOwnerOwns(user('20', 'PROVIDER_OWNER'), '20'),
      ).not.toThrow();
    });

    it('returns 404 for another provider owner', () => {
      expect(() =>
        ownership.assertProviderOwnerOwns(user('21', 'PROVIDER_OWNER'), '20'),
      ).toThrow(NotFoundException);
    });

    it('keeps 403 for a wrong role', () => {
      expect(() =>
        ownership.assertProviderOwnerOwns(user('20', 'CUSTOMER'), '20'),
      ).toThrow(ForbiddenException);
    });
  });

  describe('getOwnedProvider', () => {
    it('returns the provider owned by the user', async () => {
      const findOne = jest.fn().mockResolvedValue({ id: '1', ownerId: '20' });
      const service = createOwnershipService({ provider: { findOne } });

      await expect(service.getOwnedProvider('20')).resolves.toEqual({ id: '1', ownerId: '20' });
      expect(findOne).toHaveBeenCalledWith({ where: { ownerId: '20' } });
    });

    it('returns 404 when the user owns no provider', async () => {
      await expect(createOwnershipService().getOwnedProvider('20')).rejects.toThrow(
        new NotFoundException(PROVIDER_PROFILE_NOT_FOUND),
      );
    });

    it('uses the given transaction manager instead of the default one', async () => {
      const findOne = jest.fn().mockResolvedValue({ id: '1' });
      const manager = { getRepository: () => ({ findOne }) };

      await createOwnershipService().getOwnedProvider('20', manager as never);
      expect(findOne).toHaveBeenCalledTimes(1);
    });
  });

  describe('getManagedProviderId', () => {
    const provider = { findOne: jest.fn().mockResolvedValue({ id: '1' }) };
    const staff = { findOne: jest.fn().mockResolvedValue({ providerId: '5' }) };

    beforeEach(() => jest.clearAllMocks());

    it('owner: the provider they own', async () => {
      await expect(
        createOwnershipService({ provider, staff }).getManagedProviderId(user('20', 'PROVIDER_OWNER')),
      ).resolves.toBe('1');
      expect(staff.findOne).not.toHaveBeenCalled();
    });

    it('owner without a provider: 404', async () => {
      await expect(
        createOwnershipService({ staff }).getManagedProviderId(user('20', 'PROVIDER_OWNER')),
      ).rejects.toThrow(new NotFoundException(PROVIDER_PROFILE_NOT_FOUND));
    });

    it('staff: the provider of their ACTIVE staff row only', async () => {
      await expect(
        createOwnershipService({ provider, staff }).getManagedProviderId(user('30', 'PROVIDER_STAFF')),
      ).resolves.toBe('5');
      expect(staff.findOne).toHaveBeenCalledWith({ where: { userId: '30', status: 'ACTIVE' } });
      expect(provider.findOne).not.toHaveBeenCalled();
    });

    it('staff without an active association: 403', async () => {
      await expect(
        createOwnershipService({ provider }).getManagedProviderId(user('30', 'PROVIDER_STAFF')),
      ).rejects.toThrow(new ForbiddenException(STAFF_ASSOCIATION_REQUIRED));
    });

    it.each(['CUSTOMER', 'ADMIN'] as const)('%s: 403 without touching the database', async (role) => {
      await expect(
        createOwnershipService({ provider, staff }).getManagedProviderId(user('20', role)),
      ).rejects.toThrow(new ForbiddenException(PROVIDER_RESOURCE_FORBIDDEN));
      expect(provider.findOne).not.toHaveBeenCalled();
      expect(staff.findOne).not.toHaveBeenCalled();
    });
  });
});
