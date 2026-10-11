import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';

import { AuthService } from './auth.service';
import { CurrentUser } from './decorators/current-user.decorator';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import type { AuthenticatedUser } from './interfaces/authenticated-user.interface';

@ApiTags('Authentication')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('register')
  @ApiOperation({
    summary: 'Register a customer account',
    description:
      'Creates a new active CUSTOMER account. Role cannot be selected by the registering user.',
  })
  @ApiCreatedResponse({
    description:
      'Account registered successfully and JWT access token returned.',
  })
  @ApiBadRequestResponse({
    description:
      'Request validation failed or unsupported fields were provided.',
  })
  @ApiConflictResponse({
    description: 'An account with the same email already exists.',
  })
  register(@Body() registerDto: RegisterDto) {
    return this.authService.register(registerDto);
  }

  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Log in',
    description:
      'Authenticates an active account and returns a JWT Bearer access token.',
  })
  @ApiOkResponse({
    description: 'Authentication successful.',
  })
  @ApiBadRequestResponse({
    description: 'Request validation failed.',
  })
  @ApiUnauthorizedResponse({
    description:
      'Invalid credentials or the account cannot be authenticated.',
  })
  login(@Body() loginDto: LoginDto) {
    return this.authService.login(loginDto);
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
      'Bearer token is missing, invalid, expired, or belongs to an unavailable account.',
  })
  me(@CurrentUser() user: AuthenticatedUser) {
    return { user };
  }
}