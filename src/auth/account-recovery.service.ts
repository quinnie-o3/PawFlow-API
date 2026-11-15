import { setTimeout as delay } from 'node:timers/promises';

import {
  BadRequestException,
  ConflictException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcrypt';
import { DataSource, IsNull } from 'typeorm';

import { passwordResetEmail } from '../mail/mail-templates';
import { MailService } from '../mail/mail.service';
import { User } from '../users/entities/user.entity';
import { revokeUserSessions } from './auth-session.util';
import {
  hashUserToken,
  issueUserToken,
  recoveryMinResponseMs,
  revokeUndeliveredUserToken,
  revokeUserTokens,
  userTokenCooldownSeconds,
  userTokenState,
  userTokenTtlSeconds,
} from './auth-user-token.util';
import { ChangePasswordDto } from './dto/change-password.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { AuthSession } from './entities/auth-session.entity';
import { AuthUserToken } from './entities/auth-user-token.entity';
import type { AuthenticatedUser } from './interfaces/authenticated-user.interface';
import { BCRYPT_ROUNDS } from './password-policy';

export const INVALID_RESET_TOKEN = 'Invalid or expired password reset token';
export const PASSWORD_RESET_PATH = '/reset-password';

/**
 * P3-BE02 password change, forgot password and reset password.
 *
 * Every write takes the user row FOR UPDATE first and then touches
 * sessions and one-time tokens (user -> sessions -> tokens), the same order
 * as account suspension and compatible with refresh/login (user FOR SHARE
 * first). bcrypt runs before the transaction; the state it was computed
 * against is re-checked under the lock.
 */
@Injectable()
export class AccountRecoveryService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly configService: ConfigService,
    private readonly mailService: MailService,
  ) {}

  /**
   * Changes the password of the authenticated user and revokes ALL of the
   * user's sessions (including the current one) plus any outstanding reset
   * link, atomically. The client must log in again.
   */
  async changePassword(
    actor: AuthenticatedUser,
    dto: ChangePasswordDto,
    now: Date = new Date(),
  ): Promise<void> {
    if (!actor.sessionId) {
      throw new UnauthorizedException();
    }

    const sessionId = actor.sessionId;
    const user = await this.dataSource.getRepository(User).findOne({ where: { id: actor.id } });

    if (!user || user.status !== 'ACTIVE') {
      throw new UnauthorizedException('Account is not active');
    }

    if (!(await bcrypt.compare(dto.currentPassword, user.passwordHash))) {
      throw new BadRequestException('Current password is incorrect');
    }

    // bcrypt-equal (not string-equal): bcrypt ignores input beyond 72 bytes.
    if (await bcrypt.compare(dto.newPassword, user.passwordHash)) {
      throw new BadRequestException('New password must be different from the current password');
    }

    const newHash = await bcrypt.hash(dto.newPassword, BCRYPT_ROUNDS);

    await this.dataSource.transaction(async (manager) => {
      const usersRepository = manager.getRepository(User);
      const locked = await usersRepository.findOne({
        where: { id: user.id },
        lock: { mode: 'pessimistic_write' },
      });

      if (!locked || locked.status !== 'ACTIVE') {
        throw new UnauthorizedException('Account is not active');
      }

      const session = await manager.getRepository(AuthSession).findOne({
        where: { id: sessionId, userId: user.id },
      });

      // The session may have been revoked (logout-all, another password
      // change or reset) after the guard accepted the access token.
      if (!session || session.revokedAt || session.expiresAt <= now) {
        throw new UnauthorizedException();
      }

      // The current password was verified against this hash; if it changed
      // meanwhile, the verification is stale.
      if (locked.passwordHash !== user.passwordHash) {
        throw new ConflictException('The password was changed by another request; sign in again');
      }

      await usersRepository.update({ id: locked.id }, { passwordHash: newHash });
      await revokeUserSessions(manager, locked.id, 'PASSWORD_CHANGED', now);
      await revokeUserTokens(manager, locked.id, 'PASSWORD_RESET', now);
    });
  }

  /**
   * Starts password recovery. For an ACTIVE account the reset token is
   * committed BEFORE the response (an accepted request survives a crash);
   * only the e-mail is sent after the response. Every response, whatever
   * the address, is padded to the same minimum duration
   * (`AUTH_RECOVERY_MIN_RESPONSE_MS`, default 250 ms) so the extra
   * transaction is not observable as latency. A database error is a 500 for
   * any address (not padded): it is not caused by the caller.
   */
  async requestPasswordReset(email: string): Promise<void> {
    const startedAt = performance.now();
    const user = await this.dataSource
      .getRepository(User)
      .createQueryBuilder('user')
      .select(['user.id', 'user.status'])
      .where('LOWER(user.email) = LOWER(:email)', { email: email.trim() })
      .getOne();

    if (user && user.status === 'ACTIVE') {
      await this.issueResetToken(user.id);
    }

    const remaining = recoveryMinResponseMs(this.configService) - (performance.now() - startedAt);

    if (remaining > 0) {
      await delay(remaining);
    }
  }

  /**
   * Issues a reset token (superseding the previous one), commits it, then
   * queues the e-mail. If the e-mail is not accepted by the transport, the
   * link is revoked so the user can request a new one immediately.
   * Silently does nothing for a non-ACTIVE account or within the cooldown.
   */
  async issueResetToken(userId: string, now: Date = new Date()): Promise<void> {
    const issued = await this.dataSource.transaction(async (manager) => {
      const user = await manager.getRepository(User).findOne({
        where: { id: userId },
        lock: { mode: 'pessimistic_write' },
      });

      if (!user || user.status !== 'ACTIVE') {
        return null;
      }

      const result = await issueUserToken(manager, user.id, 'PASSWORD_RESET', {
        ttlSeconds: userTokenTtlSeconds(this.configService, 'PASSWORD_RESET'),
        cooldownSeconds: userTokenCooldownSeconds(this.configService),
        now,
      });

      return result.kind === 'issued' ? { user, ...result } : null;
    });

    if (!issued) {
      return;
    }

    const ownerId = issued.user.id;
    const tokenHash = hashUserToken(issued.token);

    // Sent to the stored address, never to the request's spelling of it.
    this.mailService.dispatch(
      passwordResetEmail({
        to: issued.user.email,
        fullName: issued.user.fullName,
        link: this.mailService.frontendLink(PASSWORD_RESET_PATH, issued.token),
        expiresInMinutes: Math.round(userTokenTtlSeconds(this.configService, 'PASSWORD_RESET') / 60),
      }),
      async () => {
        await revokeUndeliveredUserToken(this.dataSource, ownerId, tokenHash);
      },
    );
  }

  /**
   * Consumes a reset token: sets the new password, consumes the token,
   * revokes every session and every other outstanding one-time token of the
   * user, in one transaction. Does not log the user in. Every failure is the
   * same 400, so the endpoint does not reveal why a token is unusable.
   */
  async resetPassword(dto: ResetPasswordDto, now: Date = new Date()): Promise<void> {
    const tokenHash = hashUserToken(dto.token);
    const found = await this.dataSource.getRepository(AuthUserToken).findOne({
      where: { tokenHash, purpose: 'PASSWORD_RESET' },
    });

    if (!found || userTokenState(found, now) !== 'USABLE') {
      throw new BadRequestException(INVALID_RESET_TOKEN);
    }

    const newHash = await bcrypt.hash(dto.newPassword, BCRYPT_ROUNDS);

    const consumed = await this.dataSource.transaction(async (manager) => {
      const usersRepository = manager.getRepository(User);
      const tokensRepository = manager.getRepository(AuthUserToken);
      const user = await usersRepository.findOne({
        where: { id: found.userId },
        lock: { mode: 'pessimistic_write' },
      });
      // All writers of a user's tokens hold the user lock: this read is current.
      const token = await tokensRepository.findOne({ where: { id: found.id } });

      if (!user || !token || user.status !== 'ACTIVE' || userTokenState(token, now) !== 'USABLE') {
        return false;
      }

      await usersRepository.update(
        { id: user.id },
        {
          passwordHash: newHash,
          // Following an e-mailed link proves control of the address.
          ...(user.emailVerifiedAt ? {} : { emailVerifiedAt: now }),
        },
      );
      await revokeUserSessions(manager, user.id, 'PASSWORD_RESET', now);

      const update = await tokensRepository.update(
        { id: token.id, consumedAt: IsNull(), revokedAt: IsNull() },
        { consumedAt: now },
      );

      if (update.affected !== 1) {
        throw new Error('Password reset token changed while the user row was locked');
      }

      await revokeUserTokens(manager, user.id, undefined, now);

      return true;
    });

    if (!consumed) {
      throw new BadRequestException(INVALID_RESET_TOKEN);
    }
  }
}
