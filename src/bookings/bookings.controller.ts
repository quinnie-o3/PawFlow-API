import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
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
import { BookingsService } from './bookings.service';
import { CancelBookingDto } from './dto/cancel-booking.dto';
import { CreateBookingDto } from './dto/create-booking.dto';
import { NoShowBookingDto } from './dto/no-show-booking.dto';
import { RejectBookingDto } from './dto/reject-booking.dto';

@ApiTags('Bookings')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('bookings')
export class BookingsController {
  constructor(
    private readonly bookingsService: BookingsService,
  ) {}

  @Post()
  @Roles('CUSTOMER')
  @ApiOperation({
    summary: 'Create a booking',
    description:
      'Creates a PENDING_CONFIRMATION booking for an available slot and reserves one unit of slot capacity.',
  })
  @ApiCreatedResponse({
    description:
      'Booking created and slot capacity reserved successfully.',
  })
  @ApiBadRequestResponse({
    description:
      'Request validation failed, selected pet/service/provider is invalid, or the slot is in the past.',
  })
  @ApiUnauthorizedResponse({
    description: 'Authentication is required.',
  })
  @ApiForbiddenResponse({
    description: 'Only customers can create bookings.',
  })
  @ApiNotFoundResponse({
    description: 'Pet, slot, service, or provider was not found.',
  })
  @ApiConflictResponse({
    description:
      'The slot is closed/full or cannot currently accept another booking.',
  })
  createBooking(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateBookingDto,
  ) {
    return this.bookingsService.createBooking(user.id, dto);
  }

  @Get('mine')
  @Roles('CUSTOMER')
  @ApiOperation({
    summary: 'Get my booking history',
    description:
      'Returns all bookings created by the authenticated customer.',
  })
  @ApiOkResponse({
    description: 'Customer booking history returned successfully.',
  })
  @ApiUnauthorizedResponse({
    description: 'Authentication is required.',
  })
  @ApiForbiddenResponse({
    description: 'Only customers can access customer booking history.',
  })
  getMyBookings(@CurrentUser() user: AuthenticatedUser) {
    return this.bookingsService.getMyBookings(user.id);
  }

