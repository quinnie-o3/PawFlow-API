import { Transform } from 'class-transformer';
import {
  IsOptional,
  IsString,
  ValidateBy,
} from 'class-validator';
import {
  ApiProperty,
  ApiPropertyOptional,
} from '@nestjs/swagger';

import { isPostgresBigIntId } from '../../common/pipes/parse-bigint-id.pipe';

export class CreateBookingDto {
  @ApiProperty({
    example: '3',
    description: 'ID of the customer pet.',
  })
  @ValidateBy({
    name: 'isPostgresBigIntId',
    validator: {
      validate: (value: unknown) =>
        isPostgresBigIntId(value),
      defaultMessage: () =>
        'petId must be a valid positive integer ID',
    },
  })
  petId!: string;

  @ApiProperty({
    example: '12',
    description: 'ID of the selected availability slot.',
  })
  @ValidateBy({
    name: 'isPostgresBigIntId',
    validator: {
      validate: (value: unknown) =>
        isPostgresBigIntId(value),
      defaultMessage: () =>
        'slotId must be a valid positive integer ID',
    },
  })
  slotId!: string;

  @ApiPropertyOptional({
    example: 'Please handle my pet gently.',
    nullable: true,
    description: 'Optional note from the customer.',
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
  customerNote?: string | null;
}