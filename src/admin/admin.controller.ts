import {
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
import { AdminProviderQueryDto } from './dto/admin-provider-query.dto';

@ApiTags('Admin - Providers')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('ADMIN')
@Controller('admin/providers')
export class AdminController {
  constructor(private readonly adminService: AdminService) {}

  @Get()
  @ApiOperation({ summary: 'List providers for administrative review' })
  @ApiOkResponse({ description: 'Providers returned successfully.' })
  @ApiBadRequestResponse({ description: 'Approval status filter is invalid.' })
  @ApiUnauthorizedResponse({ description: 'Authentication is required.' })
  @ApiForbiddenResponse({ description: 'Only administrators can access providers.' })
  getProviders(@Query() query: AdminProviderQueryDto) {
    return this.adminService.getProviders(query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get provider administrative detail' })
  @ApiOkResponse({ description: 'Provider returned successfully.' })
  @ApiBadRequestResponse({ description: 'Provider ID is invalid.' })
  @ApiUnauthorizedResponse({ description: 'Authentication is required.' })
  @ApiForbiddenResponse({ description: 'Only administrators can access providers.' })
  @ApiNotFoundResponse({ description: 'Provider was not found.' })
  getProviderById(
    @Param('id', ParseBigIntIdPipe) providerId: string,
  ) {
    return this.adminService.getProviderById(providerId);
  }

  @Patch(':id/approve')
  @ApiOperation({ summary: 'Approve a pending provider' })
  @ApiOkResponse({ description: 'Provider approved successfully.' })
  @ApiBadRequestResponse({ description: 'Provider ID is invalid.' })
  @ApiUnauthorizedResponse({ description: 'Authentication is required.' })
  @ApiForbiddenResponse({ description: 'Only administrators can approve providers.' })
  @ApiNotFoundResponse({ description: 'Provider was not found.' })
  @ApiConflictResponse({ description: 'Only PENDING providers can be approved.' })
  approveProvider(
    @CurrentUser() admin: AuthenticatedUser,
    @Param('id', ParseBigIntIdPipe) providerId: string,
  ) {
    return this.adminService.approveProvider(admin.id, providerId);
  }

  @Patch(':id/reject')
  @ApiOperation({ summary: 'Reject a pending provider' })
  @ApiOkResponse({ description: 'Provider rejected successfully.' })
  @ApiBadRequestResponse({ description: 'Provider ID is invalid.' })
  @ApiUnauthorizedResponse({ description: 'Authentication is required.' })
  @ApiForbiddenResponse({ description: 'Only administrators can reject providers.' })
  @ApiNotFoundResponse({ description: 'Provider was not found.' })
  @ApiConflictResponse({ description: 'Only PENDING providers can be rejected.' })
  rejectProvider(
    @CurrentUser() admin: AuthenticatedUser,
    @Param('id', ParseBigIntIdPipe) providerId: string,
  ) {
    return this.adminService.rejectProvider(admin.id, providerId);
  }

  @Patch(':id/suspend')
  @ApiOperation({ summary: 'Suspend an approved provider' })
  @ApiOkResponse({ description: 'Provider suspended successfully.' })
  @ApiBadRequestResponse({ description: 'Provider ID is invalid.' })
  @ApiUnauthorizedResponse({ description: 'Authentication is required.' })
  @ApiForbiddenResponse({ description: 'Only administrators can suspend providers.' })
  @ApiNotFoundResponse({ description: 'Provider was not found.' })
  @ApiConflictResponse({ description: 'Only APPROVED providers can be suspended.' })
  suspendProvider(
    @CurrentUser() admin: AuthenticatedUser,
    @Param('id', ParseBigIntIdPipe) providerId: string,
  ) {
    return this.adminService.suspendProvider(admin.id, providerId);
  }

  @Patch(':id/reactivate')
  @ApiOperation({ summary: 'Reactivate a suspended provider' })
  @ApiOkResponse({ description: 'Provider reactivated successfully.' })
  @ApiBadRequestResponse({ description: 'Provider ID is invalid.' })
  @ApiUnauthorizedResponse({ description: 'Authentication is required.' })
  @ApiForbiddenResponse({ description: 'Only administrators can reactivate providers.' })
  @ApiNotFoundResponse({ description: 'Provider was not found.' })
  @ApiConflictResponse({ description: 'Only SUSPENDED providers can be reactivated.' })
  reactivateProvider(
    @CurrentUser() admin: AuthenticatedUser,
    @Param('id', ParseBigIntIdPipe) providerId: string,
  ) {
    return this.adminService.reactivateProvider(admin.id, providerId);
  }
}
