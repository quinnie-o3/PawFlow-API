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
import { AvailabilityService } from './availability.service';
import { PublicAvailabilitySearchQueryDto } from './dto/public-availability-search-query.dto';

const PUBLIC_SLOT_SCHEMA = {
  type: 'object',
  required: [
    'id',
    'slotDate',
    'startTime',
    'endTime',
    'capacity',
    'bookedCount',
    'service',
    'provider',
  ],
  properties: {
    id: {
      type: 'string',
      description: 'BIGINT identifier serialized as a string.',
      example: '12',
    },
    slotDate: { type: 'string', format: 'date', example: '2026-12-01' },
    startTime: { type: 'string', example: '09:00:00' },
    endTime: { type: 'string', example: '10:00:00' },
    capacity: { type: 'integer', example: 3 },
    bookedCount: { type: 'integer', example: 1 },
    service: {
      type: 'object',
      properties: {
        id: { type: 'string', example: '5' },
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
      },
    },
    provider: {
      type: 'object',
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

@ApiTags('Public Availability')
@Controller('availability/public')
export class PublicAvailabilityController {
  constructor(
    private readonly availabilityService: AvailabilityService,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'Get publicly bookable availability slots',
  })
  @ApiOkResponse({
    description:
      'Returns future open slots with remaining capacity from approved providers, active services and active categories. Public endpoint; no authentication required.',
    schema: { type: 'array', items: PUBLIC_SLOT_SCHEMA },
  })
  getPublicSlots() {
    return this.availabilityService.getPublicSlots();
  }

  // Declared before `:id` so that `search` is not parsed as a slot ID.
  @Get('search')
  @ApiOperation({
    summary: 'Search publicly bookable availability slots',
    description:
      'Paginated slots of one provider and/or service, ordered by date, start time, then ID. Only bookable slots are returned: OPEN with remaining capacity, of an APPROVED provider, ACTIVE service and ACTIVE category, and not yet started (dated after today, or today with a start time not before the current server-local minute, matching booking validation). A hidden, foreign or nonexistent provider/service returns an empty page. Public endpoint; no authentication required.',
  })
  @ApiOkResponse({
    description: 'Search results. An empty `items` array is a valid result.',
    schema: paginatedSchema(PUBLIC_SLOT_SCHEMA, {
      providerId: { type: 'string', nullable: true },
      serviceId: { type: 'string', nullable: true },
      date: { type: 'string', format: 'date', nullable: true },
      fromDate: { type: 'string', format: 'date', nullable: true },
      toDate: { type: 'string', format: 'date', nullable: true },
    }),
  })
  @ApiBadRequestResponse({
    description:
      'Neither providerId nor serviceId was given, an ID or date is malformed, date is combined with fromDate/toDate, toDate is before fromDate, page/limit is out of range, or an unknown parameter was sent.',
  })
  searchPublicSlots(@Query() query: PublicAvailabilitySearchQueryDto) {
    return this.availabilityService.searchPublicSlots(query);
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Get one publicly bookable availability slot',
  })
  @ApiOkResponse({
    description:
      'Available slot returned successfully. Public endpoint; no authentication required.',
    schema: PUBLIC_SLOT_SCHEMA,
  })
  @ApiBadRequestResponse({
    description: 'Availability slot ID is invalid.',
  })
  @ApiNotFoundResponse({
    description:
      'The slot does not exist or is not currently bookable.',
  })
  getPublicSlotById(
    @Param('id', ParseBigIntIdPipe)
    slotId: string,
  ) {
    return this.availabilityService.getPublicSlotById(
      slotId,
    );
  }
}