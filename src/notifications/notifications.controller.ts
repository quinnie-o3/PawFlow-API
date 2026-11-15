import { Body, Controller, Get, HttpCode, HttpStatus, Param, Patch, Query, UseGuards } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiBody,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';

import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { paginatedSchema } from '../common/dto/paginated-schema';
import { ParseBigIntIdPipe } from '../common/pipes/parse-bigint-id.pipe';
import { MarkAllNotificationsReadDto, NOTIFICATION_READ_FILTERS, NOTIFICATION_SCHEMA, NotificationListQueryDto } from './dto/notification.dto';
import { NotificationsService } from './notifications.service';

const UNAUTHORIZED = 'Access token is missing, invalid, expired or its session was revoked.';
const NOT_FOUND = 'No such notification for this user. Notifications of other users are indistinguishable from missing ones.';

/**
 * P3-BE04 notification inbox of the authenticated user (any role). The
 * recipient is always the caller; no endpoint accepts a user id, and there
 * is no public endpoint that creates notifications.
 */
@ApiTags('Notifications')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard)
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  @ApiOperation({
    summary: 'List my notifications',
    description:
      'Newest first (by id). Paginated with the standard `{ items, meta, query }` envelope. For stable paging pass `query.maxId` from the first page back as `maxId`.',
  })
  @ApiOkResponse({
    description: 'A page of the caller\'s notifications.',
    schema: paginatedSchema(NOTIFICATION_SCHEMA, {
      status: { type: 'string', enum: [...NOTIFICATION_READ_FILTERS] },
      maxId: { type: 'string', nullable: true, description: 'Snapshot anchor applied; null for an empty inbox.' },
    }),
  })
  @ApiBadRequestResponse({ description: 'Invalid page, limit, status or maxId (or an unknown query parameter).' })
  @ApiUnauthorizedResponse({ description: UNAUTHORIZED })
  list(@CurrentUser() user: AuthenticatedUser, @Query() query: NotificationListQueryDto) {
    return this.notifications.list(user.id, query);
  }

  @Get('unread-count')
  @ApiOperation({ summary: 'Count my unread notifications', description: 'Exact count of the caller\'s notifications with readAt = null.' })
  @ApiOkResponse({ schema: { type: 'object', required: ['unreadCount'], properties: { unreadCount: { type: 'integer', example: 3 } } } })
  @ApiUnauthorizedResponse({ description: UNAUTHORIZED })
  unreadCount(@CurrentUser() user: AuthenticatedUser) {
    return this.notifications.unreadCount(user.id);
  }

  @Patch('read-all')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Mark my notifications as read',
    description: 'Marks the caller\'s unread notifications as read (optionally only up to `upToId`). Idempotent; never touches other users\' notifications.',
  })
  @ApiBody({ type: MarkAllNotificationsReadDto, required: false })
  @ApiOkResponse({
    schema: {
      type: 'object',
      required: ['markedCount', 'unreadCount'],
      properties: {
        markedCount: { type: 'integer', example: 5, description: 'Notifications changed by this request (0 when repeated).' },
        unreadCount: { type: 'integer', example: 0, description: 'Unread notifications remaining afterwards.' },
      },
    },
  })
  @ApiBadRequestResponse({ description: 'upToId is not a valid id, or unknown body fields.' })
  @ApiUnauthorizedResponse({ description: UNAUTHORIZED })
  markAllRead(@CurrentUser() user: AuthenticatedUser, @Body() dto: MarkAllNotificationsReadDto) {
    return this.notifications.markAllRead(user.id, dto?.upToId);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get one of my notifications', description: 'Does NOT mark it as read; call PATCH /notifications/:id/read explicitly.' })
  @ApiOkResponse({ schema: NOTIFICATION_SCHEMA })
  @ApiBadRequestResponse({ description: 'id is not a valid positive integer.' })
  @ApiUnauthorizedResponse({ description: UNAUTHORIZED })
  @ApiNotFoundResponse({ description: NOT_FOUND })
  findOne(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseBigIntIdPipe) id: string) {
    return this.notifications.findOne(user.id, id);
  }

  @Patch(':id/read')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Mark one of my notifications as read',
    description: 'Idempotent: an already read notification is returned unchanged (original readAt).',
  })
  @ApiOkResponse({ schema: NOTIFICATION_SCHEMA })
  @ApiBadRequestResponse({ description: 'id is not a valid positive integer.' })
  @ApiUnauthorizedResponse({ description: UNAUTHORIZED })
  @ApiNotFoundResponse({ description: NOT_FOUND })
  markRead(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseBigIntIdPipe) id: string) {
    return this.notifications.markRead(user.id, id);
  }
}
