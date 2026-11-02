import { ForbiddenException } from '@nestjs/common';

import type { Provider } from './entities/provider.entity';

type ProviderApprovalStatus = Provider['approvalStatus'];

/**
 * Provider lifecycle authorization matrix (C-02).
 *
 * | Status    | Read own data | Update profile | Manage services/slots/staff |
 * |-----------|---------------|----------------|-----------------------------|
 * | PENDING   | yes           | yes            | yes                         |
 * | APPROVED  | yes           | yes            | yes                         |
 * | REJECTED  | yes           | yes            | no                          |
 * | SUSPENDED | yes           | no             | no                          |
 *
 * "Manage" covers create, update, activate/deactivate and soft-delete of
 * services, availability (slots and working hours) and staff. Reads are
 * never restricted by status. Checks run right after the caller's own
 * provider is loaded and before any resource lookup, so a blocked provider
 * learns nothing about other resources.
 */
const CAN_UPDATE_PROFILE: ReadonlySet<ProviderApprovalStatus> = new Set([
  'PENDING',
  'APPROVED',
  'REJECTED',
]);

const CAN_MANAGE_RESOURCES: ReadonlySet<ProviderApprovalStatus> = new Set([
  'PENDING',
  'APPROVED',
]);

export function assertProviderCanUpdateProfile(
  provider: Pick<Provider, 'approvalStatus'>,
): void {
  if (!CAN_UPDATE_PROFILE.has(provider.approvalStatus)) {
    throw new ForbiddenException(
      `A ${provider.approvalStatus} provider cannot update its profile`,
    );
  }
}

export function assertProviderCanManageResources(
  provider: Pick<Provider, 'approvalStatus'>,
): void {
  if (!CAN_MANAGE_RESOURCES.has(provider.approvalStatus)) {
    throw new ForbiddenException(
      `A ${provider.approvalStatus} provider cannot manage services, availability or staff`,
    );
  }
}
