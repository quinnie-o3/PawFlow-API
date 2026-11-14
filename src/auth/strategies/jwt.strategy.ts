import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { InjectRepository } from '@nestjs/typeorm';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { Repository } from 'typeorm';

import { isSessionId } from '../auth-session.util';
import { AuthSession } from '../entities/auth-session.entity';
import { AuthenticatedUser } from '../interfaces/authenticated-user.interface';
import { JwtPayload } from '../interfaces/jwt-payload.interface';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    configService: ConfigService,
    @InjectRepository(AuthSession)
    private readonly sessionsRepository: Repository<AuthSession>,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: configService.getOrThrow<string>('JWT_SECRET'),
    });
  }

  /**
   * P3-BE01: an access token is valid only while its session is: the
   * session must exist for the token's user, not be revoked or expired, and
   * the user must be ACTIVE. Logout, logout-all, reuse detection and account
   * suspension therefore take effect on the next request, not at expiry.
   * Tokens issued before sessions existed (no `sid`) are rejected.
   */
  async validate(payload: JwtPayload): Promise<AuthenticatedUser> {
    if (!isSessionId(payload.sid) || typeof payload.sub !== 'string') {
      throw new UnauthorizedException();
    }

    const session = await this.sessionsRepository.findOne({
      where: { id: payload.sid, userId: payload.sub },
      relations: { user: true },
    });

    if (
      !session ||
      session.revokedAt ||
      session.expiresAt <= new Date() ||
      session.user.status !== 'ACTIVE'
    ) {
      throw new UnauthorizedException();
    }

    const { user } = session;

    return {
      id: user.id,
      fullName: user.fullName,
      email: user.email,
      phone: user.phone,
      role: user.role,
      status: user.status,
      emailVerifiedAt: user.emailVerifiedAt ?? null,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
      sessionId: session.id,
    };
  }
}
