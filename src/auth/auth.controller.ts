import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { Request } from 'express';

import { RetryAfterFilter } from '../common/filters/retry-after.filter';
import { AccountRecoveryService } from './account-recovery.service';
import { AuthService, type SessionClientInfo } from './auth.service';
import { CurrentUser } from './decorators/current-user.decorator';
import {
  FORGOT_PASSWORD_MESSAGE,
  ForgotPasswordResponseDto,
  VERIFICATION_SENT_MESSAGE,
  VerificationEmailSentResponseDto,
  VerifyEmailResponseDto,
} from './dto/account-recovery-response.dto';
import { ChangePasswordDto } from './dto/change-password.dto';
import { ForgotPasswordDto } from './dto/forgot-password.dto';
import { LoginDto } from './dto/login.dto';
import { RefreshTokenDto } from './dto/refresh-token.dto';
import { RegisterDto } from './dto/register.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { VerifyEmailDto } from './dto/verify-email.dto';
import { EmailVerificationService } from './email-verification.service';
import { TURNSTILE_ACTIONS } from './bot-protection/turnstile.config';
import { TurnstileService } from './bot-protection/turnstile.service';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { AuthRateLimitGuard, RateLimit } from './rate-limit/auth-rate-limit.guard';
import type { AuthenticatedUser } from './interfaces/authenticated-user.interface';

const AUTH_RESPONSE_DESCRIPTION =
  '`{ accessToken, tokenType: "Bearer", expiresIn, refreshToken, refreshTokenExpiresAt, user }`. ' +
  '`accessToken` is a short-lived JWT (`expiresIn` seconds, default 900) bound to a session; ' +
  '`refreshToken` is an opaque single-use token for `POST /auth/refresh`, valid until `refreshTokenExpiresAt` (absolute session expiry).';

function clientInfo(request: Request): SessionClientInfo {
  const userAgent = request.headers['user-agent'];

  return {
    userAgent: typeof userAgent === 'string' ? userAgent : null,
    ipAddress: request.ip ?? null,
  };
}

// P3-BE03 shared error documentation for the bot-protected endpoints.
const BOT_FORBIDDEN =
  'Bot verification failed (only when TURNSTILE_MODE=enforce). `code`: `TURNSTILE_REQUIRED` (no token), ' +
  '`TURNSTILE_INVALID` (rejected, wrong hostname or action), `TURNSTILE_EXPIRED` (older than 300 s or already used). ' +
  'Reset the widget and retry with a fresh token. Nothing was changed.';
const RATE_LIMITED =
  'Too many requests (`code: RATE_LIMITED`). The `Retry-After` header and `retryAfterSeconds` give the wait in seconds. Nothing was changed.';
const BOT_UNAVAILABLE =
  'Verification temporarily unavailable (`code: TURNSTILE_UNAVAILABLE` or `RATE_LIMIT_UNAVAILABLE`); fails closed. ' +
  'Retry after `Retry-After` seconds with a fresh Turnstile token. Nothing was changed.';

