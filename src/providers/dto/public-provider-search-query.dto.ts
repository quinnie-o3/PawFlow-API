import { IsIn, IsOptional } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

import { PublicSearchQueryDto } from '../../common/dto/public-search-query.dto';

export const PUBLIC_PROVIDER_SORTS = [
  'newest',
  'name_asc',
  'name_desc',
  'rating_desc',
  'price_asc',
  'price_desc',
] as const;

export type PublicProviderSort = (typeof PUBLIC_PROVIDER_SORTS)[number];

export class PublicProviderSearchQueryDto extends PublicSearchQueryDto {
  @ApiPropertyOptional({
    enum: PUBLIC_PROVIDER_SORTS,
    default: 'newest',
    description:
      'newest = most recently registered first; name_* = case-insensitive business name; rating_desc = average rating, then rating count; price_* = lowest matching service price (providers without a matching service last). Ties are always broken by provider ID, so ordering is deterministic across pages.',
  })
  @IsOptional()
  @IsIn(PUBLIC_PROVIDER_SORTS)
  sort: PublicProviderSort = 'newest';
}
