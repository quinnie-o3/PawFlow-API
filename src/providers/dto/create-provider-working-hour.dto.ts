import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsInt,
  IsOptional,
  Matches,
  Max,
  Min,
} from 'class-validator';
import {
  ApiProperty,
  ApiPropertyOptional,
} from '@nestjs/swagger';

export class CreateProviderWorkingHourDto {
  @ApiProperty({
    example: 1,
    description:
      'Day of week. 0 = Sunday, 1 = Monday, ..., 6 = Saturday.',
    minimum: 0,
    maximum: 6,
  })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(6)
  dayOfWeek!: number;

  @ApiProperty({
    example: '08:00',
    description: 'Opening time in HH:mm 24-hour format.',
  })
  @Matches(/^([01]\d|2[0-3]):[0-5]\d$/, {
    message:
      'startTime must be a valid time in HH:mm format',
  })
  startTime!: string;

  @ApiProperty({
    example: '17:30',
    description: 'Closing time in HH:mm 24-hour format.',
  })
  @Matches(/^([01]\d|2[0-3]):[0-5]\d$/, {
    message:
      'endTime must be a valid time in HH:mm format',
  })
  endTime!: string;

  @ApiPropertyOptional({
    example: true,
    default: true,
    description:
      'Whether this working-hour entry is currently active.',
  })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}