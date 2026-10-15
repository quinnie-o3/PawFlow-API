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
import { ParseBigIntIdPipe } from '../common/pipes/parse-bigint-id.pipe';
import { Roles } from '../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { CreateProviderDto } from './dto/create-provider.dto';
import { CreateProviderStaffDto } from './dto/create-provider-staff.dto';
import { UpdateProviderDto } from './dto/update-provider.dto';
import { UpdateProviderStaffDto } from './dto/update-provider-staff.dto';
import { ProvidersService } from './providers.service';
import { CreateProviderWorkingHourDto } from './dto/create-provider-working-hour.dto';
import { UpdateProviderWorkingHourDto } from './dto/update-provider-working-hour.dto';

@ApiTags('Providers')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('providers')
export class ProvidersController {
  constructor(
    private readonly providersService: ProvidersService,
  ) {}

  @Post()
  @Roles('CUSTOMER')
  @ApiOperation({
    summary: 'Register a provider profile',
    description:
      'Creates a provider profile for the authenticated customer. The provider starts with PENDING approval status.',
  })
  @ApiCreatedResponse({
    description: 'Provider profile created successfully.',
  })
  @ApiBadRequestResponse({
    description: 'Request validation failed.',
  })
  @ApiUnauthorizedResponse({
    description: 'Authentication is required.',
  })
  @ApiForbiddenResponse({
    description:
      'Only a customer account can register a provider profile.',
  })
  @ApiConflictResponse({
    description:
      'This account already owns a provider profile.',
  })
  createMyProvider(
    @CurrentUser() user: AuthenticatedUser,
    @Body() createProviderDto: CreateProviderDto,
  ) {
    return this.providersService.createMyProvider(
      user,
      createProviderDto,
    );
  }

