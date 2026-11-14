import { Transform } from 'class-transformer';
import { IsOptional, IsString } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class AdminComplaintActionDto {
  @ApiPropertyOptional({
    nullable: true,
    description: 'Optional administrative note for this complaint action.',
  })
  @Transform(({ value }) => {
    if (value === null || value === undefined || typeof value !== 'string') {
      return value;
    }

    const trimmed = value.trim();

    return trimmed === '' ? null : trimmed;
  })
  @IsOptional()
  @IsString()
  adminNote?: string | null;
}
