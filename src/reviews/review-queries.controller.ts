import {
  Controller,
  Get,
  Param,
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
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { ParseBigIntIdPipe } from '../common/pipes/parse-bigint-id.pipe';
import { ReviewsService } from './reviews.service';
import { Public } from '../auth/decorators/public.decorator';

@ApiTags('Reviews')
@Controller('reviews')
export class ReviewQueriesController {
  constructor(
    private readonly reviewsService: ReviewsService,
  ) {}

  @Get('mine')
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
  @Public()
  @ApiOperation({
    summary: 'Get public reviews for a provider',
    description:
      'Public endpoint (no authentication required). Returns only visible reviews of an APPROVED provider.',
  })
  @ApiOkResponse({
    description:
      'Public provider reviews returned successfully. Returns an empty array when the approved provider has no visible reviews.',
  })
  @ApiBadRequestResponse({
    description: 'Provider ID is invalid.',
  })
  @ApiNotFoundResponse({
    description:
      'Provider was not found or is not publicly visible (PENDING, REJECTED or SUSPENDED).',
  })
  getPublicProviderReviews(
    @Param('providerId', ParseBigIntIdPipe) providerId: string,
  ) {
    return this.reviewsService.getPublicProviderReviews(providerId);
  }
}