import {
  Controller,
  Get,
  Param,
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
import { ParseBigIntIdPipe } from '../common/pipes/parse-bigint-id.pipe';
import { ReviewsService } from './reviews.service';

@ApiTags('Reviews')
@Controller('reviews')
export class ReviewQueriesController {
  constructor(
    private readonly reviewsService: ReviewsService,
  ) {}

  @Get('mine')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('CUSTOMER')
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Get my reviews',
    description:
      'Returns reviews submitted for bookings belonging to the authenticated customer.',
  })
  @ApiOkResponse({
    description: 'Customer reviews returned successfully.',
  })
  @ApiUnauthorizedResponse({
    description: 'Authentication is required.',
  })
  @ApiForbiddenResponse({
    description: 'Only customers can access their review history.',
  })
  getMyReviews(
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.reviewsService.getMyReviews(user.id);
  }

  @Get('provider/:providerId')
  @ApiOperation({
    summary: 'Get public reviews for a provider',
    description:
      'Returns only visible reviews belonging to the specified provider.',
  })
  @ApiOkResponse({
    description: 'Public provider reviews returned successfully.',
  })
  @ApiBadRequestResponse({
    description: 'Provider ID is invalid.',
  })
  @ApiNotFoundResponse({
    description: 'Provider was not found.',
  })
  getPublicProviderReviews(
    @Param('providerId', ParseBigIntIdPipe) providerId: string,
  ) {
    return this.reviewsService.getPublicProviderReviews(providerId);
  }
}