import { Transform } from 'class-transformer';
import {
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  ValidateIf,
} from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class UpdateProviderDto {
  @ApiPropertyOptional({
    example: 'PawCare Center',
    description: 'Updated provider business name.',
    minLength: 2,
    maxLength: 200,
  })
  @ValidateIf((_, value) => value !== undefined)
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @MinLength(2)
  @MaxLength(200)
  businessName?: string;

  @ApiPropertyOptional({
    example: '123 Nguyen Van Linh, District 7, Ho Chi Minh City',
    description: 'Updated provider business address.',
  })
  @ValidateIf((_, value) => value !== undefined)
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @MinLength(5)
  address?: string;

  @ApiPropertyOptional({
    example: '0901234567',
    nullable: true,
    description:
      'Updated provider phone number. Send null to clear it.',
    maxLength: 20,
  })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  phone?: string | null;

  @ApiPropertyOptional({
    example: 'Professional pet care services.',
    nullable: true,
    description:
      'Updated provider description. Send null to clear it.',
  })
  @IsOptional()
  @IsString()
  description?: string | null;
}