import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { TypeOrmModule } from '@nestjs/typeorm';

import { MailModule } from '../mail/mail.module';
import { User } from '../users/entities/user.entity';
import { AccountRecoveryService } from './account-recovery.service';
import { accessTokenTtlSeconds } from './auth-session.util';
import { OwnershipService } from './authorization/ownership.service';
import { AuthController } from './auth.controller';
import { TurnstileService } from './bot-protection/turnstile.service';
import { AuthService } from './auth.service';
import { AuthRefreshToken } from './entities/auth-refresh-token.entity';
import { AuthSession } from './entities/auth-session.entity';
import { AuthUserToken } from './entities/auth-user-token.entity';
import { EmailVerificationService } from './email-verification.service';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { RolesGuard } from './guards/roles.guard';
import { AuthRateLimit } from './rate-limit/auth-rate-limit.entity';
import { AuthRateLimitGuard } from './rate-limit/auth-rate-limit.guard';
import { AuthRateLimitService } from './rate-limit/auth-rate-limit.service';
import { JwtStrategy } from './strategies/jwt.strategy';

@Module({
  imports: [
    ConfigModule,
    MailModule,
    TypeOrmModule.forFeature([User, AuthSession, AuthRefreshToken, AuthUserToken, AuthRateLimit]),
    PassportModule.register({ defaultStrategy: 'jwt' }),
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        secret: configService.getOrThrow<string>('JWT_SECRET'),
        // P3-BE01: short-lived access tokens (JWT_ACCESS_TOKEN_TTL_SECONDS,
        // default 15 minutes); sessions are renewed through /auth/refresh.
        signOptions: {
          expiresIn: accessTokenTtlSeconds(configService),
        },
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    AccountRecoveryService,
    EmailVerificationService,
    // P3-BE03 bot protection and rate limiting.
    TurnstileService,
    AuthRateLimitService,
    AuthRateLimitGuard,
    JwtStrategy,
    JwtAuthGuard,
    RolesGuard,
    OwnershipService,
  ],
  exports: [
    // Re-export the Passport configuration so AuthGuard('jwt') can be
    // instantiated by controllers in modules that import AuthModule.
    PassportModule,
    AuthService,
    JwtAuthGuard,
    RolesGuard,
    OwnershipService,
  ],
})
export class AuthModule {}
