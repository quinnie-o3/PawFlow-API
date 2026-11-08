import { ApiProperty } from '@nestjs/swagger';
import { IsString, Matches, MaxLength, MinLength } from 'class-validator';

import { USER_TOKEN_PATTERN } from '../auth-user-token.util';
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from '../password-policy';

export class ResetPasswordDto {
  @ApiProperty({
    description: 'Password-reset token from the e-mailed link (`/reset-password#token=…`). Single use.',
    example: 'q3Jx0Yb3m1v8bZ9mVY6l2rT0cXyQ4n2hX1f7uW5kPZs',
    pattern: USER_TOKEN_PATTERN.source,
  })
  @IsString()
  @Matches(USER_TOKEN_PATTERN, { message: 'token is malformed' })
  token!: string;

  @ApiProperty({
    example: 'EvenStrongerPassword456',
    description: 'The new password (same policy as registration).',
    minLength: PASSWORD_MIN_LENGTH,
    maxLength: PASSWORD_MAX_LENGTH,
  })
  @IsString()
  @MinLength(PASSWORD_MIN_LENGTH)
  @MaxLength(PASSWORD_MAX_LENGTH)
  newPassword!: string;
}
