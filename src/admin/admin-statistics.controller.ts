import { Controller, Get, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';

import { Roles } from '../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { AdminStatisticsService } from './admin-statistics.service';

@ApiTags('Admin - Statistics')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard, RolesGuard)
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
