import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsEmail, MaxLength } from 'class-validator';

import { TurnstileTokenField } from './turnstile-token.field';

export class ForgotPasswordDto {
  @ApiProperty({
    example: 'customer@example.com',
    description: 'E-mail address of the account (trimmed and lower-cased, as for login).',
    maxLength: 255,
  })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
  @IsEmail()
  @MaxLength(255)
  email!: string;

  @TurnstileTokenField('forgot_password')
  turnstileToken?: string;
}
