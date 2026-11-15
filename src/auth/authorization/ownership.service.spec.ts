import { ForbiddenException, NotFoundException } from '@nestjs/common';

import type { AuthenticatedUser } from '../interfaces/authenticated-user.interface';
import { OwnershipService } from './ownership.service';

const user = (id: string, role: AuthenticatedUser['role']) =>
  ({ id, role }) as AuthenticatedUser;

describe('OwnershipService (C-01)', () => {
  const ownership = new OwnershipService();

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
});
