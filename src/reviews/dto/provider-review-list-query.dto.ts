import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsIn, IsInt, IsOptional, Max, Min, ValidateBy } from 'class-validator';

import { isPostgresBigIntId } from '../../common/pipes/parse-bigint-id.pipe';
import {
  SEARCH_DEFAULT_LIMIT,
  SEARCH_MAX_LIMIT,
  SEARCH_MAX_PAGE,
} from '../../common/utils/public-search.util';
import { toNumberIfNumericString } from '../../common/utils/strict-input.util';

export const PROVIDER_REVIEW_VISIBILITY_FILTERS = ['all', 'visible', 'hidden'] as const;
export const PROVIDER_REVIEW_RESPONDED_FILTERS = ['all', 'responded', 'unresponded'] as const;
export const PROVIDER_REVIEW_SORTS = ['newest', 'oldest', 'rating_desc', 'rating_asc'] as const;

export type ProviderReviewVisibilityFilter = (typeof PROVIDER_REVIEW_VISIBILITY_FILTERS)[number];
export type ProviderReviewRespondedFilter = (typeof PROVIDER_REVIEW_RESPONDED_FILTERS)[number];
export type ProviderReviewSort = (typeof PROVIDER_REVIEW_SORTS)[number];

/**
 * Query of `GET /providers/me/reviews` (P3-BE08).
 *
 * Same paging contract as the notification inbox: `page`/`limit` plus the
 * `maxId` snapshot anchor. `maxId` is a set filter (`reviews.id <= maxId`),
 * not a cursor, so it is valid with every sort: it freezes which reviews
 * exist, and every sort key (`created_at`, `rating`, `id`) is immutable, so
 * the order of that frozen set cannot change between pages.
 */
export class ProviderReviewListQueryDto {
  @ApiPropertyOptional({ default: 1, minimum: 1, maximum: SEARCH_MAX_PAGE, description: '1-based page number.' })
  @IsOptional()
  @Transform(({ value }) => toNumberIfNumericString(value))
  @IsInt()
  @Min(1)
  @Max(SEARCH_MAX_PAGE)
  page: number = 1;

  @ApiPropertyOptional({ default: SEARCH_DEFAULT_LIMIT, minimum: 1, maximum: SEARCH_MAX_LIMIT, description: 'Page size.' })
  @IsOptional()
  @Transform(({ value }) => toNumberIfNumericString(value))
  @IsInt()
  @Min(1)
  @Max(SEARCH_MAX_LIMIT)
  limit: number = SEARCH_DEFAULT_LIMIT;

  @ApiPropertyOptional({
    type: String,
    example: '128',
    description:
      'Snapshot anchor: only reviews with id <= maxId. Omit on the first page and pass back `query.maxId` from that ' +
      'response for the following pages, so reviews created meanwhile do not shift them.',
  })
  @IsOptional()
  @ValidateBy({
    name: 'isBigIntId',
    validator: {
      validate: (value: unknown) => isPostgresBigIntId(value),
      defaultMessage: () => 'maxId must be a valid positive integer ID',
    },
  })
  maxId?: string;

  @ApiPropertyOptional({ minimum: 1, maximum: 5, description: 'Only reviews with exactly this rating.' })
  @IsOptional()
  @Transform(({ value }) => toNumberIfNumericString(value))
  @IsInt()
  @Min(1)
  @Max(5)
  rating?: number;

  @ApiPropertyOptional({ enum: PROVIDER_REVIEW_VISIBILITY_FILTERS, default: 'all', description: 'Moderation visibility filter.' })
  @IsOptional()
  @IsIn(PROVIDER_REVIEW_VISIBILITY_FILTERS)
  visibility: ProviderReviewVisibilityFilter = 'all';

  @ApiPropertyOptional({ enum: PROVIDER_REVIEW_RESPONDED_FILTERS, default: 'all', description: 'Provider-response filter.' })
  @IsOptional()
  @IsIn(PROVIDER_REVIEW_RESPONDED_FILTERS)
  responded: ProviderReviewRespondedFilter = 'all';

  @ApiPropertyOptional({
    enum: PROVIDER_REVIEW_SORTS,
    default: 'newest',
    description:
      'newest/oldest: by creation time; rating_desc/rating_asc: by rating, then newest first. ' +
      'Ties are always broken by review id (in the direction of the primary order; descending for rating sorts).',
  })
  @IsOptional()
  @IsIn(PROVIDER_REVIEW_SORTS)
  sort: ProviderReviewSort = 'newest';
}
