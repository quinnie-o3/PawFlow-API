import {
  Controller,
  Get,
  Param,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';

import { ParseBigIntIdPipe } from '../common/pipes/parse-bigint-id.pipe';
import { ServicesService } from './services.service';

@ApiTags('Public Services')
@Controller('services/public')
export class PublicServicesController {
  constructor(
    private readonly servicesService: ServicesService,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'Get publicly available services',
  })
  @ApiOkResponse({
    description:
      'Returns active services from approved providers and active categories.',
  })
  getPublicServices() {
    return this.servicesService.getPublicServices();
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Get one publicly available service',
  })
  @ApiOkResponse({
    description:
      'Public service returned successfully.',
  })
  @ApiBadRequestResponse({
    description: 'Service ID is invalid.',
  })
  @ApiNotFoundResponse({
    description:
      'Service is unavailable, inactive, or belongs to an unapproved provider.',
  })
  getPublicServiceById(
    @Param('id', ParseBigIntIdPipe)
    serviceId: string,
  ) {
    return this.servicesService.getPublicServiceById(
      serviceId,
    );
  }
}