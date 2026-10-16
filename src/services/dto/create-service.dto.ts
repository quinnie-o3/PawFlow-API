import { Transform, Type } from 'class-transformer';
import {
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateBy,
} from 'class-validator';
import {
  ApiProperty,
  ApiPropertyOptional,
} from '@nestjs/swagger';

import { isPostgresBigIntId } from '../../common/pipes/parse-bigint-id.pipe';

export class CreateServiceDto {
  @ApiProperty({
    example: '1',
    description: 'ID of the service category.',
  })
  @ValidateBy({
    name: 'isPostgresBigIntId',
    validator: {
      validate: (value: unknown) =>
        isPostgresBigIntId(value),
      defaultMessage: () =>
        'categoryId must be a valid positive integer ID',
    },
  })
  categoryId!: string;

  @ApiProperty({
    example: 'Basic Grooming',
    description: 'Service name.',
    minLength: 1,
    maxLength: 200,
  })
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name!: string;

  @ApiProperty({
    example: 150000,
    description: 'Service price.',
    minimum: 0,
  })
  @Type(() => Number)
  @IsNumber({
    maxDecimalPlaces: 2,
  })
  @Min(0)
  @Max(9999999999.99)
  price!: number;

  @ApiProperty({
    example: 60,
    description: 'Service duration in minutes.',
    minimum: 1,
  })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(2147483647)
  durationMinutes!: number;

  @ApiPropertyOptional({
    example: 'Bath, brushing, nail trimming and ear cleaning.',
    nullable: true,
    description: 'Optional service description.',
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
}