import { IsIn, IsOptional, ValidateBy } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

import { PublicSearchQueryDto } from '../../common/dto/public-search-query.dto';
import { isPostgresBigIntId } from '../../common/pipes/parse-bigint-id.pipe';

export const PUBLIC_SERVICE_SORTS = [
  'newest',
  'name_asc',
  'name_desc',
  'price_asc',
  'price_desc',
  'rating_desc',
] as const;

export type PublicServiceSort = (typeof PUBLIC_SERVICE_SORTS)[number];

export class PublicServiceSearchQueryDto extends PublicSearchQueryDto {
  @ApiPropertyOptional({
    example: '3',
    description: 'Only services offered by this (APPROVED) provider.',
  })
  @IsOptional()
  @ValidateBy({
    name: 'isPostgresBigIntId',
    validator: {
      validate: (value: unknown) => isPostgresBigIntId(value),
      defaultMessage: () => 'providerId must be a valid positive integer ID',
    },
  })
  providerId?: string;

  @ApiPropertyOptional({
    enum: PUBLIC_SERVICE_SORTS,
    default: 'newest',
    description:
      'newest = most recently created first; name_* = case-insensitive service name; price_* = service price; rating_desc = provider average rating, then rating count. Ties are always broken by service ID, so ordering is deterministic across pages.',
  })
  @IsOptional()
  @IsIn(PUBLIC_SERVICE_SORTS)
  sort: PublicServiceSort = 'newest';
}
