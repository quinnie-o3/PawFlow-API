import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';

import { ProviderStaff } from '../../providers/entities/provider-staff.entity';
import { Provider } from '../../providers/entities/provider.entity';
import type { AuthenticatedUser } from '../interfaces/authenticated-user.interface';

export const PROVIDER_PROFILE_NOT_FOUND = 'Provider profile not found';
export const STAFF_ASSOCIATION_REQUIRED =
  'Active provider staff association is required';
export const PROVIDER_RESOURCE_FORBIDDEN =
  'You do not have permission to access this provider resource';

/**
 * Ownership checks following the C-01 error policy:
 * - wrong role -> 403 (authorization failure);
 * - right role but another user's resource -> 404 with the same message the
 *   caller uses for a missing resource, so existence is not disclosed.
 *
 * It is also the single place that resolves which provider the current user
 * acts for. Every provider-scoped service must go through
 * `getOwnedProvider` / `getManagedProviderId` instead of querying
 * `providers` / `provider_staff` itself, so the rule is written and tested once.
 * Pass the transaction's `manager` when calling from inside a transaction.
 */
@Injectable()
export class OwnershipService {
  constructor(private readonly dataSource: DataSource) {}

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
      throw new ForbiddenException(PROVIDER_RESOURCE_FORBIDDEN);
    }

    if (user.id !== providerOwnerUserId) {
      throw new NotFoundException(notFoundMessage);
    }
  }

  /**
   * The provider owned by `ownerUserId` (owner-only operations).
   * 404 when the user owns no provider profile.
   */
  async getOwnedProvider(
    ownerUserId: string,
    manager: EntityManager = this.dataSource.manager,
  ): Promise<Provider> {
    const provider = await manager.getRepository(Provider).findOne({
      where: { ownerId: ownerUserId },
    });

    if (!provider) {
      throw new NotFoundException(PROVIDER_PROFILE_NOT_FOUND);
    }

    return provider;
  }

  /**
   * The provider the user manages (owner or staff operations):
   * - PROVIDER_OWNER -> the provider they own (404 if none);
   * - PROVIDER_STAFF -> the provider of their ACTIVE staff row (403 if none);
   * - any other role -> 403 (unreachable behind RolesGuard; kept so callers
   *   are safe on their own).
   */
  async getManagedProviderId(
    user: AuthenticatedUser,
    manager: EntityManager = this.dataSource.manager,
  ): Promise<string> {
    if (user.role === 'PROVIDER_OWNER') {
      const provider = await this.getOwnedProvider(user.id, manager);
      return provider.id;
    }

    if (user.role === 'PROVIDER_STAFF') {
      const staff = await manager.getRepository(ProviderStaff).findOne({
        where: { userId: user.id, status: 'ACTIVE' },
      });

      if (!staff) {
        throw new ForbiddenException(STAFF_ASSOCIATION_REQUIRED);
      }

      return staff.providerId;
    }

    throw new ForbiddenException(PROVIDER_RESOURCE_FORBIDDEN);
  }
}
