import { Controller, Get, Param, Query } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';

import { paginatedSchema } from '../common/dto/paginated-schema';
import { ParseBigIntIdPipe } from '../common/pipes/parse-bigint-id.pipe';
import {
  PUBLIC_PROVIDER_SORTS,
  PublicProviderSearchQueryDto,
} from './dto/public-provider-search-query.dto';
import { PublicProvidersService } from './public-providers.service';

const PUBLIC_PROVIDER_SEARCH_ITEM_SCHEMA = {
  type: 'object',
  required: [
    'id',
    'businessName',
    'address',
    'description',
    'ratingAvg',
    'ratingCount',
    'serviceCount',
    'minPrice',
    'maxPrice',
  ],
  description:
    'Public business profile. Owner, contact phone and approval metadata are intentionally not exposed.',
  properties: {
    id: {
      type: 'string',
      description: 'BIGINT identifier serialized as a string.',
      example: '3',
    },
    businessName: { type: 'string', example: 'Paw Spa' },
    address: { type: 'string', example: '1 Nguyen Hue, District 1' },
    description: { type: 'string', nullable: true },
    ratingAvg: {
      type: 'string',
      description: 'NUMERIC(3,2) serialized as a string.',
      example: '4.50',
    },
    ratingCount: { type: 'integer', example: 2 },
    serviceCount: {
      type: 'integer',
      description:
        'Number of public services matching categoryId/minPrice/maxPrice (all public services when those filters are absent).',
      example: 4,
    },
    minPrice: {
      type: 'string',
      nullable: true,
      description:
        'Lowest price among the counted services; null when serviceCount is 0.',
      example: '100000.00',
    },
    maxPrice: {
      type: 'string',
      nullable: true,
      description:
        'Highest price among the counted services; null when serviceCount is 0.',
      example: '350000.00',
    },
  },
};

@ApiTags('Public Providers')
@Controller('providers/public')
export class PublicProvidersController {
  constructor(
    private readonly publicProvidersService: PublicProvidersService,
  ) {}

  @Get('search')
  @ApiOperation({
    summary: 'Search publicly visible providers',
    description:
      'Paginated, server-side search over approved providers. Keyword terms match business name, provider description, or the name, description or category name of one of the provider\'s public services (case-insensitive). categoryId/minPrice/maxPrice keep providers offering at least one public service that satisfies all of them. Unknown or malformed query parameters return 400. Public endpoint; no authentication required.',
  })
  @ApiOkResponse({
    description: 'Search results. An empty `items` array is a valid result.',
    schema: paginatedSchema(PUBLIC_PROVIDER_SEARCH_ITEM_SCHEMA, {
      q: { type: 'string', nullable: true },
      categoryId: { type: 'string', nullable: true },
      minPrice: { type: 'number', nullable: true },
      maxPrice: { type: 'number', nullable: true },
      minRating: { type: 'number', nullable: true },
      location: { type: 'string', nullable: true },
      sort: { type: 'string', enum: [...PUBLIC_PROVIDER_SORTS] },
    }),
  })
  @ApiBadRequestResponse({
    description:
      'A query parameter is unknown, malformed or out of range (e.g. minPrice > maxPrice, limit > 50, unsupported sort).',
  })
  searchPublicProviders(@Query() query: PublicProviderSearchQueryDto) {
    return this.publicProvidersService.searchPublicProviders(query);
  }

  // Declared after `search` so that `search` is not parsed as a provider ID.
  @Get(':id')
  @ApiOperation({
    summary: 'Get one publicly visible provider',
    description:
      "Public profile of an APPROVED provider, identical to its item in an unfiltered provider search. serviceCount/minPrice/maxPrice cover all of the provider's public services (ACTIVE services in ACTIVE categories). Related collections are paginated separately: GET /services/public/search?providerId=:id for services and GET /reviews/provider/:id for reviews. Public endpoint; no authentication required.",
  })
  @ApiOkResponse({
    description: 'Public provider profile returned successfully.',
    schema: PUBLIC_PROVIDER_SEARCH_ITEM_SCHEMA,
  })
  @ApiBadRequestResponse({
    description: 'Provider ID is invalid.',
  })
  @ApiNotFoundResponse({
    description:
      'Provider was not found or is not publicly visible (PENDING, REJECTED or SUSPENDED). Both cases return the same response.',
  })
  getPublicProviderById(
    @Param('id', ParseBigIntIdPipe)
    providerId: string,
  ) {
    return this.publicProvidersService.getPublicProviderById(providerId);
  }
}
