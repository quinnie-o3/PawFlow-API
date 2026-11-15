import {
  Controller,
  Get,
  Param,
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

import { Roles } from '../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { ParseBigIntIdPipe } from '../common/pipes/parse-bigint-id.pipe';
import { AdminActivityLogService } from './admin-activity-log.service';
import { AdminActivityLogQueryDto } from './dto/admin-activity-log-query.dto';

@ApiTags('Admin - Activity Logs')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('ADMIN')
@Controller('admin/activity-logs')
export class AdminActivityLogsController {
  constructor(
    private readonly adminActivityLogService: AdminActivityLogService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'List administrative activity logs' })
  @ApiOkResponse({ description: 'Administrative activity logs returned successfully.' })
  @ApiBadRequestResponse({ description: 'A filter, date range, or pagination value is invalid.' })
  @ApiUnauthorizedResponse({ description: 'Authentication is required.' })
  @ApiForbiddenResponse({ description: 'Only administrators can access activity logs.' })
  getActivityLogs(@Query() query: AdminActivityLogQueryDto) {
    return this.adminActivityLogService.getActivityLogs(query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get one administrative activity log' })
  @ApiOkResponse({ description: 'Administrative activity log returned successfully.' })
  @ApiBadRequestResponse({ description: 'Activity log ID is invalid.' })
  @ApiUnauthorizedResponse({ description: 'Authentication is required.' })
  @ApiForbiddenResponse({ description: 'Only administrators can access activity logs.' })
  @ApiNotFoundResponse({ description: 'Administrative activity log was not found.' })
  getActivityLogById(
    @Param('id', ParseBigIntIdPipe) activityLogId: string,
  ) {
    return this.adminActivityLogService.getActivityLogById(activityLogId);
  }
}