@ApiTags('Authentication')
@Controller('auth')
@UseFilters(RetryAfterFilter)
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly accountRecoveryService: AccountRecoveryService,
    private readonly emailVerificationService: EmailVerificationService,
    private readonly turnstile: TurnstileService,
  ) {}

  @Post('register')
  @UseGuards(AuthRateLimitGuard)
  @RateLimit('register')
  @ApiOperation({
    summary: 'Register a customer account',
    description:
      'Creates a new active CUSTOMER account and opens a session. Role cannot be selected by the registering user.',
  })
  @ApiCreatedResponse({
    description: `Account registered and session opened: ${AUTH_RESPONSE_DESCRIPTION}`,
  })
  @ApiBadRequestResponse({
    description:
      'Request validation failed or unsupported fields were provided.',
  })
  @ApiConflictResponse({
    description: 'An account with the same email already exists.',
  })
  @ApiForbiddenResponse({ description: BOT_FORBIDDEN })
  @ApiTooManyRequestsResponse({ description: RATE_LIMITED })
  @ApiServiceUnavailableResponse({ description: BOT_UNAVAILABLE })
  async register(@Body() registerDto: RegisterDto, @Req() request: Request) {
    // P3-BE03: verified after validation, before any user/session is created.
    await this.turnstile.verify(registerDto.turnstileToken, TURNSTILE_ACTIONS.register, request.ip);

    return this.authService.register(registerDto, clientInfo(request));
  }

  @Post('login')
  @HttpCode(HttpStatus.OK)
  @UseGuards(AuthRateLimitGuard)
  @RateLimit('login')
  @ApiOperation({
    summary: 'Log in',
    description:
      'Authenticates an active account and opens a new session (one per login; other sessions are not affected).',
  })
  @ApiOkResponse({
    description: `Authentication successful: ${AUTH_RESPONSE_DESCRIPTION}`,
  })
  @ApiBadRequestResponse({
    description: 'Request validation failed.',
  })
  @ApiUnauthorizedResponse({
    description:
      'Invalid credentials or the account is not active (suspended accounts cannot log in).',
  })
  @ApiForbiddenResponse({ description: BOT_FORBIDDEN })
  @ApiTooManyRequestsResponse({ description: RATE_LIMITED })
  @ApiServiceUnavailableResponse({ description: BOT_UNAVAILABLE })
  async login(@Body() loginDto: LoginDto, @Req() request: Request) {
    // P3-BE03: verified before the password is checked or a session opened.
    await this.turnstile.verify(loginDto.turnstileToken, TURNSTILE_ACTIONS.login, request.ip);

    return this.authService.login(loginDto, clientInfo(request));
  }

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Rotate the refresh token',
    description:
      'Exchanges a refresh token for a new access token and a new refresh token of the same session. ' +
      'Each refresh token can be used once: presenting an already used token is treated as theft and revokes the whole session. ' +
      'Clients must therefore serialize refreshes (one in flight at a time) and always store the newest refresh token. ' +
      'No access token is required.',
  })
  @ApiOkResponse({ description: `Tokens rotated: ${AUTH_RESPONSE_DESCRIPTION}` })
  @ApiBadRequestResponse({ description: 'refreshToken is missing or malformed.' })
  @ApiUnauthorizedResponse({
    description:
      'Unknown, expired or revoked session; refresh token reuse (the session is now revoked); or the account is no longer active.',
  })
  refresh(@Body() dto: RefreshTokenDto, @Req() request: Request) {
    return this.authService.refresh(dto.refreshToken, clientInfo(request));
  }

  @Post('logout')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Log out of the current session',
    description:
      'Revokes the session of the access token used for this request. Its access and refresh tokens stop working immediately. Other sessions are not affected.',
  })
  @ApiNoContentResponse({ description: 'Session revoked.' })
  @ApiUnauthorizedResponse({ description: 'Access token is missing, invalid, expired or already revoked.' })
  async logout(@CurrentUser() user: AuthenticatedUser): Promise<void> {
    await this.authService.logout(user);
  }

  @Post('logout-all')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Log out of every session',
    description: 'Revokes all sessions of the authenticated user, including the current one.',
  })
  @ApiNoContentResponse({ description: 'All sessions revoked.' })
  @ApiUnauthorizedResponse({ description: 'Access token is missing, invalid, expired or already revoked.' })
  async logoutAll(@CurrentUser() user: AuthenticatedUser): Promise<void> {
    await this.authService.logoutAll(user);
  }

  @Get('sessions')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'List my active sessions',
    description:
      'Returns the active (not revoked, not expired) sessions of the authenticated user, most recently used first. `current` marks the session of this request.',
  })
  @ApiOkResponse({
    description: 'Active sessions.',
    schema: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'createdAt', 'lastUsedAt', 'expiresAt', 'userAgent', 'ipAddress', 'current'],
        properties: {
          id: { type: 'string', format: 'uuid' },
          createdAt: { type: 'string', format: 'date-time' },
          lastUsedAt: { type: 'string', format: 'date-time', description: 'Login or last refresh.' },
          expiresAt: { type: 'string', format: 'date-time' },
          userAgent: { type: 'string', nullable: true },
          ipAddress: { type: 'string', nullable: true },
          current: { type: 'boolean' },
        },
      },
    },
  })
  @ApiUnauthorizedResponse({ description: 'Access token is missing, invalid, expired or revoked.' })
  listSessions(@CurrentUser() user: AuthenticatedUser) {
    return this.authService.listSessions(user);
  }

  @Delete('sessions/:id')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Revoke one of my sessions',
    description:
      'Revokes the given session of the authenticated user (e.g. "sign out that device"). Revoking an already revoked own session is a no-op.',
  })
  @ApiNoContentResponse({ description: 'Session revoked.' })
  @ApiBadRequestResponse({ description: 'Session id is not a UUID.' })
  @ApiUnauthorizedResponse({ description: 'Access token is missing, invalid, expired or revoked.' })
  @ApiNotFoundResponse({ description: 'No such session for this user (other users\' sessions are indistinguishable from missing ones).' })
  async revokeSession(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) sessionId: string,
  ): Promise<void> {
    await this.authService.revokeOwnSession(user, sessionId);
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Get current authenticated user',
    description:
      'Returns information about the account associated with the supplied JWT access token.',
  })
  @ApiOkResponse({
    description: 'Current authenticated user returned successfully.',
  })
  @ApiUnauthorizedResponse({
    description:
      'Bearer token is missing, invalid, expired, revoked, or belongs to an unavailable account.',
  })
  me(@CurrentUser() user: AuthenticatedUser) {
    const { sessionId: _sessionId, emailVerifiedAt, ...profile } = user;

    return {
      user: {
        ...profile,
        // P3-BE02 (additive): informational, not enforced anywhere.
        emailVerified: Boolean(emailVerifiedAt),
        emailVerifiedAt: emailVerifiedAt ?? null,
      },
    };
  }

  // ------------------------------------------------------------ P3-BE02

  @Post('change-password')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Change my password',
    description:
      'Verifies the current password and sets a new one (8-72 characters, must differ from the current password). ' +
      'On success EVERY session of the user is revoked, including the current one (reason PASSWORD_CHANGED), ' +
      'and any outstanding password-reset link stops working. The client must log in again with the new password.',
  })
  @ApiNoContentResponse({ description: 'Password changed; all sessions revoked.' })
  @ApiBadRequestResponse({
    description:
      'Validation failed, `Current password is incorrect`, or `New password must be different from the current password`. Nothing changed.',
  })
  @ApiUnauthorizedResponse({
    description: 'Access token missing/invalid/revoked, or the account is not active. Nothing changed.',
  })
  @ApiConflictResponse({ description: 'The password was changed concurrently by another request. Nothing changed.' })
  async changePassword(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: ChangePasswordDto,
  ): Promise<void> {
    await this.accountRecoveryService.changePassword(user, dto);
  }

  @Post('forgot-password')
  @HttpCode(HttpStatus.ACCEPTED)
  @UseGuards(AuthRateLimitGuard)
  @RateLimit('forgot-password')
  @ApiOperation({
    summary: 'Request a password reset link',
    description:
      'Always returns the same 202 body, whether or not an account exists for the address, so it cannot be used to discover accounts. ' +
      'For an ACTIVE account a single-use reset link is e-mailed (valid 30 minutes by default); it supersedes earlier links. ' +
      'Repeated requests within the cooldown (60 s by default) do not send another e-mail. Suspended/inactive accounts receive nothing.',
  })
  @ApiAcceptedResponse({ type: ForgotPasswordResponseDto, description: 'Request accepted (identical for every address).' })
  @ApiBadRequestResponse({ description: 'The body is not a valid e-mail address.' })
  @ApiForbiddenResponse({ description: BOT_FORBIDDEN })
  @ApiTooManyRequestsResponse({ description: `${RATE_LIMITED} Limits are counted per client IP and per e-mail string, whether or not an account exists.` })
  @ApiServiceUnavailableResponse({ description: BOT_UNAVAILABLE })
  async forgotPassword(@Body() dto: ForgotPasswordDto, @Req() request: Request): Promise<ForgotPasswordResponseDto> {
    // P3-BE03: verified before the account lookup, so the outcome never
    // depends on whether the address belongs to an account.
    await this.turnstile.verify(dto.turnstileToken, TURNSTILE_ACTIONS.forgotPassword, request.ip);
    await this.accountRecoveryService.requestPasswordReset(dto.email);

    return { message: FORGOT_PASSWORD_MESSAGE };
  }

  @Post('reset-password')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(AuthRateLimitGuard)
  @RateLimit('reset-password')
  @ApiOperation({
    summary: 'Reset the password with an e-mailed token',
    description:
      'Consumes the reset token (single use) and sets the new password. In the same transaction every session of the user is revoked ' +
      '(reason PASSWORD_RESET) and every other outstanding reset/verification link is invalidated; the e-mail address is marked verified. ' +
      'The user is NOT logged in: the client must call /auth/login with the new password.',
  })
  @ApiNoContentResponse({ description: 'Password reset; all sessions revoked.' })
  @ApiBadRequestResponse({
    description:
      'Validation failed (token malformed, password policy), or `Invalid or expired password reset token` ' +
      '(unknown, expired, already used, superseded, or the account is not active; indistinguishable on purpose).',
  })
  @ApiForbiddenResponse({ description: BOT_FORBIDDEN })
  @ApiTooManyRequestsResponse({ description: RATE_LIMITED })
  @ApiServiceUnavailableResponse({ description: BOT_UNAVAILABLE })
  async resetPassword(@Body() dto: ResetPasswordDto, @Req() request: Request): Promise<void> {
    // P3-BE03: verified before the reset token is looked up or consumed.
    await this.turnstile.verify(dto.turnstileToken, TURNSTILE_ACTIONS.resetPassword, request.ip);
    await this.accountRecoveryService.resetPassword(dto);
  }

  @Post('verify-email')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Verify my e-mail address with an e-mailed token',
    description:
      'Consumes the verification token (single use) and marks the address verified. No access token is required. ' +
      'Verification is informational: no endpoint currently requires a verified address.',
  })
  @ApiOkResponse({ type: VerifyEmailResponseDto, description: 'E-mail address verified.' })
  @ApiBadRequestResponse({
    description:
      'Token malformed, or `Invalid or expired verification token` (unknown, expired, already used, superseded, or the account is not active).',
  })
  verifyEmail(@Body() dto: VerifyEmailDto): Promise<VerifyEmailResponseDto> {
    return this.emailVerificationService.verify(dto.token);
  }

  @Post('verify-email/resend')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Resend the verification e-mail',
    description:
      'Issues a new verification link for the authenticated user (valid 24 hours by default) and e-mails it; earlier links stop working. ' +
      'E-mail delivery happens after the response: a 202 means the e-mail was queued, not delivered.',
  })
  @ApiAcceptedResponse({ type: VerificationEmailSentResponseDto, description: 'Verification e-mail queued.' })
  @ApiUnauthorizedResponse({ description: 'Access token missing/invalid/revoked, or the account is not active.' })
  @ApiConflictResponse({ description: 'The e-mail address is already verified.' })
  @ApiTooManyRequestsResponse({
    description: 'A verification e-mail was sent less than the cooldown ago; body includes `retryAfterSeconds`.',
  })
  async resendVerification(
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<VerificationEmailSentResponseDto> {
    const { expiresAt } = await this.emailVerificationService.resend(user);

    return { message: VERIFICATION_SENT_MESSAGE, expiresAt };
  }
}
