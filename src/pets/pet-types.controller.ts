import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';

import { PetsService } from './pets.service';

/**
 * Public, read-only discovery of pet types.
 *
 * Administrative management lives under `/admin/pet-types` and keeps its
 * ADMIN-only guards; this controller exposes no mutations.
 */
@ApiTags('Pet Types')
@Controller('pet-types')
export class PetTypesController {
  constructor(private readonly petsService: PetsService) {}

  @Get()
  @ApiOperation({
    summary: 'Get active pet types',
    description:
      'Public endpoint (no authentication required). Returns only ACTIVE pet types, ordered by name, for selection when creating or updating a pet.',
  })
  @ApiOkResponse({
    description:
      'Active pet types returned successfully. Returns an empty array when none are active.',
    schema: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'name'],
        properties: {
          id: {
            type: 'string',
            description: 'BIGINT identifier serialized as a string.',
            example: '1',
          },
          name: { type: 'string', example: 'Dog' },
        },
      },
      example: [
        { id: '2', name: 'Cat' },
        { id: '1', name: 'Dog' },
      ],
    },
  })
  getActivePetTypes() {
    return this.petsService.getActivePetTypes();
  }
}
