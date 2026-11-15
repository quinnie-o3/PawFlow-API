import { ApiProperty } from '@nestjs/swagger';
import { IsString, Matches } from 'class-validator';

import { REFRESH_TOKEN_PATTERN } from '../auth-session.util';

export class RefreshTokenDto {
  @ApiProperty({
    description:
      'Refresh token returned by login, register or the previous refresh. Each token can be used once.',
    example: 'q3Jx0Yb3m1v8bZ9mVY6l2rT0cXyQ4n2hX1f7uW5kPZs',
    pattern: REFRESH_TOKEN_PATTERN.source,
  })
  @IsString()
  @Matches(REFRESH_TOKEN_PATTERN, { message: 'refreshToken is malformed' })
  refreshToken!: string;
}
