import {
  Body,
  Controller,
  Get,
  Param,
  Put,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
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
import { UpdatePaymentDto } from './dto/update-payment.dto';
import { PaymentsService } from './payments.service';

@ApiTags('Payments')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('payments')
export class PaymentsController {
  constructor(
    private readonly paymentsService: PaymentsService,
  ) {}

  @Put('provider/booking/:id')
  @Roles('PROVIDER_OWNER')
  @ApiOperation({
    summary: 'Create or update payment status for a completed booking',
    description:
      'Creates a simulated payment record if none exists, or updates the existing record. The amount is always derived from the booking price.',
  })
  @ApiOkResponse({
    description: 'Payment created or updated successfully.',
  })
  @ApiBadRequestResponse({
    description: 'Booking ID, payment status, or payment method is invalid.',
  })
  @ApiUnauthorizedResponse({
    description: 'Authentication is required.',
  })
  @ApiForbiddenResponse({
    description:
      'Only the provider owner may manage payment for bookings belonging to their provider.',
  })
  @ApiNotFoundResponse({
    description: 'Provider profile or booking was not found.',
  })
  @ApiConflictResponse({
    description:
      'Payment can only be managed for a COMPLETED booking.',
  })
  upsertProviderPayment(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseBigIntIdPipe) bookingId: string,
    @Body() dto: UpdatePaymentDto,
  ) {
    return this.paymentsService.upsertProviderPayment(
      user.id,
      bookingId,
      dto,
    );
  }

  @Get('provider')
  @Roles('PROVIDER_OWNER')
  @ApiOperation({
    summary: 'Get payments for my provider',
    description:
      'Returns simulated payment records associated with bookings of the authenticated provider owner.',
  })
  @ApiOkResponse({
    description: 'Provider payments returned successfully.',
  })
  @ApiUnauthorizedResponse({
    description: 'Authentication is required.',
  })
  @ApiForbiddenResponse({
    description: 'Only provider owners can access provider payments.',
  })
  @ApiNotFoundResponse({
    description: 'Provider profile was not found.',
  })
  getProviderPayments(
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.paymentsService.getProviderPayments(user.id);
  }

  @Get('provider/booking/:id')
  @Roles('PROVIDER_OWNER')
  @ApiOperation({
    summary: 'Get payment for one provider booking',
    description:
      'Returns the simulated payment record for a booking belonging to the authenticated provider owner.',
  })
  @ApiOkResponse({
    description: 'Payment returned successfully.',
  })
  @ApiBadRequestResponse({
    description: 'Booking ID is invalid.',
  })
  @ApiUnauthorizedResponse({
    description: 'Authentication is required.',
  })
  @ApiForbiddenResponse({
    description:
      'The booking belongs to another provider.',
  })
  @ApiNotFoundResponse({
    description:
      'Provider profile, booking, or payment record was not found.',
  })
  getProviderPaymentByBookingId(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseBigIntIdPipe) bookingId: string,
  ) {
    return this.paymentsService.getProviderPaymentByBookingId(
      user.id,
      bookingId,
    );
  }
}