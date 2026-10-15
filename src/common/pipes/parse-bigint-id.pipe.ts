import {
  BadRequestException,
  Injectable,
  PipeTransform,
} from '@nestjs/common';

const POSTGRES_BIGINT_MAX = 9223372036854775807n;

/**
 * Returns true when the value is a positive integer string that fits
 * in a PostgreSQL BIGINT column (TypeORM represents BIGINT as string).
 */
export function isPostgresBigIntId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[1-9]\d{0,18}$/.test(value) &&
    BigInt(value) <= POSTGRES_BIGINT_MAX
  );
}

/**
 * Validates a route parameter that maps to a PostgreSQL BIGINT primary key.
 *
 * - Accepts only positive integers within the BIGINT range.
 * - Returns the value as a string (TypeORM represents BIGINT as string).
 * - Rejects malformed IDs with 400 instead of letting PostgreSQL raise
 *   an "invalid input syntax for type bigint" error (500).
 */
@Injectable()
export class ParseBigIntIdPipe implements PipeTransform<string, string> {
  transform(value: string): string {
    if (!isPostgresBigIntId(value)) {
      throw new BadRequestException('id must be a valid positive integer ID');
    }

    return value;
  }
}
