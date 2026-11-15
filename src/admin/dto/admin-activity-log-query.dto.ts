import { Transform } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  Max,
  Min,
  ValidateBy,
} from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

import {
  ADMIN_ACTIVITY_ACTIONS,
  ADMIN_ACTIVITY_TARGET_TYPES,
  type AdminActivityAction,
  type AdminActivityTargetType,
} from '../admin-activity-log.constants';
import { isPostgresBigIntId } from '../../common/pipes/parse-bigint-id.pipe';
import { IsCalendarDateTime } from '../../common/utils/calendar-date.util';
import { toNumberIfNumericString } from '../../common/utils/strict-input.util';

const DATE_TIME_FILTER_DESCRIPTION =
  'ISO 8601 date-time: YYYY-MM-DD (UTC midnight) or YYYY-MM-DDTHH:mm[:ss[.sss]] with optional Z or ±HH:MM offset (no offset = server local time).';

export class AdminActivityLogQueryDto {
  @ApiPropertyOptional({ enum: ADMIN_ACTIVITY_ACTIONS })
  @IsOptional()
  @IsIn(ADMIN_ACTIVITY_ACTIONS)
  action?: AdminActivityAction;

  @ApiPropertyOptional({ enum: ADMIN_ACTIVITY_TARGET_TYPES })
  @IsOptional()
  @IsIn(ADMIN_ACTIVITY_TARGET_TYPES)
  targetType?: AdminActivityTargetType;

  @ApiPropertyOptional({ example: '1' })
  @IsOptional()
  @ValidateBy({
    name: 'isPostgresBigIntId',
    validator: {
      validate: (value: unknown) => isPostgresBigIntId(value),
      defaultMessage: () => 'targetId must be a valid positive integer ID',
    },
  })
  targetId?: string;

  @ApiPropertyOptional({ example: '1' })
  @IsOptional()
  @ValidateBy({
    name: 'isPostgresBigIntId',
    validator: {
      validate: (value: unknown) => isPostgresBigIntId(value),
      defaultMessage: () => 'adminUserId must be a valid positive integer ID',
    },
  })
  adminUserId?: string;

  @ApiPropertyOptional({
    format: 'date-time',
    example: '2026-10-01T00:00:00+07:00',
    description: `Inclusive lower bound on createdAt. ${DATE_TIME_FILTER_DESCRIPTION}`,
  })
  @IsOptional()
  @IsCalendarDateTime()
  from?: string;

  @ApiPropertyOptional({
    format: 'date-time',
    example: '2026-10-31T23:59:59+07:00',
    description: `Inclusive upper bound on createdAt. ${DATE_TIME_FILTER_DESCRIPTION}`,
  })
  @IsOptional()
  @IsCalendarDateTime()
  to?: string;

  @ApiPropertyOptional({ default: 50, minimum: 1, maximum: 100 })
  @IsOptional()
  @Transform(({ value }) => toNumberIfNumericString(value))
  @IsInt()
  @Min(1)
  @Max(100)
  limit: number = 50;

  @ApiPropertyOptional({ default: 0, minimum: 0 })
  @IsOptional()
  @Transform(({ value }) => toNumberIfNumericString(value))
  @IsInt()
  @Min(0)
  offset: number = 0;
}
