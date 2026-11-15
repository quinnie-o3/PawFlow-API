import { Transform } from 'class-transformer';
import {
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  ValidateIf,
} from 'class-validator';
import {
  ApiPropertyOptional,
} from '@nestjs/swagger';

export class UpdateUserProfileDto {
  @ApiPropertyOptional({
    example: 'Nguyen Van A',
    description: 'Updated full name.',
    minLength: 2,
    maxLength: 150,
  })
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  // full_name is NOT NULL: allow omitting it, but validate an explicit null.
  @ValidateIf((_object, value) => value !== undefined)
  @IsString()
  @MinLength(2)
  @MaxLength(150)
  fullName?: string;

  @ApiPropertyOptional({
    example: '0901234567',
    description: 'Updated phone number.',
    maxLength: 20,
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
  @MaxLength(20)
  phone?: string;
}