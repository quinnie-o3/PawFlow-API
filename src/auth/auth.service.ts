import { randomUUID } from 'node:crypto';

import {
  ConflictException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import * as bcrypt from 'bcrypt';
import { DataSource, EntityManager, IsNull, MoreThan, Repository } from 'typeorm';

import { User } from '../users/entities/user.entity';
import {
  accessTokenTtlSeconds,
  generateRefreshToken,
  hashRefreshToken,
  refreshSessionTtlSeconds,
  revokeUserSessions,
} from './auth-session.util';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';
import { AuthRefreshToken } from './entities/auth-refresh-token.entity';
import { AuthSession, type SessionRevokeReason } from './entities/auth-session.entity';
import { AuthenticatedUser } from './interfaces/authenticated-user.interface';
import { JwtPayload } from './interfaces/jwt-payload.interface';

/** Client details recorded on a session for the session list. */
export interface SessionClientInfo {
  userAgent?: string | null;
  ipAddress?: string | null;
}

export interface SessionView {
  id: string;
  createdAt: Date;
  lastUsedAt: Date;
  expiresAt: Date;
  userAgent: string | null;
  ipAddress: string | null;
  current: boolean;
}

interface IssuedSession {
  user: User;
  session: AuthSession;
  refreshToken: string;
}

type RefreshOutcome =
  | ({ kind: 'rotated' } & IssuedSession)
  | { kind: 'rejected'; message: string };

const INVALID_REFRESH_TOKEN = 'Invalid or expired refresh token';

@Injectable()
export class AuthService {
  constructor(
    @InjectRepository(User)
    private readonly usersRepository: Repository<User>,
    private readonly jwtService: JwtService,
    private readonly dataSource: DataSource,
    private readonly configService: ConfigService,
  ) {}

  /**
   * Creates the user, its first session and the session's first refresh
   * token in ONE transaction: either all three rows commit or none does, and
   * the tokens are signed only after the commit. The duplicate pre-check and
   * bcrypt hashing run before the transaction so no lock is held while
   * hashing; a concurrent registration of the same email is still rejected by
   * the unique email index inside the transaction (409, everything rolled back).
   */
  async register(registerDto: RegisterDto, client: SessionClientInfo = {}) {
    const email = registerDto.email.toLowerCase();
    const existingUser = await this.findByEmail(email);

    if (existingUser) {
      throw new ConflictException('Email is already registered');
    }

    const passwordHash = await bcrypt.hash(registerDto.password, 12);
    let issued: IssuedSession;

    try {
      issued = await this.dataSource.transaction(async (manager) => {
        const usersRepository = manager.getRepository(User);
        const user = await usersRepository.save(
          usersRepository.create({
            fullName: registerDto.fullName,
            email,
            phone: registerDto.phone ?? null,
            passwordHash,
            role: 'CUSTOMER',
            status: 'ACTIVE',
          }),
        );

        // The new row is not visible to other transactions until commit, so
        // no user lock is needed here (unlike login).
        return this.insertSession(manager, user, client);
      });
    } catch (error: unknown) {
      if (this.isDuplicateEmailError(error)) {
        throw new ConflictException('Email is already registered');
      }
      throw error;
    }

    return this.createAuthResponse(issued);
  }

  async login(loginDto: LoginDto, client: SessionClientInfo = {}) {
    const user = await this.findByEmail(loginDto.email.toLowerCase());

    if (!user || !(await bcrypt.compare(loginDto.password, user.passwordHash))) {
      throw new UnauthorizedException('Invalid email or password');
    }

    if (user.status !== 'ACTIVE') {
      throw new UnauthorizedException('Account is not active');
    }

    return this.createAuthResponse(await this.openSession(user.id, client));
  }

  /**
   * Rotates a refresh token: the presented token is marked used and a new
   * one is issued for the same session (whose absolute expiry is unchanged).
   *
   * Lock order is user (FOR SHARE) -> session (FOR UPDATE) -> token, the
   * same as account suspension (user FOR UPDATE -> sessions), so the two
   * cannot deadlock and a suspension committed first is always seen here.
   * Presenting an already used token is reuse: the whole session is revoked
   * (committed) and 401 is returned. Unknown tokens revoke nothing.
   */
  async refresh(
    refreshToken: string,
    client: SessionClientInfo = {},
    now: Date = new Date(),
  ) {
    const tokenHash = hashRefreshToken(refreshToken);

    const outcome = await this.dataSource.transaction(
      async (manager): Promise<RefreshOutcome> => {
        const tokensRepository = manager.getRepository(AuthRefreshToken);
        const sessionsRepository = manager.getRepository(AuthSession);
        const presented = await tokensRepository.findOne({
          where: { tokenHash },
          relations: { session: true },
        });

        if (!presented) {
          return { kind: 'rejected', message: INVALID_REFRESH_TOKEN };
        }

        const user = await manager.getRepository(User).findOne({
          where: { id: presented.session.userId },
          lock: { mode: 'pessimistic_read' },
        });
        const session = await sessionsRepository.findOne({
          where: { id: presented.sessionId },
          lock: { mode: 'pessimistic_write' },
        });
        const token = await tokensRepository.findOne({
          where: { id: presented.id },
          lock: { mode: 'pessimistic_write' },
        });

        if (!user || !session || !token || session.revokedAt) {
          return { kind: 'rejected', message: INVALID_REFRESH_TOKEN };
        }

        if (token.usedAt) {
          await this.revokeSession(manager, session, 'REUSE_DETECTED', now);
          return {
            kind: 'rejected',
            message: 'Refresh token reuse detected; the session has been revoked',
          };
        }

        if (session.expiresAt <= now) {
          return { kind: 'rejected', message: INVALID_REFRESH_TOKEN };
        }

        if (user.status !== 'ACTIVE') {
          await this.revokeSession(manager, session, 'ACCOUNT_INACTIVE', now);
          return { kind: 'rejected', message: 'Account is not active' };
        }

        token.usedAt = now;
        await tokensRepository.save(token);
        session.lastUsedAt = now;
        this.applyClientInfo(session, client);
        await sessionsRepository.save(session);

        return {
          kind: 'rotated',
          user,
          session,
          refreshToken: await this.issueRefreshToken(manager, session.id),
        };
      },
    );

    if (outcome.kind === 'rejected') {
      throw new UnauthorizedException(outcome.message);
    }

    return this.createAuthResponse(outcome);
  }

  /** Revokes the session of the access token used for this request. */
  async logout(user: AuthenticatedUser, now: Date = new Date()): Promise<void> {
    await this.dataSource.getRepository(AuthSession).update(
      { id: this.requireSessionId(user), userId: user.id, revokedAt: IsNull() },
      { revokedAt: now, revokedReason: 'LOGOUT' },
    );
  }

  /** Revokes every session of the user, including the current one. */
  async logoutAll(user: AuthenticatedUser, now: Date = new Date()): Promise<void> {
    await revokeUserSessions(this.dataSource.manager, user.id, 'LOGOUT_ALL', now);
  }

  /** Active (not revoked, not expired) sessions of the user, most recently used first. */
  async listSessions(
    user: AuthenticatedUser,
    now: Date = new Date(),
  ): Promise<SessionView[]> {
    const sessions = await this.dataSource.getRepository(AuthSession).find({
      where: { userId: user.id, revokedAt: IsNull(), expiresAt: MoreThan(now) },
      order: { lastUsedAt: 'DESC', createdAt: 'DESC' },
    });

    return sessions.map((session) => ({
      id: session.id,
      createdAt: session.createdAt,
      lastUsedAt: session.lastUsedAt,
      expiresAt: session.expiresAt,
      userAgent: session.userAgent,
      ipAddress: session.ipAddress,
      current: session.id === user.sessionId,
    }));
  }

  /** Revokes one of the user's own sessions. Another user's session is a 404. */
  async revokeOwnSession(
    user: AuthenticatedUser,
    sessionId: string,
    now: Date = new Date(),
  ): Promise<void> {
    const sessionsRepository = this.dataSource.getRepository(AuthSession);
    const session = await sessionsRepository.findOne({
      where: { id: sessionId, userId: user.id },
    });

    if (!session) {
      throw new NotFoundException('Session not found');
    }

    await sessionsRepository.update(
      { id: session.id, revokedAt: IsNull() },
      { revokedAt: now, revokedReason: 'SESSION_REVOKED' },
    );
  }

  /**
   * Login: creates a session and its first refresh token. The user row is
   * read FOR SHARE, so a concurrent suspension either commits first (and the
   * login is refused) or waits and then revokes this new session.
   */
  private openSession(
    userId: string,
    client: SessionClientInfo,
  ): Promise<IssuedSession> {
    return this.dataSource.transaction(async (manager) => {
      const user = await manager.getRepository(User).findOne({
        where: { id: userId },
        lock: { mode: 'pessimistic_read' },
      });

      if (!user || user.status !== 'ACTIVE') {
        throw new UnauthorizedException('Account is not active');
      }

      return this.insertSession(manager, user, client);
    });
  }

  /** Session + first refresh token, inside the caller's transaction. */
  private async insertSession(
    manager: EntityManager,
    user: User,
    client: SessionClientInfo,
    now: Date = new Date(),
  ): Promise<IssuedSession> {
    const sessionsRepository = manager.getRepository(AuthSession);
    const session = sessionsRepository.create({
      id: randomUUID(),
      userId: user.id,
      lastUsedAt: now,
      expiresAt: new Date(now.getTime() + refreshSessionTtlSeconds(this.configService) * 1000),
      revokedAt: null,
      revokedReason: null,
    });
    this.applyClientInfo(session, client);
    await sessionsRepository.save(session);

    return {
      user,
      session,
      refreshToken: await this.issueRefreshToken(manager, session.id),
    };
  }

  private async issueRefreshToken(
    manager: EntityManager,
    sessionId: string,
  ): Promise<string> {
    const refreshToken = generateRefreshToken();
    const tokensRepository = manager.getRepository(AuthRefreshToken);

    await tokensRepository.save(
      tokensRepository.create({
        sessionId,
        tokenHash: hashRefreshToken(refreshToken),
        usedAt: null,
      }),
    );

    return refreshToken;
  }

  private async revokeSession(
    manager: EntityManager,
    session: AuthSession,
    reason: SessionRevokeReason,
    now: Date,
  ): Promise<void> {
    session.revokedAt = now;
    session.revokedReason = reason;
    await manager.getRepository(AuthSession).save(session);
  }

  private applyClientInfo(session: AuthSession, client: SessionClientInfo): void {
    if (client.userAgent !== undefined) {
      session.userAgent = client.userAgent ? client.userAgent.slice(0, 255) : null;
    }

    if (client.ipAddress !== undefined) {
      session.ipAddress = client.ipAddress ? client.ipAddress.slice(0, 45) : null;
    }
  }

  private requireSessionId(user: AuthenticatedUser): string {
    if (!user.sessionId) {
      throw new UnauthorizedException();
    }

    return user.sessionId;
  }

  private async findByEmail(email: string): Promise<User | null> {
    return this.usersRepository
      .createQueryBuilder('user')
      .where('LOWER(user.email) = LOWER(:email)', { email })
      .getOne();
  }

  private createAuthResponse({ user, session, refreshToken }: IssuedSession) {
    const payload: JwtPayload = {
      sub: user.id,
      email: user.email,
      role: user.role,
      sid: session.id,
    };

    return {
      accessToken: this.jwtService.sign(payload),
      tokenType: 'Bearer',
      expiresIn: accessTokenTtlSeconds(this.configService),
      refreshToken,
      refreshTokenExpiresAt: session.expiresAt,
      user: this.toAuthenticatedUser(user),
    };
  }

  private toAuthenticatedUser(user: User): AuthenticatedUser {
    return {
      id: user.id,
      fullName: user.fullName,
      email: user.email,
      phone: user.phone,
      role: user.role,
      status: user.status,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
    };
  }

  private isDuplicateEmailError(error: unknown): boolean {
    return (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === '23505'
    );
  }
}
