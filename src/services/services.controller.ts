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
import { Roles } from '../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { ParseBigIntIdPipe } from '../common/pipes/parse-bigint-id.pipe';
import { CreateServiceDto } from './dto/create-service.dto';
import { UpdateServiceDto } from './dto/update-service.dto';
import { ServicesService } from './services.service';

@ApiTags('Services')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('services')
export class ServicesController {
  constructor(
    private readonly servicesService: ServicesService,
  ) {}

  @Post()
  @Roles('PROVIDER_OWNER')
  @ApiOperation({
    summary: 'Create a service for my provider',
  })
  @ApiCreatedResponse({
    description: 'Service created successfully.',
  })
  @ApiBadRequestResponse({
    description: 'Request validation failed.',
  })
  @ApiUnauthorizedResponse({
    description: 'Authentication is required.',
  })
  @ApiForbiddenResponse({
    description: 'Only provider owners can create services.',
  })
  @ApiNotFoundResponse({
    description:
      'Provider profile or active service category was not found.',
  })
  createMyService(
    @CurrentUser() user: AuthenticatedUser,
    @Body() createServiceDto: CreateServiceDto,
  ) {
    return this.servicesService.createMyService(
      user.id,
      createServiceDto,
    );
  }

  @Get('mine')
  @Roles('PROVIDER_OWNER')
  @ApiOperation({
    summary: 'Get all services for my provider',
  })
  @ApiOkResponse({
    description: 'Provider services returned successfully.',
  })
  @ApiUnauthorizedResponse({
    description: 'Authentication is required.',
  })
  @ApiForbiddenResponse({
    description: 'Only provider owners can access this resource.',
  })
  @ApiNotFoundResponse({
    description: 'Provider profile was not found.',
  })
  getMyServices(
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.servicesService.getMyServices(user.id);
  }

  @Get('mine/:id')
  @Roles('PROVIDER_OWNER')
  @ApiOperation({
    summary: 'Get one service for my provider',
  })
  @ApiOkResponse({
    description: 'Service returned successfully.',
  })
  @ApiBadRequestResponse({
    description: 'Service ID is invalid.',
  })
  @ApiUnauthorizedResponse({
    description: 'Authentication is required.',
  })
  @ApiForbiddenResponse({
    description:
      'The service belongs to another provider.',
  })
  @ApiNotFoundResponse({
    description:
      'Provider profile or service was not found.',
  })
  getMyServiceById(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseBigIntIdPipe)
    serviceId: string,
  ) {
    return this.servicesService.getMyServiceById(
      user.id,
      serviceId,
    );
  }

  @Patch('mine/:id')
  @Roles('PROVIDER_OWNER')
  @ApiOperation({
    summary: 'Update one service for my provider',
  })
  @ApiOkResponse({
    description: 'Service updated successfully.',
  })
  @ApiBadRequestResponse({
    description:
      'Service ID or request data is invalid.',
  })
  @ApiUnauthorizedResponse({
    description: 'Authentication is required.',
  })
  @ApiForbiddenResponse({
    description:
      'The service belongs to another provider.',
  })
  @ApiNotFoundResponse({
    description:
      'Provider profile, service, or active category was not found.',
  })
  updateMyService(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseBigIntIdPipe)
    serviceId: string,
    @Body() updateServiceDto: UpdateServiceDto,
  ) {
    return this.servicesService.updateMyService(
      user.id,
      serviceId,
      updateServiceDto,
    );
  }

  @Delete('mine/:id')
  @Roles('PROVIDER_OWNER')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Deactivate one service for my provider',
  })
  @ApiNoContentResponse({
    description: 'Service deactivated successfully.',
  })
  @ApiBadRequestResponse({
    description: 'Service ID is invalid.',
  })
  @ApiUnauthorizedResponse({
    description: 'Authentication is required.',
  })
  @ApiForbiddenResponse({
    description:
      'The service belongs to another provider.',
  })
  @ApiNotFoundResponse({
    description:
      'Provider profile or service was not found.',
  })
  async deactivateMyService(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseBigIntIdPipe)
    serviceId: string,
  ): Promise<void> {
    await this.servicesService.deactivateMyService(
      user.id,
      serviceId,
    );
  }
}