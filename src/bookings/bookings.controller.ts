import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiHeader,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { Response } from 'express';

import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { ParseBigIntIdPipe } from '../common/pipes/parse-bigint-id.pipe';
import {
  IDEMPOTENCY_KEY_HEADER,
  IDEMPOTENT_REPLAYED_HEADER,
  IdempotencyKey,
} from './booking-idempotency';
import {
  type CustomerBookingDetailView,
  type CustomerBookingView,
  type ProviderBookingDetailView,
  type ProviderBookingView,
  toCustomerBookingDetailView,
  toCustomerBookingView,
  toProviderBookingDetailView,
  toProviderBookingView,
} from './booking-views';
import { BookingsService } from './bookings.service';
import {
  CUSTOMER_BOOKING_DETAIL_SCHEMA,
  CUSTOMER_BOOKING_SCHEMA,
  PROVIDER_BOOKING_DETAIL_SCHEMA,
  PROVIDER_BOOKING_SCHEMA,
} from './dto/booking-response.schema';
import { CancelBookingDto } from './dto/cancel-booking.dto';
import { CreateBookingDto } from './dto/create-booking.dto';
import { NoShowBookingDto } from './dto/no-show-booking.dto';
import { RejectBookingDto } from './dto/reject-booking.dto';

const CUSTOMER_FORBIDDEN =
  'Only customers can access their bookings. A booking owned by another customer returns 404.';
const PROVIDER_FORBIDDEN =
  'Only provider owners or active provider staff can manage provider bookings (inactive staff and other roles get 403). A booking owned by another provider returns 404.';

/**
 * Every handler returns an explicit projection (`booking-views.ts`), never a
 * TypeORM entity. Status-changing POST actions keep Nest's default 201.
 */
