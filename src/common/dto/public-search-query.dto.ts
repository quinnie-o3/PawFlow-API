import { Transform } from 'class-transformer';
import {
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateBy,
  type ValidationArguments,
} from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

import { isPostgresBigIntId } from '../pipes/parse-bigint-id.pipe';
import {
  SEARCH_DEFAULT_LIMIT,
  SEARCH_KEYWORD_MAX_LENGTH,
  SEARCH_KEYWORD_MAX_TERMS,
  SEARCH_LOCATION_MAX_LENGTH,
  SEARCH_MAX_LIMIT,
  SEARCH_MAX_PAGE,
  tokenizeSearchKeyword,
  toTrimmedOptionalString,
} from '../utils/public-search.util';
import { toNumberIfNumericString } from '../utils/strict-input.util';

const MAX_PRICE = 9999999999.99;

/**
 * PostgreSQL text values cannot contain NUL; without this check such input
 * would reach the driver and fail with HTTP 500 instead of 400.
 */
function HasNoNulCharacter(property: string) {
  return ValidateBy({
    name: 'hasNoNulCharacter',
    validator: {
      validate: (value: unknown) =>
        typeof value === 'string' && !value.includes('\u0000'),
      defaultMessage: () => `${property} must not contain NUL characters`,
    },
  });
}

/**
 * Query parameters shared by the public discovery endpoints.
 *
 * Every value arrives as a query string; numeric values are converted only
 * from canonical decimal strings (see `toNumberIfNumericString`), so values
 * such as `abc`, `1e3`, repeated parameters or unknown parameters fail with
 * HTTP 400 under the global strict ValidationPipe.
 */
export class PublicSearchQueryDto {
  @ApiPropertyOptional({
    example: 'grooming',
    maxLength: SEARCH_KEYWORD_MAX_LENGTH,
    description: `Case-insensitive keyword. Split on whitespace into at most ${SEARCH_KEYWORD_MAX_TERMS} terms; every term must match at least one searchable field. A blank value is ignored.`,
  })
  @IsOptional()
  @Transform(({ value }) => toTrimmedOptionalString(value))
  @IsString()
  @MaxLength(SEARCH_KEYWORD_MAX_LENGTH)
  @HasNoNulCharacter('q')
  @ValidateBy({
    name: 'maxSearchTerms',
    validator: {
      validate: (value: unknown) =>
        typeof value === 'string' &&
        tokenizeSearchKeyword(value).length <= SEARCH_KEYWORD_MAX_TERMS,
      defaultMessage: () =>
        `q must contain at most ${SEARCH_KEYWORD_MAX_TERMS} words`,
    },
  })
  q?: string;

  @ApiPropertyOptional({
    example: '1',
    description: 'Only services in this (ACTIVE) service category.',
  })
  @IsOptional()
  @ValidateBy({
    name: 'isPostgresBigIntId',
    validator: {
      validate: (value: unknown) => isPostgresBigIntId(value),
      defaultMessage: () => 'categoryId must be a valid positive integer ID',
    },
  })
  categoryId?: string;

  @ApiPropertyOptional({
    example: 100000,
    minimum: 0,
    description: 'Inclusive lower bound on service price.',
  })
  @IsOptional()
  @Transform(({ value }) => toNumberIfNumericString(value))
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(MAX_PRICE)
  minPrice?: number;

  @ApiPropertyOptional({
    example: 300000,
    minimum: 0,
    description:
      'Inclusive upper bound on service price. Must be >= minPrice when both are given.',
  })
  @IsOptional()
  @Transform(({ value }) => toNumberIfNumericString(value))
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(MAX_PRICE)
  @ValidateBy({
    name: 'isNotBelowMinPrice',
    validator: {
      validate: (value: unknown, args?: ValidationArguments) => {
        const minPrice = (args?.object as PublicSearchQueryDto | undefined)
          ?.minPrice;

        return (
          typeof minPrice !== 'number' ||
          typeof value !== 'number' ||
          value >= minPrice
        );
      },
      defaultMessage: () =>
        'maxPrice must be greater than or equal to minPrice',
    },
  })
  maxPrice?: number;

  @ApiPropertyOptional({
    example: 4,
    minimum: 0,
    maximum: 5,
    description: "Inclusive lower bound on the provider's average rating.",
  })
  @IsOptional()
  @Transform(({ value }) => toNumberIfNumericString(value))
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(5)
  minRating?: number;

  @ApiPropertyOptional({
    example: 'District 1',
    maxLength: SEARCH_LOCATION_MAX_LENGTH,
    description:
      "Case-insensitive substring of the provider's address (the schema stores a free-text address only). A blank value is ignored.",
  })
  @IsOptional()
  @Transform(({ value }) => toTrimmedOptionalString(value))
  @IsString()
  @MaxLength(SEARCH_LOCATION_MAX_LENGTH)
  @HasNoNulCharacter('location')
  location?: string;

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
