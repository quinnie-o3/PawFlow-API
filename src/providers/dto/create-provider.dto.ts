import { Transform } from 'class-transformer';
import {
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import {
  ApiProperty,
  ApiPropertyOptional,
} from '@nestjs/swagger';

export class CreateProviderDto {
  @ApiProperty({
    example: 'PawCare Center',
    description: 'Provider business name.',
    minLength: 2,
    maxLength: 200,
  })
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @MinLength(2)
  @MaxLength(200)
  businessName!: string;

  @ApiProperty({
    example: '123 Nguyen Van Linh, District 7, Ho Chi Minh City',
    description: 'Provider business address.',
  })
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @MinLength(5)
  address!: string;

  @ApiPropertyOptional({
    example: '0901234567',
    description: 'Provider contact phone number.',
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

  @ApiPropertyOptional({
    example: 'Professional grooming and pet care services.',
    description: 'Provider business description.',
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
  description?: string;
}