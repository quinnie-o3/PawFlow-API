import { Transform } from 'class-transformer';
import { IsIn, IsOptional, IsString, MaxLength, ValidateIf } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class UpdateProviderStaffDto {
  @ApiPropertyOptional({
    example: 'Senior groomer',
    nullable: true,
    description: 'Updated staff position. Send null to clear it.',
    maxLength: 100,
  })
  @Transform(({ value }) => {
    if (value === null || value === undefined || typeof value !== 'string') {
      return value;
    }

    const trimmedValue = value.trim();
    return trimmedValue === '' ? null : trimmedValue;
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  position?: string | null;

  @ApiPropertyOptional({
    enum: ['ACTIVE', 'INACTIVE'],
    description: 'Updated staff assignment status.',
  })
  @ValidateIf((_, value) => value !== undefined)
  @IsIn(['ACTIVE', 'INACTIVE'])
  status?: 'ACTIVE' | 'INACTIVE';
}
