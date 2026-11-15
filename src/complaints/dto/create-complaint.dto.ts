import { Transform } from 'class-transformer';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export const COMPLAINT_REASON_MAX_LENGTH = 2000;

export class CreateComplaintDto {
  @ApiProperty({
    example: 'The service did not match the booking description.',
    description:
      'Reason or description of the complaint. Leading and trailing whitespace is trimmed; must not be empty.',
    minLength: 1,
    maxLength: COMPLAINT_REASON_MAX_LENGTH,
  })
  @Transform(({ value }) => {
    if (typeof value !== 'string') {
      return value;
    }

    return value.trim();
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(COMPLAINT_REASON_MAX_LENGTH)
  reason!: string;
}