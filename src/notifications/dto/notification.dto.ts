import { ApiPropertyOptional } from '@nestjs/swagger';
import type { SchemaObject } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsIn, IsInt, IsOptional, Max, Min, ValidateBy } from 'class-validator';

import { isPostgresBigIntId } from '../../common/pipes/parse-bigint-id.pipe';
import { SEARCH_DEFAULT_LIMIT, SEARCH_MAX_LIMIT, SEARCH_MAX_PAGE } from '../../common/utils/public-search.util';
import { toBigIntIdStringIfSafeInteger, toNumberIfNumericString } from '../../common/utils/strict-input.util';
import { NOTIFICATION_TARGET_TYPES, NOTIFICATION_TYPES } from '../notification-types';
import type { NotificationReadFilter } from '../notifications.service';

export const NOTIFICATION_READ_FILTERS = ['all', 'unread', 'read'] as const;

function IsBigIntId(property: string) {
  return ValidateBy({
    name: 'isBigIntId',
    validator: {
      validate: (value: unknown) => isPostgresBigIntId(value),
      defaultMessage: () => `${property} must be a valid positive integer ID`,
    },
  });
}

export class NotificationListQueryDto {
  @ApiPropertyOptional({ default: 1, minimum: 1, maximum: SEARCH_MAX_PAGE, description: '1-based page number.' })
  @IsOptional()
  @Transform(({ value }) => toNumberIfNumericString(value))
  @IsInt()
  @Min(1)
  @Max(SEARCH_MAX_PAGE)
  page: number = 1;

  @ApiPropertyOptional({ default: SEARCH_DEFAULT_LIMIT, minimum: 1, maximum: SEARCH_MAX_LIMIT, description: 'Page size.' })
  @IsOptional()
  @Transform(({ value }) => toNumberIfNumericString(value))
  @IsInt()
  @Min(1)
  @Max(SEARCH_MAX_LIMIT)
  limit: number = SEARCH_DEFAULT_LIMIT;

  @ApiPropertyOptional({ enum: NOTIFICATION_READ_FILTERS, default: 'all', description: 'Read-state filter.' })
  @IsOptional()
  @IsIn(NOTIFICATION_READ_FILTERS)
  status: NotificationReadFilter = 'all';

  @ApiPropertyOptional({
    type: String,
    example: '128',
    description:
      'Snapshot anchor for stable paging: only notifications with id <= maxId. Omit on the first page and pass back ' +
      '`query.maxId` from that response for the following pages, so new notifications do not shift them.',
  })
  @IsOptional()
  @IsBigIntId('maxId')
  maxId?: string;
}

export class MarkAllNotificationsReadDto {
  @ApiPropertyOptional({
    type: String,
    example: '128',
    description:
      'Optional upper bound: mark only notifications with id <= upToId (e.g. the newest one the user has seen), ' +
      'so notifications that arrive meanwhile stay unread. Omit to mark every unread notification.',
  })
  @IsOptional()
  @Transform(({ value }) => toBigIntIdStringIfSafeInteger(value))
  @IsBigIntId('upToId')
  upToId?: string;
}

export const NOTIFICATION_SCHEMA: SchemaObject = {
  type: 'object',
  required: ['id', 'type', 'title', 'body', 'payload', 'target', 'isRead', 'readAt', 'createdAt'],
  properties: {
    id: { type: 'string', example: '128', description: 'BIGINT id as a string.' },
    type: { type: 'string', enum: NOTIFICATION_TYPES, example: 'BOOKING_CONFIRMED' },
    title: { type: 'string', maxLength: 150, example: 'Booking confirmed' },
    body: { type: 'string', maxLength: 1000, example: 'Your grooming appointment on 12 Dec at 09:00 was confirmed.' },
    payload: {
      type: 'object',
      additionalProperties: { oneOf: [{ type: 'string' }, { type: 'number' }, { type: 'boolean' }], nullable: true },
      description: 'Flat display data captured when the notification was created (may be {}). Never contains URLs or secrets.',
      example: { serviceName: 'Full grooming', startTime: '2026-12-12T09:00:00+07:00' },
    },
    target: {
      type: 'object',
      nullable: true,
      required: ['type', 'id'],
      properties: {
        type: { type: 'string', enum: [...NOTIFICATION_TARGET_TYPES] },
        id: { type: 'string', example: '42' },
      },
      description:
        'Related record for in-app navigation (null for announcements). Not an access grant: open it through the normal endpoint, which may answer 404.',
    },
    isRead: { type: 'boolean' },
    readAt: { type: 'string', format: 'date-time', nullable: true },
    createdAt: { type: 'string', format: 'date-time' },
  },
};
