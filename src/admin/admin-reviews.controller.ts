import {
  Controller,
  Get,
  Param,
  Patch,
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
import { AdminService } from './admin.service';

@ApiTags('Admin - Reviews')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('ADMIN')
@Controller('admin/reviews')
export class AdminReviewsController {
  constructor(private readonly adminService: AdminService) {}

  @Get()
  @ApiOperation({ summary: 'List reviews for moderation' })
  @ApiOkResponse({ description: 'Reviews returned successfully.' })
  @ApiUnauthorizedResponse({ description: 'Authentication is required.' })
  @ApiForbiddenResponse({ description: 'Only administrators can access reviews.' })
  getReviews() {
    return this.adminService.getReviews();
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get review moderation detail' })
  @ApiOkResponse({ description: 'Review returned successfully.' })
  @ApiBadRequestResponse({ description: 'Review ID is invalid.' })
  @ApiUnauthorizedResponse({ description: 'Authentication is required.' })
  @ApiForbiddenResponse({ description: 'Only administrators can access reviews.' })
  @ApiNotFoundResponse({ description: 'Review was not found.' })
  getReviewById(@Param('id', ParseBigIntIdPipe) reviewId: string) {
    return this.adminService.getReviewById(reviewId);
  }

  @Patch(':id/hide')
  @ApiOperation({ summary: 'Hide a visible review' })
  @ApiOkResponse({ description: 'Review hidden and provider rating recalculated.' })
  @ApiBadRequestResponse({ description: 'Review ID is invalid.' })
  @ApiUnauthorizedResponse({ description: 'Authentication is required.' })
  @ApiForbiddenResponse({ description: 'Only administrators can moderate reviews.' })
  @ApiNotFoundResponse({ description: 'Review was not found.' })
  @ApiConflictResponse({ description: 'Only visible reviews can be hidden.' })
  hideReview(
    @CurrentUser() admin: AuthenticatedUser,
    @Param('id', ParseBigIntIdPipe) reviewId: string,
  ) {
    return this.adminService.hideReview(admin.id, reviewId);
  }

  @Patch(':id/restore')
  @ApiOperation({ summary: 'Restore a hidden review' })
  @ApiOkResponse({ description: 'Review restored and provider rating recalculated.' })
  @ApiBadRequestResponse({ description: 'Review ID is invalid.' })
  @ApiUnauthorizedResponse({ description: 'Authentication is required.' })
  @ApiForbiddenResponse({ description: 'Only administrators can moderate reviews.' })
  @ApiNotFoundResponse({ description: 'Review was not found.' })
  @ApiConflictResponse({ description: 'Only hidden reviews can be restored.' })
  restoreReview(
    @CurrentUser() admin: AuthenticatedUser,
    @Param('id', ParseBigIntIdPipe) reviewId: string,
  ) {
    return this.adminService.restoreReview(admin.id, reviewId);
  }
}
