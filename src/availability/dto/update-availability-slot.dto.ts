import { Transform } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsString,
  Matches,
  Max,
  Min,
  ValidateBy,
  ValidateIf,
} from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

import { isPostgresBigIntId } from '../../common/pipes/parse-bigint-id.pipe';
import { toBigIntIdStringIfSafeInteger, toNumberIfNumericString } from '../../common/utils/strict-input.util';
import { IsCalendarDate } from '../../common/utils/calendar-date.util';

export class UpdateAvailabilitySlotDto {
  @ApiPropertyOptional({
    example: '2',
    description: 'Updated service ID.',
  })
  @ValidateIf((_, value) => value !== undefined)
  @Transform(({ value }) => toBigIntIdStringIfSafeInteger(value))
  @ValidateBy({
    name: 'isPostgresBigIntId',
    validator: {
      validate: (value: unknown) =>
        isPostgresBigIntId(value),
      defaultMessage: () =>
        'serviceId must be a valid positive integer ID',
    },
  })
  serviceId?: string;

  @ApiPropertyOptional({
    example: '2026-10-21',
    description: 'Updated slot date.',
    format: 'date',
  })
  @ValidateIf((_, value) => value !== undefined)
  @IsCalendarDate()
  slotDate?: string;

  @ApiPropertyOptional({
    example: '10:00',
  })
  @ValidateIf((_, value) => value !== undefined)
  @Matches(/^([01]\d|2[0-3]):[0-5]\d$/, {
    message:
      'startTime must be a valid time in HH:mm format',
  })
  startTime?: string;

  @ApiPropertyOptional({
    example: '11:00',
  })
  @ValidateIf((_, value) => value !== undefined)
  @Matches(/^([01]\d|2[0-3]):[0-5]\d$/, {
    message:
      'endTime must be a valid time in HH:mm format',
  })
  endTime?: string;

  @ApiPropertyOptional({
    example: 5,
    minimum: 1,
  })
  @ValidateIf((_, value) => value !== undefined)
  @Transform(({ value }) => toNumberIfNumericString(value))
  @IsInt()
  @Min(1)
  @Max(2147483647)
  capacity?: number;

  @ApiPropertyOptional({
    example: 'OPEN',
    enum: ['OPEN', 'CLOSED', 'CANCELLED'],
  })
  @ValidateIf((_, value) => value !== undefined)
  @IsString()
  @IsIn(['OPEN', 'CLOSED', 'CANCELLED'])
  status?: 'OPEN' | 'CLOSED' | 'CANCELLED';
}