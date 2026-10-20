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
import { ComplaintsService } from './complaints.service';
import { CreateComplaintDto } from './dto/create-complaint.dto';

@ApiTags('Complaints')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller()
export class ComplaintsController {
  constructor(private readonly complaintsService: ComplaintsService) {}

  @Post('bookings/:id/complaints')
  @Roles('CUSTOMER')
  @ApiOperation({
    summary: 'Create a complaint for my booking',
    description:
      'Creates an OPEN complaint for a booking belonging to the authenticated customer.',
  })
  @ApiCreatedResponse({ description: 'Complaint created successfully.' })
  @ApiBadRequestResponse({
    description: 'Booking ID or complaint reason is invalid.',
  })
  @ApiUnauthorizedResponse({ description: 'Authentication is required.' })
  @ApiForbiddenResponse({
    description:
      'Only customers can create complaints, and the booking must belong to the authenticated customer.',
  })
  @ApiNotFoundResponse({ description: 'Booking was not found.' })
  createComplaint(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseBigIntIdPipe) bookingId: string,
    @Body() dto: CreateComplaintDto,
  ) {
    return this.complaintsService.createComplaint(user.id, bookingId, dto);
  }

  @Get('complaints/mine')
  @Roles('CUSTOMER')
  @ApiOperation({ summary: 'Get my complaints' })
  @ApiOkResponse({ description: 'Customer complaints returned successfully.' })
  @ApiUnauthorizedResponse({ description: 'Authentication is required.' })
  @ApiForbiddenResponse({
    description: 'Only customers can access customer complaints.',
  })
  getMyComplaints(@CurrentUser() user: AuthenticatedUser) {
    return this.complaintsService.getMyComplaints(user.id);
  }

  @Get('complaints/mine/:id')
  @Roles('CUSTOMER')
  @ApiOperation({ summary: 'Get one of my complaints' })
  @ApiOkResponse({ description: 'Complaint returned successfully.' })
  @ApiBadRequestResponse({ description: 'Complaint ID is invalid.' })
  @ApiUnauthorizedResponse({ description: 'Authentication is required.' })
  @ApiForbiddenResponse({
    description: 'The complaint belongs to another customer.',
  })
  @ApiNotFoundResponse({ description: 'Complaint was not found.' })
  getMyComplaintById(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseBigIntIdPipe) complaintId: string,
  ) {
    return this.complaintsService.getMyComplaintById(user.id, complaintId);
  }
}