  @Get('me')
  @Roles('PROVIDER_OWNER')
  @ApiOperation({
    summary: 'Get my provider profile',
    description:
      'Returns the provider profile owned by the authenticated provider owner.',
  })
  @ApiOkResponse({
    description: 'Provider profile returned successfully.',
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
  getMyProvider(
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.providersService.getMyProvider(user.id);
  }

  @Patch('me')
  @Roles('PROVIDER_OWNER')
  @ApiOperation({
    summary: 'Update my provider profile',
    description:
      'Updates editable fields of the authenticated provider owner profile.',
  })
  @ApiOkResponse({
    description: 'Provider profile updated successfully.',
  })
  @ApiBadRequestResponse({
    description:
      'Request validation failed or unsupported fields were provided.',
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
  updateMyProvider(
    @CurrentUser() user: AuthenticatedUser,
    @Body() updateProviderDto: UpdateProviderDto,
  ) {
    return this.providersService.updateMyProvider(
      user.id,
      updateProviderDto,
    );
  }

  @Post('staff')
  @Roles('PROVIDER_OWNER')
  @ApiOperation({ summary: 'Add a staff member to my provider' })
  @ApiCreatedResponse({ description: 'Staff member added successfully.' })
  @ApiBadRequestResponse({ description: 'Request validation failed or the target account is inactive.' })
  @ApiUnauthorizedResponse({ description: 'Authentication is required.' })
  @ApiForbiddenResponse({ description: 'Only provider owners can manage staff.' })
  @ApiNotFoundResponse({ description: 'Provider profile or target user was not found.' })
  @ApiConflictResponse({ description: 'The user is not eligible for staff assignment or is already associated with a provider.' })
  addMyStaff(
    @CurrentUser() user: AuthenticatedUser,
    @Body() createProviderStaffDto: CreateProviderStaffDto,
  ) {
    return this.providersService.addMyStaff(user.id, createProviderStaffDto);
  }

  @Get('staff')
  @Roles('PROVIDER_OWNER')
  @ApiOperation({ summary: 'Get staff members for my provider' })
  @ApiOkResponse({ description: 'Provider staff returned successfully.' })
  @ApiUnauthorizedResponse({ description: 'Authentication is required.' })
  @ApiForbiddenResponse({ description: 'Only provider owners can manage staff.' })
  @ApiNotFoundResponse({ description: 'Provider profile was not found.' })
  getMyStaff(@CurrentUser() user: AuthenticatedUser) {
    return this.providersService.getMyStaff(user.id);
  }

  @Get('staff/:id')
  @Roles('PROVIDER_OWNER')
  @ApiOperation({ summary: 'Get one staff member for my provider' })
  @ApiOkResponse({ description: 'Provider staff record returned successfully.' })
  @ApiBadRequestResponse({ description: 'Staff ID is not a valid positive integer.' })
  @ApiUnauthorizedResponse({ description: 'Authentication is required.' })
  @ApiForbiddenResponse({ description: 'Only the owning provider can access this staff record.' })
  @ApiNotFoundResponse({ description: 'Provider profile or staff record was not found.' })
  getMyStaffById(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseBigIntIdPipe) staffId: string,
  ) {
    return this.providersService.getMyStaffById(user.id, staffId);
  }

  @Patch('staff/:id')
  @Roles('PROVIDER_OWNER')
  @ApiOperation({ summary: 'Update one staff member for my provider' })
  @ApiOkResponse({ description: 'Provider staff record updated successfully.' })
  @ApiBadRequestResponse({ description: 'Request validation failed or the user account is inactive.' })
  @ApiUnauthorizedResponse({ description: 'Authentication is required.' })
  @ApiForbiddenResponse({ description: 'Only the owning provider can update this staff record.' })
  @ApiNotFoundResponse({ description: 'Provider profile, staff record, or user account was not found.' })
  @ApiConflictResponse({ description: 'The underlying user account has an incompatible role.' })
  updateMyStaff(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseBigIntIdPipe) staffId: string,
    @Body() updateProviderStaffDto: UpdateProviderStaffDto,
  ) {
    return this.providersService.updateMyStaff(
      user.id,
      staffId,
      updateProviderStaffDto,
    );
  }

  @Delete('staff/:id')
  @Roles('PROVIDER_OWNER')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Deactivate one staff member for my provider' })
  @ApiNoContentResponse({ description: 'Provider staff record deactivated successfully.' })
  @ApiBadRequestResponse({ description: 'Staff ID is not a valid positive integer.' })
  @ApiUnauthorizedResponse({ description: 'Authentication is required.' })
  @ApiForbiddenResponse({ description: 'Only the owning provider can deactivate this staff record.' })
  @ApiNotFoundResponse({ description: 'Provider profile, staff record, or user account was not found.' })
  async deactivateMyStaff(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseBigIntIdPipe) staffId: string,
  ): Promise<void> {
    await this.providersService.deactivateMyStaff(user.id, staffId);
  }
    @Post('working-hours')
  @Roles('PROVIDER_OWNER')
  @ApiOperation({
    summary: 'Create a working-hour entry for my provider',
  })
  @ApiCreatedResponse({
    description: 'Working-hour entry created successfully.',
  })
  @ApiBadRequestResponse({
    description:
      'Request validation failed or startTime is not earlier than endTime.',
  })
  @ApiUnauthorizedResponse({
    description: 'Authentication is required.',
  })
  @ApiForbiddenResponse({
    description:
      'Only provider owners can manage working hours.',
  })
  @ApiNotFoundResponse({
    description: 'Provider profile was not found.',
  })
  @ApiConflictResponse({
    description:
      'An identical working-hour entry already exists.',
  })
  createMyWorkingHour(
    @CurrentUser() user: AuthenticatedUser,
    @Body()
    createProviderWorkingHourDto: CreateProviderWorkingHourDto,
  ) {
    return this.providersService.createMyWorkingHour(
      user.id,
      createProviderWorkingHourDto,
    );
  }

  @Get('working-hours')
  @Roles('PROVIDER_OWNER')
  @ApiOperation({
    summary: 'Get working hours for my provider',
  })
  @ApiOkResponse({
    description:
      'Provider working hours returned successfully.',
  })
  @ApiUnauthorizedResponse({
    description: 'Authentication is required.',
  })
  @ApiForbiddenResponse({
    description:
      'Only provider owners can manage working hours.',
  })
  @ApiNotFoundResponse({
    description: 'Provider profile was not found.',
  })
  getMyWorkingHours(
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.providersService.getMyWorkingHours(
      user.id,
    );
  }

  @Patch('working-hours/:id')
  @Roles('PROVIDER_OWNER')
  @ApiOperation({
    summary: 'Update one working-hour entry for my provider',
  })
  @ApiOkResponse({
    description:
      'Working-hour entry updated successfully.',
  })
  @ApiBadRequestResponse({
    description:
      'Request validation failed, ID is invalid, or the time range is invalid.',
  })
  @ApiUnauthorizedResponse({
    description: 'Authentication is required.',
  })
  @ApiForbiddenResponse({
    description:
      'Only the owning provider can update this working-hour entry.',
  })
  @ApiNotFoundResponse({
    description:
      'Provider profile or working-hour entry was not found.',
  })
  @ApiConflictResponse({
    description:
      'An identical working-hour entry already exists.',
  })
  updateMyWorkingHour(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseBigIntIdPipe)
    workingHourId: string,
    @Body()
    updateProviderWorkingHourDto: UpdateProviderWorkingHourDto,
  ) {
    return this.providersService.updateMyWorkingHour(
      user.id,
      workingHourId,
      updateProviderWorkingHourDto,
    );
  }

  @Delete('working-hours/:id')
  @Roles('PROVIDER_OWNER')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Deactivate one working-hour entry for my provider',
  })
  @ApiNoContentResponse({
    description:
      'Working-hour entry deactivated successfully.',
  })
  @ApiBadRequestResponse({
    description:
      'Working-hour ID is not a valid positive integer.',
  })
  @ApiUnauthorizedResponse({
    description: 'Authentication is required.',
  })
  @ApiForbiddenResponse({
    description:
      'Only the owning provider can deactivate this working-hour entry.',
  })
  @ApiNotFoundResponse({
    description:
      'Provider profile or working-hour entry was not found.',
  })
  async deactivateMyWorkingHour(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseBigIntIdPipe)
    workingHourId: string,
  ): Promise<void> {
    await this.providersService.deactivateMyWorkingHour(
      user.id,
      workingHourId,
    );
  }
}
