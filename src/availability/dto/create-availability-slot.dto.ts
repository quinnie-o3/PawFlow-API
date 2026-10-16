import { Type } from 'class-transformer';
import {
  IsDateString,
  IsInt,
  Matches,
  Max,
  Min,
  ValidateBy,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

import { isPostgresBigIntId } from '../../common/pipes/parse-bigint-id.pipe';

export class CreateAvailabilitySlotDto {
  @ApiProperty({
    example: '1',
    description: 'ID of the service offered in this slot.',
  })
  @ValidateBy({
    name: 'isPostgresBigIntId',
    validator: {
      validate: (value: unknown) =>
        isPostgresBigIntId(value),
      defaultMessage: () =>
        'serviceId must be a valid positive integer ID',
    },
  })
  serviceId!: string;

  @ApiProperty({
    example: '2026-10-20',
    description: 'Slot date in YYYY-MM-DD format.',
    format: 'date',
  })
  @IsDateString()
  slotDate!: string;

  @ApiProperty({
    example: '09:00',
    description: 'Slot start time in HH:mm 24-hour format.',
  })
  @Matches(/^([01]\d|2[0-3]):[0-5]\d$/, {
    message:
      'startTime must be a valid time in HH:mm format',
  })
  startTime!: string;

  @ApiProperty({
    example: '10:00',
    description: 'Slot end time in HH:mm 24-hour format.',
  })
  @Matches(/^([01]\d|2[0-3]):[0-5]\d$/, {
    message:
      'endTime must be a valid time in HH:mm format',
  })
  endTime!: string;

  @ApiProperty({
    example: 3,
    description: 'Maximum number of bookings for this slot.',
    minimum: 1,
  })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(2147483647)
  capacity!: number;
}