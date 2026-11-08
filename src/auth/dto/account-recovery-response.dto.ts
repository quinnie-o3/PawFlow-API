import { ApiProperty } from '@nestjs/swagger';

export const FORGOT_PASSWORD_MESSAGE =
  'If an account with this e-mail exists and is active, a password reset link has been sent.';

export const VERIFICATION_SENT_MESSAGE = 'A verification e-mail has been sent.';

/** Same body for every forgot-password request, whatever the account state. */
export class ForgotPasswordResponseDto {
  @ApiProperty({ example: FORGOT_PASSWORD_MESSAGE })
  message!: string;
}

export class VerificationEmailSentResponseDto {
  @ApiProperty({ example: VERIFICATION_SENT_MESSAGE })
  message!: string;

  @ApiProperty({ description: 'When the e-mailed link expires.', format: 'date-time', type: String })
  expiresAt!: Date;
}

export class VerifyEmailResponseDto {
  @ApiProperty({ example: true })
  emailVerified!: true;

  @ApiProperty({ format: 'date-time', type: String })
  emailVerifiedAt!: Date;
}
