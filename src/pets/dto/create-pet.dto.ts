import { Transform, Type } from 'class-transformer';
import {
  IsDateString,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  Max,
  MaxLength,
  MinLength,
  ValidateBy,
} from 'class-validator';
import {
  ApiProperty,
  ApiPropertyOptional,
} from '@nestjs/swagger';

import { isPostgresBigIntId } from '../../common/pipes/parse-bigint-id.pipe';

export class CreatePetDto {
  @ApiProperty({
    example: '1',
    description: 'ID of the pet type.',
  })
  @ValidateBy({
    name: 'isPostgresBigIntId',
    validator: {
      validate: (value: unknown) => isPostgresBigIntId(value),
      defaultMessage: () => 'petTypeId must be a valid positive integer ID',
    },
  })
  petTypeId!: string;

  @ApiProperty({
    example: 'Milo',
    description: 'Pet name.',
    minLength: 1,
    maxLength: 100,
  })
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name!: string;

  @ApiPropertyOptional({
    example: 'Golden Retriever',
    description: 'Pet breed.',
    maxLength: 100,
  })
  @Transform(({ value }) => {
    if (typeof value !== 'string') {
      return value;
    }

    const trimmedValue = value.trim();

    return trimmedValue === '' ? undefined : trimmedValue;
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  breed?: string;

  @ApiPropertyOptional({
    example: '2023-05-20',
    description: 'Pet date of birth in YYYY-MM-DD format.',
    format: 'date',
  })
  @IsOptional()
  @IsDateString()
  birthDate?: string;

  @ApiPropertyOptional({
    example: 5.5,
    description: 'Pet weight. Must be greater than 0.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({
    maxDecimalPlaces: 2,
  })
  @IsPositive()
  @Max(9999.99)
  weight?: number;

  @ApiPropertyOptional({
    example: 'Allergic to chicken.',
    description: 'Optional health-related notes about the pet.',
  })
  @Transform(({ value }) => {
    if (typeof value !== 'string') {
      return value;
    }

    const trimmedValue = value.trim();

    return trimmedValue === '' ? undefined : trimmedValue;
  })
  @IsOptional()
  @IsString()
  healthNote?: string;
}