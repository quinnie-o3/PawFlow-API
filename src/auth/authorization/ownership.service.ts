import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import type { AuthenticatedUser } from '../interfaces/authenticated-user.interface';

/**
 * Ownership checks following the C-01 error policy:
 * - wrong role -> 403 (authorization failure);
 * - right role but another user's resource -> 404 with the same message the
 *   caller uses for a missing resource, so existence is not disclosed.
 */
@Injectable()
export class OwnershipService {
  assertCustomerOwns(
    user: AuthenticatedUser,
    ownerUserId: string,
    notFoundMessage = 'Resource not found',
  ): void {
    if (user.role !== 'CUSTOMER') {
      throw new ForbiddenException(
        'You do not have permission to access this resource',
      );
    }

    if (user.id !== ownerUserId) {
      throw new NotFoundException(notFoundMessage);
    }
  }

  assertProviderOwnerOwns(
    user: AuthenticatedUser,
    providerOwnerUserId: string,
    notFoundMessage = 'Resource not found',
  ): void {
    if (user.role !== 'PROVIDER_OWNER') {
      throw new ForbiddenException(
        'You do not have permission to access this provider resource',
      );
    }

    if (user.id !== providerOwnerUserId) {
      throw new NotFoundException(notFoundMessage);
    }
  }
}