  @Get('mine/:id')
  @Roles('CUSTOMER')
  @ApiOperation({
    summary: 'Get one of my bookings',
    description:
      'Returns one booking and its status history for the authenticated customer.',
  })
  @ApiOkResponse({ description: 'Booking returned successfully.' })
  @ApiBadRequestResponse({ description: 'Booking ID is invalid.' })
  @ApiUnauthorizedResponse({ description: 'Authentication is required.' })
  @ApiForbiddenResponse({
    description: 'The booking belongs to another customer.',
  })
  @ApiNotFoundResponse({ description: 'Booking was not found.' })
  getMyBookingById(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseBigIntIdPipe) bookingId: string,
  ) {
    return this.bookingsService.getMyBookingById(user.id, bookingId);
  }

  @Post('mine/:id/cancel')
  @Roles('CUSTOMER')
  @ApiOperation({
    summary: 'Cancel one of my bookings',
    description:
      'Changes a PENDING_CONFIRMATION or CONFIRMED booking to CANCELLED and releases one unit of slot capacity.',
  })
  @ApiOkResponse({
    description: 'Booking cancelled and slot capacity released successfully.',
  })
  @ApiBadRequestResponse({
    description: 'Booking ID or cancellation reason is invalid.',
  })
  @ApiUnauthorizedResponse({ description: 'Authentication is required.' })
  @ApiForbiddenResponse({
    description: 'The booking belongs to another customer.',
  })
  @ApiNotFoundResponse({
    description: 'Booking or availability slot was not found.',
  })
  @ApiConflictResponse({
    description:
      'Only PENDING_CONFIRMATION or CONFIRMED bookings can be cancelled, and slot capacity must be available to release.',
  })
  cancelMyBooking(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseBigIntIdPipe) bookingId: string,
    @Body() dto?: CancelBookingDto,
  ) {
    return this.bookingsService.cancelMyBooking(user.id, bookingId, dto);
  }

  @Get('provider')
  @Roles('PROVIDER_OWNER', 'PROVIDER_STAFF')
  @ApiOperation({
    summary: 'Get bookings for my provider',
    description:
      'Returns bookings belonging to the provider managed by the authenticated owner or active staff member.',
  })
  @ApiOkResponse({ description: 'Provider bookings returned successfully.' })
  @ApiUnauthorizedResponse({ description: 'Authentication is required.' })
  @ApiForbiddenResponse({
    description:
      'Only provider owners or active provider staff can access provider bookings.',
  })
  @ApiNotFoundResponse({ description: 'Provider profile was not found.' })
  getProviderBookings(@CurrentUser() user: AuthenticatedUser) {
    return this.bookingsService.getProviderBookings(user);
  }

  @Get('provider/:id')
  @Roles('PROVIDER_OWNER', 'PROVIDER_STAFF')
  @ApiOperation({ summary: 'Get one booking for my provider' })
  @ApiOkResponse({ description: 'Provider booking returned successfully.' })
  @ApiBadRequestResponse({ description: 'Booking ID is invalid.' })
  @ApiUnauthorizedResponse({ description: 'Authentication is required.' })
  @ApiForbiddenResponse({
    description:
      'The booking belongs to another provider or the staff association is inactive.',
  })
  @ApiNotFoundResponse({
    description: 'Booking or provider profile was not found.',
  })
  getProviderBookingById(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseBigIntIdPipe) bookingId: string,
  ) {
    return this.bookingsService.getProviderBookingById(user, bookingId);
  }

  @Post('provider/:id/confirm')
  @Roles('PROVIDER_OWNER', 'PROVIDER_STAFF')
  @ApiOperation({
    summary: 'Confirm a pending booking',
    description:
      'Changes a PENDING_CONFIRMATION booking to CONFIRMED. The slot capacity remains reserved.',
  })
  @ApiOkResponse({ description: 'Booking confirmed successfully.' })
  @ApiBadRequestResponse({ description: 'Booking ID is invalid.' })
  @ApiUnauthorizedResponse({ description: 'Authentication is required.' })
  @ApiForbiddenResponse({
    description:
      'The booking belongs to another provider or the staff association is inactive.',
  })
  @ApiNotFoundResponse({ description: 'Booking or provider profile was not found.' })
  @ApiConflictResponse({
    description: 'Only a PENDING_CONFIRMATION booking can be confirmed.',
  })
  confirmProviderBooking(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseBigIntIdPipe) bookingId: string,
  ) {
    return this.bookingsService.confirmProviderBooking(user, bookingId);
  }

  @Post('provider/:id/reject')
  @Roles('PROVIDER_OWNER', 'PROVIDER_STAFF')
  @ApiOperation({
    summary: 'Reject a pending booking',
    description:
      'Changes a PENDING_CONFIRMATION booking to REJECTED and releases one unit of slot capacity.',
  })
  @ApiOkResponse({
    description: 'Booking rejected and slot capacity released successfully.',
  })
  @ApiBadRequestResponse({
    description: 'Booking ID or rejection reason is invalid.',
  })
  @ApiUnauthorizedResponse({ description: 'Authentication is required.' })
  @ApiForbiddenResponse({
    description:
      'The booking belongs to another provider or the staff association is inactive.',
  })
  @ApiNotFoundResponse({
    description: 'Booking, slot, or provider profile was not found.',
  })
  @ApiConflictResponse({
    description:
      'Only a PENDING_CONFIRMATION booking can be rejected, and slot capacity must be available to release.',
  })
  rejectProviderBooking(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseBigIntIdPipe) bookingId: string,
    @Body() dto?: RejectBookingDto,
  ) {
    return this.bookingsService.rejectProviderBooking(user, bookingId, dto);
  }

  @Post('provider/:id/complete')
  @Roles('PROVIDER_OWNER', 'PROVIDER_STAFF')
  @ApiOperation({
    summary: 'Complete a confirmed booking',
    description:
      'Changes a CONFIRMED booking to COMPLETED. Slot capacity remains unchanged because the appointment was consumed.',
  })
  @ApiOkResponse({ description: 'Booking completed successfully.' })
  @ApiBadRequestResponse({ description: 'Booking ID is invalid.' })
  @ApiUnauthorizedResponse({ description: 'Authentication is required.' })
  @ApiForbiddenResponse({
    description:
      'The booking belongs to another provider or the staff association is inactive.',
  })
  @ApiNotFoundResponse({ description: 'Booking or provider profile was not found.' })
  @ApiConflictResponse({
    description: 'Only a CONFIRMED booking can be completed.',
  })
  completeProviderBooking(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseBigIntIdPipe) bookingId: string,
  ) {
    return this.bookingsService.completeProviderBooking(user, bookingId);
  }

  @Post('provider/:id/no-show')
  @Roles('PROVIDER_OWNER', 'PROVIDER_STAFF')
  @ApiOperation({
    summary: 'Mark a confirmed booking as no-show',
    description:
      'Changes a CONFIRMED booking to NO_SHOW. Slot capacity remains unchanged because the appointment time was consumed.',
  })
  @ApiOkResponse({ description: 'Booking marked as no-show successfully.' })
  @ApiBadRequestResponse({
    description: 'Booking ID or no-show reason is invalid.',
  })
  @ApiUnauthorizedResponse({ description: 'Authentication is required.' })
  @ApiForbiddenResponse({
    description:
      'The booking belongs to another provider or the staff association is inactive.',
  })
  @ApiNotFoundResponse({ description: 'Booking or provider profile was not found.' })
  @ApiConflictResponse({
    description: 'Only a CONFIRMED booking can be marked as no-show.',
  })
  noShowProviderBooking(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseBigIntIdPipe) bookingId: string,
    @Body() dto?: NoShowBookingDto,
  ) {
    return this.bookingsService.noShowProviderBooking(user, bookingId, dto);
  }
}
