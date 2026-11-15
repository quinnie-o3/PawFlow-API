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
import { CreateAdminPetTypeDto } from './dto/create-admin-pet-type.dto';
import { AdminMasterDataQueryDto } from './dto/admin-master-data-query.dto';
import { UpdateAdminPetTypeDto } from './dto/update-admin-pet-type.dto';

@ApiTags('Admin - Pet Types')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('ADMIN')
@Controller('admin/pet-types')
export class AdminPetTypesController {
  constructor(
    private readonly adminMasterDataService: AdminMasterDataService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'List pet types' })
  @ApiOkResponse({ description: 'Pet types returned successfully.' })
  @ApiBadRequestResponse({ description: 'Status filter is invalid.' })
  @ApiUnauthorizedResponse({ description: 'Authentication is required.' })
  @ApiForbiddenResponse({ description: 'Only administrators can access pet types.' })
  getPetTypes(@Query() query: AdminMasterDataQueryDto) {
    return this.adminMasterDataService.getPetTypes(query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get one pet type' })
  @ApiOkResponse({ description: 'Pet type returned successfully.' })
  @ApiBadRequestResponse({ description: 'Pet type ID is invalid.' })
  @ApiUnauthorizedResponse({ description: 'Authentication is required.' })
  @ApiForbiddenResponse({ description: 'Only administrators can access pet types.' })
  @ApiNotFoundResponse({ description: 'Pet type was not found.' })
  getPetTypeById(@Param('id', ParseBigIntIdPipe) petTypeId: string) {
    return this.adminMasterDataService.getPetTypeById(petTypeId);
  }

  @Post()
  @ApiOperation({ summary: 'Create a pet type' })
  @ApiCreatedResponse({ description: 'Pet type created successfully.' })
  @ApiBadRequestResponse({ description: 'Request data is invalid.' })
  @ApiUnauthorizedResponse({ description: 'Authentication is required.' })
  @ApiForbiddenResponse({ description: 'Only administrators can create pet types.' })
  @ApiConflictResponse({ description: 'Pet type name already exists.' })
  createPetType(
    @CurrentUser() admin: AuthenticatedUser,
    @Body() dto: CreateAdminPetTypeDto,
  ) {
    return this.adminMasterDataService.createPetType(admin.id, dto);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update a pet type name' })
  @ApiOkResponse({ description: 'Pet type updated successfully.' })
  @ApiBadRequestResponse({ description: 'Pet type ID or request data is invalid.' })
  @ApiUnauthorizedResponse({ description: 'Authentication is required.' })
  @ApiForbiddenResponse({ description: 'Only administrators can update pet types.' })
  @ApiNotFoundResponse({ description: 'Pet type was not found.' })
  @ApiConflictResponse({ description: 'Pet type name already exists.' })
  updatePetType(
    @CurrentUser() admin: AuthenticatedUser,
    @Param('id', ParseBigIntIdPipe) petTypeId: string,
    @Body() dto: UpdateAdminPetTypeDto,
  ) {
    return this.adminMasterDataService.updatePetType(
      admin.id,
      petTypeId,
      dto,
    );
  }

  @Patch(':id/activate')
  @ApiOperation({ summary: 'Activate an inactive pet type' })
  @ApiOkResponse({ description: 'Pet type activated successfully.' })
  @ApiBadRequestResponse({ description: 'Pet type ID is invalid.' })
  @ApiUnauthorizedResponse({ description: 'Authentication is required.' })
  @ApiForbiddenResponse({ description: 'Only administrators can activate pet types.' })
  @ApiNotFoundResponse({ description: 'Pet type was not found.' })
  @ApiConflictResponse({ description: 'Only INACTIVE pet types can be activated.' })
  activatePetType(
    @CurrentUser() admin: AuthenticatedUser,
    @Param('id', ParseBigIntIdPipe) petTypeId: string,
  ) {
    return this.adminMasterDataService.activatePetType(admin.id, petTypeId);
  }

  @Patch(':id/deactivate')
  @ApiOperation({ summary: 'Deactivate an active pet type' })
  @ApiOkResponse({ description: 'Pet type deactivated successfully.' })
  @ApiBadRequestResponse({ description: 'Pet type ID is invalid.' })
  @ApiUnauthorizedResponse({ description: 'Authentication is required.' })
  @ApiForbiddenResponse({ description: 'Only administrators can deactivate pet types.' })
  @ApiNotFoundResponse({ description: 'Pet type was not found.' })
  @ApiConflictResponse({ description: 'Only ACTIVE pet types can be deactivated.' })
  deactivatePetType(
    @CurrentUser() admin: AuthenticatedUser,
    @Param('id', ParseBigIntIdPipe) petTypeId: string,
  ) {
    return this.adminMasterDataService.deactivatePetType(admin.id, petTypeId);
  }
}
