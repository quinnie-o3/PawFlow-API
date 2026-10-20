import {
  Body,
  Controller,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
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
import { CreateReviewDto } from './dto/create-review.dto';
import { ReviewsService } from './reviews.service';

@ApiTags('Reviews')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('bookings')
export class ReviewsController {
  constructor(
    private readonly reviewsService: ReviewsService,
  ) {}

  @Post(':id/reviews')
  @Roles('CUSTOMER')
  @ApiOperation({
    summary: 'Submit a review for a completed booking',
    description:
      'Allows the authenticated customer to submit one review for their own completed booking. The provider rating is updated in the same transaction.',
  })
  @ApiCreatedResponse({
    description: 'Review submitted successfully.',
  })
  @ApiBadRequestResponse({
    description:
      'Booking ID, rating, or review comment is invalid.',
  })
  @ApiUnauthorizedResponse({
    description: 'Authentication is required.',
  })
  @ApiForbiddenResponse({
    description:
      'Only customers can submit reviews, and the booking must belong to the authenticated customer.',
  })
  @ApiNotFoundResponse({
    description: 'Booking or provider was not found.',
  })
  @ApiConflictResponse({
    description:
      'The booking is not completed or a review has already been submitted for this booking.',
  })
  createReview(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseBigIntIdPipe) bookingId: string,
    @Body() dto: CreateReviewDto,
  ) {
    return this.reviewsService.createReview(
      user.id,
      bookingId,
      dto,
    );
  }
}