import { ForbiddenException, Injectable } from '@nestjs/common';

import type { AuthenticatedUser } from '../interfaces/authenticated-user.interface';

@Injectable()
export class OwnershipService {
  assertCustomerOwns(
    user: AuthenticatedUser,
    ownerUserId: string,
  ): void {
    if (user.role !== 'CUSTOMER' || user.id !== ownerUserId) {
      throw new ForbiddenException(
        'You do not have permission to access this resource',
      );
    }
  }

  assertProviderOwnerOwns(
    user: AuthenticatedUser,
    providerOwnerUserId: string,
  ): void {
    if (
      user.role !== 'PROVIDER_OWNER' ||
      user.id !== providerOwnerUserId
    ) {
      throw new ForbiddenException(
        'You do not have permission to access this provider resource',
      );
    }
  }
}