import {
  Controller,
  Get,
  Param,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';

import { ParseBigIntIdPipe } from '../common/pipes/parse-bigint-id.pipe';
import { AvailabilityService } from './availability.service';

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
      'Returns future open slots with remaining capacity from approved providers and active services.',
  })
  getPublicSlots() {
    return this.availabilityService.getPublicSlots();
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Get one publicly bookable availability slot',
  })
  @ApiOkResponse({
    description:
      'Available slot returned successfully.',
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