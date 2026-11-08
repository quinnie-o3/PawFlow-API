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
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { Request } from 'express';

import { AuthService, type SessionClientInfo } from './auth.service';
import { CurrentUser } from './decorators/current-user.decorator';
import { LoginDto } from './dto/login.dto';
import { RefreshTokenDto } from './dto/refresh-token.dto';
import { RegisterDto } from './dto/register.dto';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
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

@ApiTags('Authentication')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('register')
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
  register(@Body() registerDto: RegisterDto, @Req() request: Request) {
    return this.authService.register(registerDto, clientInfo(request));
  }

  @Post('login')
  @HttpCode(HttpStatus.OK)
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
  login(@Body() loginDto: LoginDto, @Req() request: Request) {
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
    const { sessionId: _sessionId, ...profile } = user;

    return { user: profile };
  }
}
