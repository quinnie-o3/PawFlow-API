import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Query,
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
import { AdminService } from './admin.service';
import { AdminComplaintActionDto } from './dto/admin-complaint-action.dto';
import { AdminComplaintQueryDto } from './dto/admin-complaint-query.dto';

@ApiTags('Admin - Complaints')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('ADMIN')
@Controller('admin/complaints')
export class AdminComplaintsController {
  constructor(private readonly adminService: AdminService) {}

  @Get()
  @ApiOperation({ summary: 'List complaints for administrative handling' })
  @ApiOkResponse({ description: 'Complaints returned successfully.' })
  @ApiBadRequestResponse({ description: 'Complaint status filter is invalid.' })
  @ApiUnauthorizedResponse({ description: 'Authentication is required.' })
  @ApiForbiddenResponse({ description: 'Only administrators can access complaints.' })
  getComplaints(@Query() query: AdminComplaintQueryDto) {
    return this.adminService.getComplaints(query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get complaint administrative detail' })
  @ApiOkResponse({ description: 'Complaint returned successfully.' })
  @ApiBadRequestResponse({ description: 'Complaint ID is invalid.' })
  @ApiUnauthorizedResponse({ description: 'Authentication is required.' })
  @ApiForbiddenResponse({ description: 'Only administrators can access complaints.' })
  @ApiNotFoundResponse({ description: 'Complaint was not found.' })
  getComplaintById(@Param('id', ParseBigIntIdPipe) complaintId: string) {
    return this.adminService.getComplaintById(complaintId);
  }

  @Patch(':id/review')
  @ApiOperation({ summary: 'Mark an open complaint as in review' })
  @ApiOkResponse({ description: 'Complaint marked as in review successfully.' })
  @ApiBadRequestResponse({ description: 'Complaint ID or request body is invalid.' })
  @ApiUnauthorizedResponse({ description: 'Authentication is required.' })
  @ApiForbiddenResponse({ description: 'Only administrators can handle complaints.' })
  @ApiNotFoundResponse({ description: 'Complaint was not found.' })
  @ApiConflictResponse({ description: 'Only OPEN complaints can be marked in review.' })
  markComplaintInReview(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseBigIntIdPipe) complaintId: string,
    @Body() dto: AdminComplaintActionDto,
  ) {
    return this.adminService.markComplaintInReview(user.id, complaintId, dto);
  }

  @Patch(':id/resolve')
  @ApiOperation({ summary: 'Resolve an in-review complaint' })
  @ApiOkResponse({ description: 'Complaint resolved successfully.' })
  @ApiBadRequestResponse({ description: 'Complaint ID or request body is invalid.' })
  @ApiUnauthorizedResponse({ description: 'Authentication is required.' })
  @ApiForbiddenResponse({ description: 'Only administrators can handle complaints.' })
  @ApiNotFoundResponse({ description: 'Complaint was not found.' })
  @ApiConflictResponse({ description: 'Only IN_REVIEW complaints can be resolved.' })
  resolveComplaint(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseBigIntIdPipe) complaintId: string,
    @Body() dto: AdminComplaintActionDto,
  ) {
    return this.adminService.resolveComplaint(user.id, complaintId, dto);
  }

  @Patch(':id/reject')
  @ApiOperation({ summary: 'Reject an in-review complaint' })
  @ApiOkResponse({ description: 'Complaint rejected successfully.' })
  @ApiBadRequestResponse({ description: 'Complaint ID or request body is invalid.' })
  @ApiUnauthorizedResponse({ description: 'Authentication is required.' })
  @ApiForbiddenResponse({ description: 'Only administrators can handle complaints.' })
  @ApiNotFoundResponse({ description: 'Complaint was not found.' })
  @ApiConflictResponse({ description: 'Only IN_REVIEW complaints can be rejected.' })
  rejectComplaint(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseBigIntIdPipe) complaintId: string,
    @Body() dto: AdminComplaintActionDto,
  ) {
    return this.adminService.rejectComplaint(user.id, complaintId, dto);
  }
}
