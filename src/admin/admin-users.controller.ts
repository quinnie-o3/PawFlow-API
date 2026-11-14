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
import { AdminUserQueryDto } from './dto/admin-user-query.dto';
import { AdminUsersService } from './admin-users.service';

@ApiTags('Admin - Users')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('ADMIN')
@Controller('admin/users')
export class AdminUsersController {
  constructor(private readonly adminUsersService: AdminUsersService) {}

  @Get()
  @ApiOperation({
    summary: 'List user accounts for administration',
    description: 'Role and status are read-only filters; this endpoint cannot edit roles.',
  })
  @ApiOkResponse({ description: 'Users returned successfully.' })
  @ApiBadRequestResponse({ description: 'Role or status filter is invalid.' })
  @ApiUnauthorizedResponse({ description: 'Authentication is required.' })
  @ApiForbiddenResponse({ description: 'Only administrators can access users.' })
  getUsers(@Query() query: AdminUserQueryDto) {
    return this.adminUsersService.getUsers(query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get user administrative detail' })
  @ApiOkResponse({ description: 'User returned successfully.' })
  @ApiBadRequestResponse({ description: 'User ID is invalid.' })
  @ApiUnauthorizedResponse({ description: 'Authentication is required.' })
  @ApiForbiddenResponse({ description: 'Only administrators can access users.' })
  @ApiNotFoundResponse({ description: 'User was not found.' })
  getUserById(@Param('id', ParseBigIntIdPipe) userId: string) {
    return this.adminUsersService.getUserById(userId);
  }

  @Patch(':id/suspend')
  @ApiOperation({
    summary: 'Suspend an active user account',
    description: 'Only ACTIVE non-administrator accounts can be suspended. Administrators cannot suspend themselves or other administrators.',
  })
  @ApiOkResponse({ description: 'User suspended successfully.' })
  @ApiBadRequestResponse({ description: 'User ID is invalid.' })
  @ApiUnauthorizedResponse({ description: 'Authentication is required.' })
  @ApiForbiddenResponse({ description: 'Only administrators can suspend users.' })
  @ApiNotFoundResponse({ description: 'User was not found.' })
  @ApiConflictResponse({ description: 'Only ACTIVE users can be suspended; self-suspension and suspending another ADMIN are not allowed.' })
  suspendUser(
    @CurrentUser() admin: AuthenticatedUser,
    @Param('id', ParseBigIntIdPipe) userId: string,
  ) {
    return this.adminUsersService.suspendUser(admin.id, userId);
  }

  @Patch(':id/reactivate')
  @ApiOperation({
    summary: 'Reactivate a suspended user account',
    description: 'Only SUSPENDED accounts can be reactivated; INACTIVE accounts are not changed.',
  })
  @ApiOkResponse({ description: 'User reactivated successfully.' })
  @ApiBadRequestResponse({ description: 'User ID is invalid.' })
  @ApiUnauthorizedResponse({ description: 'Authentication is required.' })
  @ApiForbiddenResponse({ description: 'Only administrators can reactivate users.' })
  @ApiNotFoundResponse({ description: 'User was not found.' })
  @ApiConflictResponse({ description: 'Only SUSPENDED users can be reactivated.' })
  reactivateUser(
    @CurrentUser() admin: AuthenticatedUser,
    @Param('id', ParseBigIntIdPipe) userId: string,
  ) {
    return this.adminUsersService.reactivateUser(admin.id, userId);
  }
}
