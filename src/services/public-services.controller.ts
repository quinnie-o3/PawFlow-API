import {
  Controller,
  Get,
  Param,
  Query,
} from '@nestjs/common';
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
  PUBLIC_SERVICE_SORTS,
  PublicServiceSearchQueryDto,
} from './dto/public-service-search-query.dto';
import { ServicesService } from './services.service';

const PUBLIC_SERVICE_SCHEMA = {
  type: 'object',
  required: [
    'id',
    'name',
    'description',
    'price',
    'durationMinutes',
    'category',
    'provider',
  ],
  properties: {
    id: {
      type: 'string',
      description: 'BIGINT identifier serialized as a string.',
      example: '5',
    },
    name: { type: 'string', example: 'Full grooming' },
    description: { type: 'string', nullable: true },
    price: {
      type: 'string',
      description: 'NUMERIC(12,2) serialized as a string.',
      example: '150000.00',
    },
    durationMinutes: { type: 'integer', example: 60 },
    category: {
      type: 'object',
      properties: {
        id: { type: 'string', example: '1' },
        name: { type: 'string', example: 'Grooming' },
        description: { type: 'string', nullable: true },
      },
    },
    provider: {
      type: 'object',
      description:
        'Public business profile. Contact phone is intentionally not exposed.',
      properties: {
        id: { type: 'string', example: '3' },
        businessName: { type: 'string', example: 'Paw Spa' },
        address: { type: 'string', example: '1 Nguyen Hue, District 1' },
        description: { type: 'string', nullable: true },
        ratingAvg: { type: 'string', example: '4.50' },
        ratingCount: { type: 'integer', example: 2 },
      },
    },
  },
};

@ApiTags('Public Services')
@Controller('services/public')
export class PublicServicesController {
  constructor(
    private readonly servicesService: ServicesService,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'Get publicly available services',
  })
  @ApiOkResponse({
    description:
      'Returns active services from approved providers and active categories. Public endpoint; no authentication required.',
    schema: { type: 'array', items: PUBLIC_SERVICE_SCHEMA },
  })
  getPublicServices() {
    return this.servicesService.getPublicServices();
  }

  // Declared before `:id` so that `search` is not parsed as a service ID.
  @Get('search')
  @ApiOperation({
    summary: 'Search publicly available services',
    description:
      'Paginated, server-side search over active services of approved providers in active categories. Keyword terms match service name, service description, category name or provider business name (case-insensitive). Unknown or malformed query parameters return 400. Public endpoint; no authentication required.',
  })
  @ApiOkResponse({
    description: 'Search results. An empty `items` array is a valid result.',
    schema: paginatedSchema(PUBLIC_SERVICE_SCHEMA, {
      q: { type: 'string', nullable: true },
      categoryId: { type: 'string', nullable: true },
      providerId: { type: 'string', nullable: true },
      minPrice: { type: 'number', nullable: true },
      maxPrice: { type: 'number', nullable: true },
      minRating: { type: 'number', nullable: true },
      location: { type: 'string', nullable: true },
      sort: { type: 'string', enum: [...PUBLIC_SERVICE_SORTS] },
    }),
  })
  @ApiBadRequestResponse({
    description:
      'A query parameter is unknown, malformed or out of range (e.g. minPrice > maxPrice, limit > 50, unsupported sort).',
  })
  searchPublicServices(@Query() query: PublicServiceSearchQueryDto) {
    return this.servicesService.searchPublicServices(query);
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Get one publicly available service',
  })
  @ApiOkResponse({
    description:
      'Public service returned successfully. Public endpoint; no authentication required.',
    schema: PUBLIC_SERVICE_SCHEMA,
  })
  @ApiBadRequestResponse({
    description: 'Service ID is invalid.',
  })
  @ApiNotFoundResponse({
    description:
      'Service is unavailable, inactive, or belongs to an unapproved provider.',
  })
  getPublicServiceById(
    @Param('id', ParseBigIntIdPipe)
    serviceId: string,
  ) {
    return this.servicesService.getPublicServiceById(
      serviceId,
    );
  }
}