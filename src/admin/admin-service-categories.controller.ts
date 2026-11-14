import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
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
import { AdminMasterDataService } from './admin-master-data.service';
import { CreateAdminServiceCategoryDto } from './dto/create-admin-service-category.dto';
import { AdminMasterDataQueryDto } from './dto/admin-master-data-query.dto';
import { UpdateAdminServiceCategoryDto } from './dto/update-admin-service-category.dto';

@ApiTags('Admin - Service Categories')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('ADMIN')
@Controller('admin/service-categories')
export class AdminServiceCategoriesController {
  constructor(
    private readonly adminMasterDataService: AdminMasterDataService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'List service categories' })
  @ApiOkResponse({ description: 'Service categories returned successfully.' })
  @ApiBadRequestResponse({ description: 'Status filter is invalid.' })
  @ApiUnauthorizedResponse({ description: 'Authentication is required.' })
  @ApiForbiddenResponse({ description: 'Only administrators can access service categories.' })
  getServiceCategories(@Query() query: AdminMasterDataQueryDto) {
    return this.adminMasterDataService.getServiceCategories(query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get one service category' })
  @ApiOkResponse({ description: 'Service category returned successfully.' })
  @ApiBadRequestResponse({ description: 'Service category ID is invalid.' })
  @ApiUnauthorizedResponse({ description: 'Authentication is required.' })
  @ApiForbiddenResponse({ description: 'Only administrators can access service categories.' })
  @ApiNotFoundResponse({ description: 'Service category was not found.' })
  getServiceCategoryById(
    @Param('id', ParseBigIntIdPipe) categoryId: string,
  ) {
    return this.adminMasterDataService.getServiceCategoryById(categoryId);
  }

  @Post()
  @ApiOperation({ summary: 'Create a service category' })
  @ApiCreatedResponse({ description: 'Service category created successfully.' })
  @ApiBadRequestResponse({ description: 'Request data is invalid.' })
  @ApiUnauthorizedResponse({ description: 'Authentication is required.' })
  @ApiForbiddenResponse({ description: 'Only administrators can create service categories.' })
  @ApiConflictResponse({ description: 'Service category name already exists.' })
  createServiceCategory(
    @CurrentUser() admin: AuthenticatedUser,
    @Body() dto: CreateAdminServiceCategoryDto,
  ) {
    return this.adminMasterDataService.createServiceCategory(admin.id, dto);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update editable service category fields' })
  @ApiOkResponse({ description: 'Service category updated successfully.' })
  @ApiBadRequestResponse({ description: 'Service category ID or request data is invalid.' })
  @ApiUnauthorizedResponse({ description: 'Authentication is required.' })
  @ApiForbiddenResponse({ description: 'Only administrators can update service categories.' })
  @ApiNotFoundResponse({ description: 'Service category was not found.' })
  @ApiConflictResponse({ description: 'Service category name already exists.' })
  updateServiceCategory(
    @CurrentUser() admin: AuthenticatedUser,
    @Param('id', ParseBigIntIdPipe) categoryId: string,
    @Body() dto: UpdateAdminServiceCategoryDto,
  ) {
    return this.adminMasterDataService.updateServiceCategory(
      admin.id,
      categoryId,
      dto,
    );
  }

  @Patch(':id/activate')
  @ApiOperation({ summary: 'Activate an inactive service category' })
  @ApiOkResponse({ description: 'Service category activated successfully.' })
  @ApiBadRequestResponse({ description: 'Service category ID is invalid.' })
  @ApiUnauthorizedResponse({ description: 'Authentication is required.' })
  @ApiForbiddenResponse({ description: 'Only administrators can activate service categories.' })
  @ApiNotFoundResponse({ description: 'Service category was not found.' })
  @ApiConflictResponse({ description: 'Only INACTIVE service categories can be activated.' })
  activateServiceCategory(
    @CurrentUser() admin: AuthenticatedUser,
    @Param('id', ParseBigIntIdPipe) categoryId: string,
  ) {
    return this.adminMasterDataService.activateServiceCategory(
      admin.id,
      categoryId,
    );
  }

  @Patch(':id/deactivate')
  @ApiOperation({ summary: 'Deactivate an active service category' })
  @ApiOkResponse({ description: 'Service category deactivated successfully.' })
  @ApiBadRequestResponse({ description: 'Service category ID is invalid.' })
  @ApiUnauthorizedResponse({ description: 'Authentication is required.' })
  @ApiForbiddenResponse({ description: 'Only administrators can deactivate service categories.' })
  @ApiNotFoundResponse({ description: 'Service category was not found.' })
  @ApiConflictResponse({ description: 'Only ACTIVE service categories can be deactivated.' })
  deactivateServiceCategory(
    @CurrentUser() admin: AuthenticatedUser,
    @Param('id', ParseBigIntIdPipe) categoryId: string,
  ) {
    return this.adminMasterDataService.deactivateServiceCategory(
      admin.id,
      categoryId,
    );
  }
}
