import { ForbiddenException } from '@nestjs/common';

import type { Provider } from './entities/provider.entity';

type ProviderApprovalStatus = Provider['approvalStatus'];

/**
 * Provider lifecycle authorization matrix (C-02, P2-09A).
 *
 * | Status    | Read own data | Update profile | Manage services/slots/staff | Confirm bookings |
 * |-----------|---------------|----------------|-----------------------------|------------------|
 * | PENDING   | yes           | yes            | yes                         | no               |
 * | APPROVED  | yes           | yes            | yes                         | yes              |
 * | REJECTED  | yes           | yes            | no                          | no               |
 * | SUSPENDED | yes           | no             | no                          | no               |
 *
 * "Manage" covers create, update, activate/deactivate and soft-delete of
 * services, availability (slots and working hours) and staff. Reads are
 * never restricted by status. Checks run right after the caller's own
 * provider is loaded and before any resource lookup, so a blocked provider
 * learns nothing about other resources.
 *
 * Confirming a booking is a new commitment, so only an APPROVED provider
 * may do it. Winding down existing bookings (reject a pending one, complete
 * or mark no-show a confirmed one) stays allowed in every status, as does
 * customer cancellation. That check runs after the booking's ownership
 * check, against the provider row locked by the confirming transaction.
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

export function assertProviderCanConfirmBookings(
  provider: Pick<Provider, 'approvalStatus'>,
): void {
  if (provider.approvalStatus !== 'APPROVED') {
    throw new ForbiddenException(
      `A ${provider.approvalStatus} provider cannot confirm bookings`,
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