@ApiTags('Bookings')
@ApiBearerAuth('access-token')
@ApiUnauthorizedResponse({ description: 'Authentication is required.' })
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
      'Creates a PENDING_CONFIRMATION booking for an available slot and reserves one unit of slot capacity. ' +
      'Send an `Idempotency-Key` header to make retries safe: repeating the request with the same key and the same ' +
      'payload returns the booking created by the first request (in its current state) instead of creating another one, ' +
      'even if the slot has since become full or started. Failed attempts are not stored, so retrying them re-runs the booking. ' +
      'A concurrent request with the same key waits until the first one finishes. Without the header every request is a new booking attempt. ' +
      'Created and replayed bookings use the same response schema as `GET /bookings/mine`.',
  })
  @ApiHeader({
    name: IDEMPOTENCY_KEY_HEADER,
    required: false,
    description:
      'Client-generated key identifying one booking attempt (e.g. a UUID v4). 16-128 characters from A-Z, a-z, 0-9, "-" and "_"; ' +
      'compared exactly. Scoped to the authenticated customer; reuse it only to retry the same attempt. Keys do not expire.',
    schema: {
      type: 'string',
      pattern: '^[A-Za-z0-9_-]{16,128}$',
      minLength: 16,
      maxLength: 128,
      example: '3f0c8a52-6c1e-4f5b-9a7e-2d4b8c1e9f00',
    },
  })
  @ApiCreatedResponse({
    description:
      'Booking created and slot capacity reserved successfully, or (with a reused Idempotency-Key and the same payload) the original booking returned in its current state without reserving capacity again.',
    headers: {
      [IDEMPOTENT_REPLAYED_HEADER]: {
        description:
          'Present only when Idempotency-Key was sent: `true` if the booking was created by an earlier request with that key, `false` if this request created it.',
        schema: { type: 'string', enum: ['true', 'false'] },
      },
    },
    schema: CUSTOMER_BOOKING_SCHEMA,
  })
  @ApiBadRequestResponse({
    description:
      'Request validation failed, Idempotency-Key is malformed or longer than 128 characters, selected pet/service/provider is invalid, or the slot is in the past or has already started (its start instant is not strictly after the current server-local time).',
  })
  @ApiForbiddenResponse({
    description: 'Only customers can create bookings.',
  })
  @ApiNotFoundResponse({
    description: 'Pet, slot, service, or provider was not found.',
  })
  @ApiConflictResponse({
    description:
      "The slot is closed/full, cannot currently accept another booking, is outside the provider's current working hours, or is shorter than the service duration; " +
      'or the Idempotency-Key was already used by this customer with a different payload; ' +
      'or a request with the same Idempotency-Key is still in progress (retry the same request).',
  })
  async createBooking(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateBookingDto,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ): Promise<CustomerBookingView> {
    if (idempotencyKey === undefined) {
      return toCustomerBookingView(
        await this.bookingsService.createBooking(user.id, dto),
      );
    }

    const { booking, replayed } =
      await this.bookingsService.createBookingIdempotently(
        user.id,
        dto,
        idempotencyKey,
      );
    response.setHeader(IDEMPOTENT_REPLAYED_HEADER, String(replayed));

    return toCustomerBookingView(booking);
  }

  @Get('mine')
  @Roles('CUSTOMER')
  @ApiOperation({
    summary: 'Get my booking history',
    description:
      'Returns all bookings created by the authenticated customer, newest first.',
  })
  @ApiOkResponse({
    description: 'Customer booking history returned successfully.',
    schema: { type: 'array', items: CUSTOMER_BOOKING_SCHEMA },
  })
  @ApiForbiddenResponse({
    description: 'Only customers can access customer booking history.',
  })
  async getMyBookings(
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<CustomerBookingView[]> {
    const bookings = await this.bookingsService.getMyBookings(user.id);

    return bookings.map(toCustomerBookingView);
  }

  @Get('mine/:id')
  @Roles('CUSTOMER')
  @ApiOperation({
    summary: 'Get one of my bookings',
    description:
      'Returns one booking and its status history for the authenticated customer.',
  })
  @ApiOkResponse({
    description: 'Booking returned successfully.',
    schema: CUSTOMER_BOOKING_DETAIL_SCHEMA,
  })
  @ApiBadRequestResponse({ description: 'Booking ID is invalid.' })
  @ApiForbiddenResponse({ description: CUSTOMER_FORBIDDEN })
  @ApiNotFoundResponse({ description: 'Booking was not found.' })
  async getMyBookingById(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseBigIntIdPipe) bookingId: string,
  ): Promise<CustomerBookingDetailView> {
    return toCustomerBookingDetailView(
      await this.bookingsService.getMyBookingById(user.id, bookingId),
    );
  }

  @Post('mine/:id/cancel')
  @Roles('CUSTOMER')
  @ApiOperation({
    summary: 'Cancel one of my bookings',
    description:
      'Changes a PENDING_CONFIRMATION or CONFIRMED booking to CANCELLED and releases one unit of slot capacity.',
  })
  @ApiCreatedResponse({
    description:
      'Booking cancelled and slot capacity released successfully; returns the updated booking.',
    schema: CUSTOMER_BOOKING_SCHEMA,
  })
  @ApiBadRequestResponse({
    description: 'Booking ID or cancellation reason is invalid.',
  })
  @ApiForbiddenResponse({ description: CUSTOMER_FORBIDDEN })
  @ApiNotFoundResponse({
    description: 'Booking or availability slot was not found.',
  })
  @ApiConflictResponse({
    description:
      'Only PENDING_CONFIRMATION or CONFIRMED bookings can be cancelled, and slot capacity must be available to release.',
  })
  async cancelMyBooking(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseBigIntIdPipe) bookingId: string,
    @Body() dto?: CancelBookingDto,
  ): Promise<CustomerBookingView> {
    return toCustomerBookingView(
      await this.bookingsService.cancelMyBooking(user.id, bookingId, dto),
    );
  }

  @Get('provider')
  @Roles('PROVIDER_OWNER', 'PROVIDER_STAFF')
  @ApiOperation({
    summary: 'Get bookings for my provider',
    description:
      'Returns bookings belonging to the provider managed by the authenticated owner or active staff member, newest first.',
  })
  @ApiOkResponse({
    description: 'Provider bookings returned successfully.',
    schema: { type: 'array', items: PROVIDER_BOOKING_SCHEMA },
  })
  @ApiForbiddenResponse({
    description:
      'Only provider owners or active provider staff can access provider bookings.',
  })
  @ApiNotFoundResponse({ description: 'Provider profile was not found.' })
  async getProviderBookings(
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<ProviderBookingView[]> {
    const bookings = await this.bookingsService.getProviderBookings(user);

    return bookings.map(toProviderBookingView);
  }

  @Get('provider/:id')
  @Roles('PROVIDER_OWNER', 'PROVIDER_STAFF')
  @ApiOperation({
    summary: 'Get one booking for my provider',
    description: 'Returns one provider booking and its status history.',
  })
  @ApiOkResponse({
    description: 'Provider booking returned successfully.',
    schema: PROVIDER_BOOKING_DETAIL_SCHEMA,
  })
  @ApiBadRequestResponse({ description: 'Booking ID is invalid.' })
  @ApiForbiddenResponse({ description: PROVIDER_FORBIDDEN })
  @ApiNotFoundResponse({
    description: 'Booking or provider profile was not found.',
  })
  async getProviderBookingById(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseBigIntIdPipe) bookingId: string,
  ): Promise<ProviderBookingDetailView> {
    return toProviderBookingDetailView(
      await this.bookingsService.getProviderBookingById(user, bookingId),
    );
  }

  @Post('provider/:id/confirm')
  @Roles('PROVIDER_OWNER', 'PROVIDER_STAFF')
  @ApiOperation({
    summary: 'Confirm a pending booking',
    description:
      'Changes a PENDING_CONFIRMATION booking to CONFIRMED. The slot capacity remains reserved. ' +
      'Only an APPROVED provider can confirm: a PENDING, REJECTED or SUSPENDED provider (owner or staff) gets 403 and the booking is unchanged.',
  })
  @ApiCreatedResponse({
    description: 'Booking confirmed successfully; returns the updated booking.',
    schema: PROVIDER_BOOKING_SCHEMA,
  })
  @ApiBadRequestResponse({ description: 'Booking ID is invalid.' })
  @ApiForbiddenResponse({
    description: `${PROVIDER_FORBIDDEN} The provider is not APPROVED (PENDING, REJECTED or SUSPENDED); checked after ownership and before the booking status.`,
  })
  @ApiNotFoundResponse({ description: 'Booking or provider profile was not found.' })
  @ApiConflictResponse({
    description: 'Only a PENDING_CONFIRMATION booking can be confirmed.',
  })
  async confirmProviderBooking(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseBigIntIdPipe) bookingId: string,
  ): Promise<ProviderBookingView> {
    return toProviderBookingView(
      await this.bookingsService.confirmProviderBooking(user, bookingId),
    );
  }

  @Post('provider/:id/reject')
  @Roles('PROVIDER_OWNER', 'PROVIDER_STAFF')
  @ApiOperation({
    summary: 'Reject a pending booking',
    description:
      'Changes a PENDING_CONFIRMATION booking to REJECTED and releases one unit of slot capacity. Allowed whatever the provider approval status, so a SUSPENDED provider can wind down pending requests.',
  })
  @ApiCreatedResponse({
    description:
      'Booking rejected and slot capacity released successfully; returns the updated booking.',
    schema: PROVIDER_BOOKING_SCHEMA,
  })
  @ApiBadRequestResponse({
    description: 'Booking ID or rejection reason is invalid.',
  })
  @ApiForbiddenResponse({ description: PROVIDER_FORBIDDEN })
  @ApiNotFoundResponse({
    description: 'Booking, slot, or provider profile was not found.',
  })
  @ApiConflictResponse({
    description:
      'Only a PENDING_CONFIRMATION booking can be rejected, and slot capacity must be available to release.',
  })
  async rejectProviderBooking(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseBigIntIdPipe) bookingId: string,
    @Body() dto?: RejectBookingDto,
  ): Promise<ProviderBookingView> {
    return toProviderBookingView(
      await this.bookingsService.rejectProviderBooking(user, bookingId, dto),
    );
  }

  @Post('provider/:id/complete')
  @Roles('PROVIDER_OWNER', 'PROVIDER_STAFF')
  @ApiOperation({
    summary: 'Complete a confirmed booking',
    description:
      'Changes a CONFIRMED booking to COMPLETED. Slot capacity remains unchanged because the appointment was consumed. Allowed whatever the provider approval status (including SUSPENDED).',
  })
  @ApiCreatedResponse({
    description: 'Booking completed successfully; returns the updated booking.',
    schema: PROVIDER_BOOKING_SCHEMA,
  })
  @ApiBadRequestResponse({ description: 'Booking ID is invalid.' })
  @ApiForbiddenResponse({ description: PROVIDER_FORBIDDEN })
  @ApiNotFoundResponse({ description: 'Booking or provider profile was not found.' })
  @ApiConflictResponse({
    description: 'Only a CONFIRMED booking can be completed.',
  })
  async completeProviderBooking(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseBigIntIdPipe) bookingId: string,
  ): Promise<ProviderBookingView> {
    return toProviderBookingView(
      await this.bookingsService.completeProviderBooking(user, bookingId),
    );
  }

  @Post('provider/:id/no-show')
  @Roles('PROVIDER_OWNER', 'PROVIDER_STAFF')
  @ApiOperation({
    summary: 'Mark a confirmed booking as no-show',
    description:
      'Changes a CONFIRMED booking to NO_SHOW. Slot capacity remains unchanged because the appointment time was consumed. Allowed whatever the provider approval status (including SUSPENDED).',
  })
  @ApiCreatedResponse({
    description:
      'Booking marked as no-show successfully; returns the updated booking.',
    schema: PROVIDER_BOOKING_SCHEMA,
  })
  @ApiBadRequestResponse({
    description: 'Booking ID or no-show reason is invalid.',
  })
  @ApiForbiddenResponse({ description: PROVIDER_FORBIDDEN })
  @ApiNotFoundResponse({ description: 'Booking or provider profile was not found.' })
  @ApiConflictResponse({
    description: 'Only a CONFIRMED booking can be marked as no-show.',
  })
  async noShowProviderBooking(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseBigIntIdPipe) bookingId: string,
    @Body() dto?: NoShowBookingDto,
  ): Promise<ProviderBookingView> {
    return toProviderBookingView(
      await this.bookingsService.noShowProviderBooking(user, bookingId, dto),
    );
  }
}
