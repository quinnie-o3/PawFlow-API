import { Transform } from 'class-transformer';
import { IsOptional, IsString, MaxLength, ValidateBy } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import { isPostgresBigIntId } from '../../common/pipes/parse-bigint-id.pipe';

export class CreateProviderStaffDto {
  @ApiProperty({
    example: '12',
    description: 'User ID of the account to assign as provider staff.',
  })
  @ValidateBy({
    name: 'isPostgresBigIntId',
    validator: {
      validate: (value: unknown) => isPostgresBigIntId(value),
      defaultMessage: () => 'userId must be a valid positive integer ID',
    },
  })
  userId!: string;

  @ApiPropertyOptional({
    example: 'Groomer',
    nullable: true,
    description: 'Optional staff position or job title.',
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
}
