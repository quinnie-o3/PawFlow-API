import {
  BadRequestException,
  type BeforeApplicationShutdown,
  ConflictException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource, IsNull } from 'typeorm';

import { BackgroundTasks } from '../common/utils/background-tasks';
import { emailVerificationEmail } from '../mail/mail-templates';
import { MailService } from '../mail/mail.service';
import { User } from '../users/entities/user.entity';
import {
  hashUserToken,
  issueUserToken,
  revokeUndeliveredUserToken,
  revokeUserTokens,
  userTokenCooldownSeconds,
  userTokenState,
  userTokenTtlSeconds,
} from './auth-user-token.util';
import { AuthUserToken } from './entities/auth-user-token.entity';
import type { AuthenticatedUser } from './interfaces/authenticated-user.interface';

export const INVALID_VERIFICATION_TOKEN = 'Invalid or expired verification token';
export const EMAIL_VERIFICATION_PATH = '/verify-email';

/**
 * P3-BE02 e-mail verification lifecycle.
 *
 * Verification is recorded (`users.email_verified_at`) but NOT enforced:
 * login, refresh and bookings do not depend on it, and accounts created
 * before P3-BE02 remain unverified and unrestricted until a product policy
 * decides otherwise. Every write holds the user row FOR UPDATE.
 */
@Injectable()
export class EmailVerificationService implements BeforeApplicationShutdown {
  private readonly logger = new Logger(EmailVerificationService.name);
  private readonly tasks = new BackgroundTasks(this.logger);

  constructor(
    private readonly dataSource: DataSource,
    private readonly configService: ConfigService,
    private readonly mailService: MailService,
  ) {}

  /**
   * Called after a registration has committed: issues the first token and
   * e-mails it in the background. A failure here (or a crash before it runs)
   * never affects the registration; the user can resend at any time because
   * no usable token exists, so no cooldown applies.
   */
  sendForNewAccount(userId: string): void {
    this.tasks.run('Verification issuance for a new account', async () => {
      await this.issue(userId, { enforceCooldown: false });
    });
  }

  /**
   * Authenticated resend. 409 when already verified, 429 within the
   * cooldown. The previous link stops working.
   */
  async resend(actor: AuthenticatedUser, now: Date = new Date()): Promise<{ expiresAt: Date }> {
    const outcome = await this.issue(actor.id, { enforceCooldown: true, now });

    switch (outcome.kind) {
      case 'issued':
        return { expiresAt: outcome.expiresAt };
      case 'verified':
        throw new ConflictException('Email address is already verified');
      case 'inactive':
        throw new UnauthorizedException('Account is not active');
      case 'cooldown':
        throw new HttpException(
          {
            statusCode: HttpStatus.TOO_MANY_REQUESTS,
            error: 'Too Many Requests',
            message: 'A verification e-mail was sent recently; please wait before requesting another one',
            retryAfterSeconds: outcome.retryAfterSeconds,
          },
          HttpStatus.TOO_MANY_REQUESTS,
        );
    }
  }

  /**
   * Consumes a verification token and marks the address verified. Replays,
   * expired/superseded tokens and inactive accounts all get the same 400;
   * the token stays unconsumed when the account is not ACTIVE.
   */
  async verify(
    rawToken: string,
    now: Date = new Date(),
  ): Promise<{ emailVerified: true; emailVerifiedAt: Date }> {
    const found = await this.dataSource.getRepository(AuthUserToken).findOne({
      where: { tokenHash: hashUserToken(rawToken), purpose: 'EMAIL_VERIFICATION' },
    });

    if (!found || userTokenState(found, now) !== 'USABLE') {
      throw new BadRequestException(INVALID_VERIFICATION_TOKEN);
    }

    const verifiedAt = await this.dataSource.transaction(async (manager) => {
      const usersRepository = manager.getRepository(User);
      const tokensRepository = manager.getRepository(AuthUserToken);
      const user = await usersRepository.findOne({
        where: { id: found.userId },
        lock: { mode: 'pessimistic_write' },
      });
      const token = await tokensRepository.findOne({ where: { id: found.id } });

      if (!user || !token || user.status !== 'ACTIVE' || userTokenState(token, now) !== 'USABLE') {
        return null;
      }

      const emailVerifiedAt = user.emailVerifiedAt ?? now;

      if (!user.emailVerifiedAt) {
        await usersRepository.update({ id: user.id }, { emailVerifiedAt });
      }

      const update = await tokensRepository.update(
        { id: token.id, consumedAt: IsNull(), revokedAt: IsNull() },
        { consumedAt: now },
      );

      if (update.affected !== 1) {
        throw new Error('Verification token changed while the user row was locked');
      }

      await revokeUserTokens(manager, user.id, 'EMAIL_VERIFICATION', now);

      return emailVerifiedAt;
    });

    if (!verifiedAt) {
      throw new BadRequestException(INVALID_VERIFICATION_TOKEN);
    }

    return { emailVerified: true, emailVerifiedAt: verifiedAt };
  }

  /** Waits for queued issuance work (tests, graceful shutdown). */
  idle(): Promise<void> {
    return this.tasks.idle();
  }

  /** Drains queued issuance while the database is still available. */
  async beforeApplicationShutdown(): Promise<void> {
    await this.idle();
  }

  private async issue(
    userId: string,
    options: { enforceCooldown: boolean; now?: Date },
  ): Promise<
    | { kind: 'issued'; expiresAt: Date }
    | { kind: 'verified' }
    | { kind: 'inactive' }
    | { kind: 'cooldown'; retryAfterSeconds: number }
  > {
    const now = options.now ?? new Date();
    const ttlSeconds = userTokenTtlSeconds(this.configService, 'EMAIL_VERIFICATION');
    const outcome = await this.dataSource.transaction(async (manager) => {
      const user = await manager.getRepository(User).findOne({
        where: { id: userId },
        lock: { mode: 'pessimistic_write' },
      });

      if (!user || user.status !== 'ACTIVE') {
        return { kind: 'inactive' as const };
      }

      if (user.emailVerifiedAt) {
        return { kind: 'verified' as const };
      }

      const result = await issueUserToken(manager, user.id, 'EMAIL_VERIFICATION', {
        ttlSeconds,
        cooldownSeconds: options.enforceCooldown ? userTokenCooldownSeconds(this.configService) : 0,
        now,
      });

      return result.kind === 'issued' ? { ...result, user } : result;
    });

    if (outcome.kind !== 'issued') {
      return outcome;
    }

    const tokenHash = hashUserToken(outcome.token);

    // If the e-mail is not accepted, the link is revoked so that an
    // immediate resend is not blocked by the cooldown.
    this.mailService.dispatch(
      emailVerificationEmail({
        to: outcome.user.email,
        fullName: outcome.user.fullName,
        link: this.mailService.frontendLink(EMAIL_VERIFICATION_PATH, outcome.token),
        expiresInMinutes: Math.round(ttlSeconds / 60),
      }),
      async () => {
        await revokeUndeliveredUserToken(this.dataSource, userId, tokenHash);
      },
    );

    return { kind: 'issued', expiresAt: outcome.expiresAt };
  }
}
