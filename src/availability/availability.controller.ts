import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';

import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { ParseBigIntIdPipe } from '../common/pipes/parse-bigint-id.pipe';
import { AvailabilityService } from './availability.service';
import { CreateAvailabilitySlotDto } from './dto/create-availability-slot.dto';
import { UpdateAvailabilitySlotDto } from './dto/update-availability-slot.dto';

@ApiTags('Availability')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('availability')
export class AvailabilityController {
  constructor(
    private readonly availabilityService: AvailabilityService,
  ) {}

  @Post()
  @Roles('PROVIDER_OWNER')
  @ApiOperation({
    summary: 'Create an availability slot for my provider',
  })
  @ApiCreatedResponse({
    description: 'Availability slot created successfully.',
  })
  @ApiBadRequestResponse({
    description:
      'Request validation failed, the service is inactive, the date is in the past, or the time range is invalid.',
  })
  @ApiUnauthorizedResponse({
    description: 'Authentication is required.',
  })
  @ApiForbiddenResponse({
    description:
      'Only provider owners can create slots, or the selected service belongs to another provider.',
  })
  @ApiNotFoundResponse({
    description:
      'Provider profile or selected service was not found.',
  })
  @ApiConflictResponse({
    description:
      'An identical availability slot already exists.',
  })
  createMySlot(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateAvailabilitySlotDto,
  ) {
    return this.availabilityService.createMySlot(
      user.id,
      dto,
    );
  }

  @Get('mine')
  @Roles('PROVIDER_OWNER')
  @ApiOperation({
    summary: 'Get all availability slots for my provider',
  })
  @ApiOkResponse({
    description:
      'Provider availability slots returned successfully.',
  })
  @ApiUnauthorizedResponse({
    description: 'Authentication is required.',
  })
  @ApiForbiddenResponse({
    description:
      'Only provider owners can access this resource.',
  })
  @ApiNotFoundResponse({
    description: 'Provider profile was not found.',
  })
  getMySlots(
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.availabilityService.getMySlots(
      user.id,
    );
  }

  @Get('mine/:id')
  @Roles('PROVIDER_OWNER')
  @ApiOperation({
    summary: 'Get one availability slot for my provider',
  })
  @ApiOkResponse({
    description:
      'Availability slot returned successfully.',
  })
  @ApiBadRequestResponse({
    description: 'Availability slot ID is invalid.',
  })
  @ApiUnauthorizedResponse({
    description: 'Authentication is required.',
  })
  @ApiForbiddenResponse({
    description:
      'The availability slot belongs to another provider.',
  })
  @ApiNotFoundResponse({
    description:
      'Provider profile or availability slot was not found.',
  })
  getMySlotById(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseBigIntIdPipe)
    slotId: string,
  ) {
    return this.availabilityService.getMySlotById(
      user.id,
      slotId,
    );
  }

  @Patch('mine/:id')
  @Roles('PROVIDER_OWNER')
  @ApiOperation({
    summary: 'Update one availability slot for my provider',
  })
  @ApiOkResponse({
    description:
      'Availability slot updated successfully.',
  })
  @ApiBadRequestResponse({
    description:
      'Request validation failed, capacity is invalid, date is in the past, or the time range is invalid.',
  })
  @ApiUnauthorizedResponse({
    description: 'Authentication is required.',
  })
  @ApiForbiddenResponse({
    description:
      'The slot or selected service belongs to another provider.',
  })
  @ApiNotFoundResponse({
    description:
      'Provider profile, availability slot, or selected service was not found.',
  })
  @ApiConflictResponse({
    description:
      'The slot already has bookings and its schedule cannot be changed, or an identical slot already exists.',
  })
  updateMySlot(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseBigIntIdPipe)
    slotId: string,
    @Body() dto: UpdateAvailabilitySlotDto,
  ) {
    return this.availabilityService.updateMySlot(
      user.id,
      slotId,
      dto,
    );
  }

  @Delete('mine/:id')
  @Roles('PROVIDER_OWNER')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Cancel one availability slot for my provider',
  })
  @ApiNoContentResponse({
    description:
      'Availability slot cancelled successfully.',
  })
  @ApiBadRequestResponse({
    description: 'Availability slot ID is invalid.',
  })
  @ApiUnauthorizedResponse({
    description: 'Authentication is required.',
  })
  @ApiForbiddenResponse({
    description:
      'The availability slot belongs to another provider.',
  })
  @ApiNotFoundResponse({
    description:
      'Provider profile or availability slot was not found.',
  })
  async deactivateMySlot(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseBigIntIdPipe)
    slotId: string,
  ): Promise<void> {
    await this.availabilityService.deactivateMySlot(
      user.id,
      slotId,
    );
  }
}