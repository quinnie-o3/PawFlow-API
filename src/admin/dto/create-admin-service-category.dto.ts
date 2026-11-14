import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

export class CreateAdminServiceCategoryDto {
  @ApiProperty({ description: 'Unique service category name.' })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @IsNotEmpty()
  @MaxLength(150)
  name!: string;

  @ApiPropertyOptional({
    nullable: true,
    description: 'Optional category description.',
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
  description?: string | null;
}
