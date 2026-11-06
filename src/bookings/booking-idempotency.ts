import {
  BadRequestException,
  createParamDecorator,
  type ExecutionContext,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { Request } from 'express';

import type { CreateBookingDto } from './dto/create-booking.dto';

/**
 * P2-07 booking idempotency contract.
 *
 * - `Idempotency-Key` is optional on `POST /bookings`. Without it the
 *   endpoint behaves exactly as before (every request is a new attempt).
 * - The key is scoped to the authenticated customer and the booking-create
 *   operation; other customers may use the same key independently.
 * - Keys are compared exactly (case-sensitive, no trimming beyond what HTTP
 *   itself strips), so a client must resend the identical string.
 * - Format: 16-128 characters from `A-Z a-z 0-9 - _`, which covers UUIDs,
 *   ULIDs and nanoids. The database enforces the same rule.
 */
export const IDEMPOTENCY_KEY_HEADER = 'Idempotency-Key';

/** Response header: `true` when the booking was returned from a stored key. */
export const IDEMPOTENT_REPLAYED_HEADER = 'Idempotent-Replayed';

export const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;

export const IDEMPOTENCY_KEY_FORMAT_MESSAGE =
  'Idempotency-Key must be 16-128 characters long and contain only letters, digits, "-" or "_" (for example a UUID)';

/**
 * Returns the validated key, or `undefined` when the header is absent.
 * Repeated headers arrive joined with ", " and are therefore rejected.
 */
export function parseIdempotencyKey(
  value: string | string[] | undefined,
): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== 'string' || !IDEMPOTENCY_KEY_PATTERN.test(value)) {
    throw new BadRequestException(IDEMPOTENCY_KEY_FORMAT_MESSAGE);
  }

  return value;
}

export const IdempotencyKey = createParamDecorator(
  (_data: unknown, context: ExecutionContext): string | undefined => {
    const request = context.switchToHttp().getRequest<Request>();
    return parseIdempotencyKey(request.headers['idempotency-key']);
  },
);

/**
 * SHA-256 of the booking request after DTO validation, so equivalent
 * payloads (`3` vs `"3"`, padded or empty notes) share a fingerprint.
 * The operation name is part of the input to keep fingerprints of other
 * operations from ever colliding with booking creation.
 */
export function fingerprintCreateBookingRequest(
  dto: CreateBookingDto,
): string {
  const normalized = JSON.stringify([
    'POST /bookings',
    dto.petId,
    dto.slotId,
    dto.customerNote ?? null,
  ]);

  return createHash('sha256').update(normalized).digest('hex');
}
