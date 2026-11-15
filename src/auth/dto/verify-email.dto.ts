import { ApiProperty } from '@nestjs/swagger';
import { IsString, Matches } from 'class-validator';

import { USER_TOKEN_PATTERN } from '../auth-user-token.util';

export class VerifyEmailDto {
  @ApiProperty({
    description: 'E-mail verification token from the e-mailed link (`/verify-email#token=…`). Single use.',
    example: 'q3Jx0Yb3m1v8bZ9mVY6l2rT0cXyQ4n2hX1f7uW5kPZs',
    pattern: USER_TOKEN_PATTERN.source,
  })
  @IsString()
  @Matches(USER_TOKEN_PATTERN, { message: 'token is malformed' })
  token!: string;
}
