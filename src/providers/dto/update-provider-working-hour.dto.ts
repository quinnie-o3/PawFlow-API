import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsInt,
  Matches,
  Max,
  Min,
  ValidateIf,
} from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class UpdateProviderWorkingHourDto {
  @ApiPropertyOptional({
    example: 1,
    minimum: 0,
    maximum: 6,
    description:
      'Day of week. 0 = Sunday, 1 = Monday, ..., 6 = Saturday.',
  })
  @ValidateIf((_, value) => value !== undefined)
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(6)
  dayOfWeek?: number;

  @ApiPropertyOptional({
    example: '09:00',
    description: 'Opening time in HH:mm 24-hour format.',
  })
  @ValidateIf((_, value) => value !== undefined)
  @Matches(/^([01]\d|2[0-3]):[0-5]\d$/, {
    message:
      'startTime must be a valid time in HH:mm format',
  })
  startTime?: string;

  @ApiPropertyOptional({
    example: '18:00',
    description: 'Closing time in HH:mm 24-hour format.',
  })
  @ValidateIf((_, value) => value !== undefined)
  @Matches(/^([01]\d|2[0-3]):[0-5]\d$/, {
    message:
      'endTime must be a valid time in HH:mm format',
  })
  endTime?: string;

  @ApiPropertyOptional({
    example: false,
    description:
      'Whether this working-hour entry is active.',
  })
  @ValidateIf((_, value) => value !== undefined)
  @IsBoolean()
  isActive?: boolean;
}