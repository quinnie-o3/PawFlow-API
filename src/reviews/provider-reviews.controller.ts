import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
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
import { paginatedSchema } from '../common/dto/paginated-schema';
import { ParseBigIntIdPipe } from '../common/pipes/parse-bigint-id.pipe';
import { CreateReviewResponseDto } from './dto/create-review-response.dto';
import {
  PROVIDER_REVIEW_RESPONDED_FILTERS,
  PROVIDER_REVIEW_SORTS,
  PROVIDER_REVIEW_VISIBILITY_FILTERS,
  ProviderReviewListQueryDto,
} from './dto/provider-review-list-query.dto';
import { PROVIDER_REVIEW_SCHEMA } from './provider-review-views';
import { ProviderReviewsService } from './provider-reviews.service';

/**
 * Provider feedback (P3-BE08). The provider is always the caller's own
 * (no provider id in the URL, query or body). Admins use /admin/reviews.
 */
@ApiTags('Provider Reviews')
@ApiBearerAuth('access-token')
@Controller('providers/me/reviews')
export class ProviderReviewsController {
  constructor(private readonly providerReviewsService: ProviderReviewsService) {}

  @Get()
  @Roles('PROVIDER_OWNER', 'PROVIDER_STAFF')
  @ApiOperation({
    summary: 'List the reviews of my provider',
    description:
      'Owner or ACTIVE staff. Includes reviews hidden by an administrator, flagged `isVisible: false` ' +
      '(they are never shown publicly and never count in the rating). Allowed in every provider status. ' +
      'Paginated with the standard `{ items, meta, query }` envelope; for stable paging pass `query.maxId` from the first page back as `maxId`.',
  })
  @ApiOkResponse({
    description: 'A page of the provider\'s reviews. An empty page (200) when there are none.',
    schema: paginatedSchema(PROVIDER_REVIEW_SCHEMA, {
      rating: { type: 'integer', nullable: true },
      visibility: { type: 'string', enum: [...PROVIDER_REVIEW_VISIBILITY_FILTERS] },
      responded: { type: 'string', enum: [...PROVIDER_REVIEW_RESPONDED_FILTERS] },
      sort: { type: 'string', enum: [...PROVIDER_REVIEW_SORTS] },
      maxId: { type: 'string', nullable: true, description: 'Snapshot anchor; null when the provider has no reviews.' },
    }),
  })
  @ApiBadRequestResponse({ description: 'Invalid page, limit, maxId, rating, visibility, responded or sort (or an unknown query parameter).' })
  @ApiUnauthorizedResponse({ description: 'Authentication is required (missing, expired or revoked session; inactive account).' })
  @ApiForbiddenResponse({ description: 'Not a provider owner or staff member, or staff without an ACTIVE association.' })
  @ApiNotFoundResponse({ description: 'Provider owner without a provider profile.' })
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: ProviderReviewListQueryDto,
  ) {
    return this.providerReviewsService.list(user, query);
  }

  @Post(':reviewId/response')
  @Roles('PROVIDER_OWNER')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Respond to a review of my provider',
    description:
      'Owner only; the provider must be APPROVED. One response per review, which cannot be edited or deleted. ' +
      'The responder is the authenticated user and the time is the database clock; neither can be supplied.',
  })
  @ApiCreatedResponse({ description: 'Response created; returns the review.', schema: PROVIDER_REVIEW_SCHEMA })
  @ApiBadRequestResponse({ description: 'Invalid review id, or text missing, blank, longer than 1000 characters, containing NUL, or any other property.' })
  @ApiUnauthorizedResponse({ description: 'Authentication is required (missing, expired or revoked session; inactive account).' })
  @ApiForbiddenResponse({ description: 'Not the provider owner (staff, customers, admins), or the provider is not APPROVED.' })
  @ApiNotFoundResponse({ description: 'Review not found (also for a review of another provider), or no provider profile.' })
  @ApiConflictResponse({ description: 'The review already has a response, or it is hidden.' })
  respond(
    @CurrentUser() user: AuthenticatedUser,
    @Param('reviewId', ParseBigIntIdPipe) reviewId: string,
    @Body() dto: CreateReviewResponseDto,
  ) {
    return this.providerReviewsService.respond(user, reviewId, dto.text);
  }
}
