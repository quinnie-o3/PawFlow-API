import { Transform } from 'class-transformer';
import {
  IsInt,
  IsOptional,
  Max,
  Min,
  ValidateBy,
  ValidateIf,
  type ValidationArguments,
} from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

import { isPostgresBigIntId } from '../../common/pipes/parse-bigint-id.pipe';
import { IsCalendarDate } from '../../common/utils/calendar-date.util';
import {
  SEARCH_DEFAULT_LIMIT,
  SEARCH_MAX_LIMIT,
  SEARCH_MAX_PAGE,
} from '../../common/utils/public-search.util';
import { toNumberIfNumericString } from '../../common/utils/strict-input.util';

/** Normalized filters echoed back so clients can sync URLs and drop stale responses. */
export interface PublicAvailabilitySearchEcho {
  providerId: string | null;
  serviceId: string | null;
  date: string | null;
  fromDate: string | null;
  toDate: string | null;
}

const SCOPE_REQUIRED_MESSAGE = 'providerId or serviceId must be provided';

/**
 * Validates an optional BIGINT scope ID. When neither `providerId` nor
 * `serviceId` is given, `providerId` is validated as missing so that an
 * unscoped availability scan is rejected with 400.
 */
function IsScopeId(property: 'providerId' | 'serviceId') {
  return ValidateBy({
    name: 'isScopeId',
    validator: {
      validate: (value: unknown) => isPostgresBigIntId(value),
      defaultMessage: (args?: ValidationArguments) =>
        args?.value === undefined
          ? SCOPE_REQUIRED_MESSAGE
          : `${property} must be a valid positive integer ID`,
    },
  });
}

const query = (args?: ValidationArguments) =>
  (args?.object ?? {}) as PublicAvailabilitySearchQueryDto;

/**
 * Query parameters for `GET /availability/public/search`.
 *
 * At least one of `providerId` / `serviceId` is required. `date` selects a
 * single day and cannot be combined with `fromDate` / `toDate`; all dates are
 * strict calendar dates (`YYYY-MM-DD`). Unknown parameters fail with 400
 * under the global strict ValidationPipe.
 */
export class PublicAvailabilitySearchQueryDto {
  @ApiPropertyOptional({
    example: '3',
    description:
      'Only slots of this (APPROVED) provider. At least one of providerId or serviceId is required.',
  })
  @ValidateIf(
    (dto: PublicAvailabilitySearchQueryDto) =>
      dto.providerId !== undefined || dto.serviceId === undefined,
  )
  @IsScopeId('providerId')
  providerId?: string;

  @ApiPropertyOptional({
    example: '5',
    description:
      'Only slots of this (ACTIVE) service. When combined with providerId, the service must belong to that provider, otherwise the result is empty.',
  })
  @IsOptional()
  @IsScopeId('serviceId')
  serviceId?: string;

  @ApiPropertyOptional({
    example: '2026-12-01',
    format: 'date',
    description:
      'Exact slot date (YYYY-MM-DD). Cannot be combined with fromDate or toDate.',
  })
  @IsOptional()
  @IsCalendarDate()
  @ValidateBy({
    name: 'isExclusiveDateFilter',
    validator: {
      validate: (_value: unknown, args?: ValidationArguments) =>
        query(args).fromDate === undefined && query(args).toDate === undefined,
      defaultMessage: () => 'date cannot be combined with fromDate or toDate',
    },
  })
  date?: string;

  @ApiPropertyOptional({
    example: '2026-12-01',
    format: 'date',
    description: 'Inclusive lower bound on slot date (YYYY-MM-DD).',
  })
  @IsOptional()
  @IsCalendarDate()
  fromDate?: string;

  @ApiPropertyOptional({
    example: '2026-12-07',
    format: 'date',
    description:
      'Inclusive upper bound on slot date (YYYY-MM-DD). Must not be before fromDate.',
  })
  @IsOptional()
  @IsCalendarDate()
  @ValidateBy({
    name: 'isNotBeforeFromDate',
    validator: {
      validate: (value: unknown, args?: ValidationArguments) => {
        const fromDate = query(args).fromDate;

        // Strict YYYY-MM-DD strings compare chronologically.
        return (
          typeof fromDate !== 'string' ||
          typeof value !== 'string' ||
          value >= fromDate
        );
      },
      defaultMessage: () =>
        'toDate must be the same as or later than fromDate',
    },
  })
  toDate?: string;

  @ApiPropertyOptional({
    default: 1,
    minimum: 1,
    maximum: SEARCH_MAX_PAGE,
    description: '1-based page number.',
  })
  @IsOptional()
  @Transform(({ value }) => toNumberIfNumericString(value))
  @IsInt()
  @Min(1)
  @Max(SEARCH_MAX_PAGE)
  page: number = 1;

  @ApiPropertyOptional({
    default: SEARCH_DEFAULT_LIMIT,
    minimum: 1,
    maximum: SEARCH_MAX_LIMIT,
    description: 'Page size.',
  })
  @IsOptional()
  @Transform(({ value }) => toNumberIfNumericString(value))
  @IsInt()
  @Min(1)
  @Max(SEARCH_MAX_LIMIT)
  limit: number = SEARCH_DEFAULT_LIMIT;
}
