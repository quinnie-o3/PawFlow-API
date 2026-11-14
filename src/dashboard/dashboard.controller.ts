import {
  Controller,
  Get,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
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
import { DashboardService } from './dashboard.service';
import { DashboardQueryDto } from './dto/dashboard-query.dto';

@ApiTags('Dashboard')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('dashboard')
export class DashboardController {
  constructor(
    private readonly dashboardService: DashboardService,
  ) {}

  @Get('provider')
  @Roles('PROVIDER_OWNER')
  @ApiOperation({
    summary: 'Get my provider dashboard',
    description:
      'Returns booking volume, cancellation rate, popular services, returning customers, recorded revenue, average rating, and read-only DSS alerts for the selected reporting period.',
  })
  @ApiOkResponse({
    description: 'Provider dashboard returned successfully.',
  })
  @ApiBadRequestResponse({
    description:
      'Reporting period is invalid or from is after to.',
  })
  @ApiUnauthorizedResponse({
    description: 'Authentication is required.',
  })
  @ApiForbiddenResponse({
    description:
      'Only provider owners can access the provider dashboard.',
  })
  @ApiNotFoundResponse({
    description: 'Provider profile was not found.',
  })
  getProviderDashboard(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: DashboardQueryDto,
  ) {
    return this.dashboardService.getProviderDashboard(
      user.id,
      query,
    );
  }
}
