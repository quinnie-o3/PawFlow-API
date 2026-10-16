import { Transform, Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateBy,
  ValidateIf,
} from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

import { isPostgresBigIntId } from '../../common/pipes/parse-bigint-id.pipe';

export class UpdateServiceDto {
  @ApiPropertyOptional({
    example: '2',
    description: 'Updated service category ID.',
  })
  @ValidateIf((_, value) => value !== undefined)
  @ValidateBy({
    name: 'isPostgresBigIntId',
    validator: {
      validate: (value: unknown) =>
        isPostgresBigIntId(value),
      defaultMessage: () =>
        'categoryId must be a valid positive integer ID',
    },
  })
  categoryId?: string;

  @ApiPropertyOptional({
    example: 'Premium Grooming',
    minLength: 1,
    maxLength: 200,
  })
  @ValidateIf((_, value) => value !== undefined)
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name?: string;

  @ApiPropertyOptional({
    example: 250000,
    minimum: 0,
  })
  @ValidateIf((_, value) => value !== undefined)
  @Type(() => Number)
  @IsNumber({
    maxDecimalPlaces: 2,
  })
  @Min(0)
  @Max(9999999999.99)
  price?: number;

  @ApiPropertyOptional({
    example: 90,
    minimum: 1,
  })
  @ValidateIf((_, value) => value !== undefined)
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(2147483647)
  durationMinutes?: number;

  @ApiPropertyOptional({
    example: 'Updated grooming package.',
    nullable: true,
    description: 'Send null to clear the description.',
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
  description?: string | null;

  @ApiPropertyOptional({
    example: 'ACTIVE',
    enum: ['ACTIVE', 'INACTIVE'],
  })
  @ValidateIf((_, value) => value !== undefined)
  @IsString()
  @IsIn(['ACTIVE', 'INACTIVE'])
  status?: 'ACTIVE' | 'INACTIVE';
}