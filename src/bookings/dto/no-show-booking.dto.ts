import { Transform } from 'class-transformer';
import { IsOptional, IsString } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class NoShowBookingDto {
  @ApiPropertyOptional({
    example: 'The customer did not arrive for the appointment.',
    nullable: true,
    description: 'Optional reason for recording the booking as a no-show.',
  })
  @Transform(({ value }) => {
    if (value === null || value === undefined) {
      return value;
    }

    if (typeof value !== 'string') {
      return value;
    }

    const trimmed = value.trim();

    return trimmed === '' ? null : trimmed;
  })
  @IsOptional()
  @IsString()
  reason?: string | null;
}
