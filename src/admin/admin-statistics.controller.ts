import { Controller, Get } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';

import { Roles } from '../auth/decorators/roles.decorator';
import { AdminStatisticsService } from './admin-statistics.service';

@ApiTags('Admin - Statistics')
@ApiBearerAuth('access-token')
@Roles('ADMIN')
@Controller('admin/statistics')
export class AdminStatisticsController {
  constructor(
    private readonly adminStatisticsService: AdminStatisticsService,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'Get platform-wide record totals',
    description:
      'Returns aggregate totals for providers, current customer accounts, bookings, services, and review rows.',
  })
  @ApiOkResponse({ description: 'Platform statistics returned successfully.' })
  @ApiUnauthorizedResponse({ description: 'Authentication is required.' })
  @ApiForbiddenResponse({ description: 'Only administrators can access statistics.' })
  getStatistics() {
    return this.adminStatisticsService.getStatistics();
  }
}
