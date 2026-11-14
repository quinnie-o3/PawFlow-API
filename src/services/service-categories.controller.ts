import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';

import { ServicesService } from './services.service';

/**
 * Public, read-only discovery of service categories.
 *
 * Administrative management lives under `/admin/service-categories` and
 * keeps its ADMIN-only guards; this controller exposes no mutations.
 */
@ApiTags('Service Categories')
@Controller('service-categories')
export class ServiceCategoriesController {
  constructor(private readonly servicesService: ServicesService) {}

  @Get()
  @ApiOperation({
    summary: 'Get active service categories',
    description:
      'Public endpoint (no authentication required). Returns only ACTIVE service categories, ordered by name, for selection when creating or updating a service.',
  })
  @ApiOkResponse({
    description:
      'Active service categories returned successfully. Returns an empty array when none are active.',
    schema: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'name', 'description'],
        properties: {
          id: {
            type: 'string',
            description: 'BIGINT identifier serialized as a string.',
            example: '1',
          },
          name: { type: 'string', example: 'Grooming' },
          description: {
            type: 'string',
            nullable: true,
            example: 'Bathing, trimming and coat care.',
          },
        },
      },
      example: [
        {
          id: '1',
          name: 'Grooming',
          description: 'Bathing, trimming and coat care.',
        },
        { id: '2', name: 'Veterinary', description: null },
      ],
    },
  })
  getActiveServiceCategories() {
    return this.servicesService.getActiveServiceCategories();
  }
}
