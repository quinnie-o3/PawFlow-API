import {
  BadRequestException,
  ConflictException,
  HttpException,
  Logger,
  UnauthorizedException,
  ValidationPipe,
} from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { type DataSource, FindOperator, type Repository } from 'typeorm';

import { GLOBAL_VALIDATION_PIPE_OPTIONS } from '../common/pipes/validation-pipe.options';
import type { MailMessage, MailTransport } from '../mail/mail-transport';
import { MailService } from '../mail/mail.service';
import { User } from '../users/entities/user.entity';
import { AccountRecoveryService, INVALID_RESET_TOKEN } from './account-recovery.service';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { hashUserToken, USER_TOKEN_PATTERN } from './auth-user-token.util';
import { FORGOT_PASSWORD_MESSAGE } from './dto/account-recovery-response.dto';
import { ChangePasswordDto } from './dto/change-password.dto';
import { ForgotPasswordDto } from './dto/forgot-password.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { VerifyEmailDto } from './dto/verify-email.dto';
import { EmailVerificationService, INVALID_VERIFICATION_TOKEN } from './email-verification.service';
import { AuthRefreshToken } from './entities/auth-refresh-token.entity';
import { AuthSession } from './entities/auth-session.entity';
import { AuthUserToken } from './entities/auth-user-token.entity';
import type { AuthenticatedUser } from './interfaces/authenticated-user.interface';

type Row = Record<string, any>;

const PASSWORD = 'Password123!';
const NEW_PASSWORD = 'NewPassword456!';
const MINUTE = 60_000;

function matches(row: Row, where: Row): boolean {
  return Object.entries(where).every(([key, expected]) => {
    if (expected instanceof FindOperator) {
      if (expected.type === 'isNull') return row[key] === null || row[key] === undefined;
      if (expected.type === 'lessThan') return row[key] < expected.value;
      if (expected.type === 'moreThan') return row[key] > expected.value;
      throw new Error('unsupported operator ' + expected.type);
    }
    return row[key] === expected;
  });
}

class RecordingTransport implements MailTransport {
  name = 'memory';
  readonly sent: (MailMessage & { from: string })[] = [];
  failWith: Error | null = null;
  /** Rejects the next N messages, whenever they are sent. */
  failNext = 0;

  send(message: MailMessage & { from: string }): Promise<void> {
    if (this.failNext > 0) {
      this.failNext -= 1;
      return Promise.reject(new Error('transient failure'));
    }
    if (this.failWith) return Promise.reject(this.failWith);
    this.sent.push(message);
    return Promise.resolve();
  }
}

/** Raw token carried by an e-mailed link (`…#token=<token>`). */
function tokenFrom(message: MailMessage): string {
  const token = decodeURIComponent(/#token=([^\s"<&]+)/.exec(message.text)![1]);
  expect(token).toMatch(USER_TOKEN_PATTERN);
  return token;
}

/**
 * Transactional in-memory stand-in for User, AuthSession, AuthRefreshToken
 * and AuthUserToken. Transactions are serialized (a model of the user row
 * lock every P3-BE02 write takes first) and restore a snapshot when their
 * callback throws (PostgreSQL rollback). Real PostgreSQL locking and races
 * are verified by test/qa/account-recovery.cjs.
 */
async function createHarness(config: Record<string, string> = {}) {
  const passwordHash = await bcrypt.hash(PASSWORD, 4);
  const state = {
    users: [
      { id: '1', email: 'an@pawflow.test', fullName: 'An', phone: null, role: 'CUSTOMER', status: 'ACTIVE', passwordHash, emailVerifiedAt: null },
      { id: '2', email: 'binh@pawflow.test', fullName: 'Bình', phone: null, role: 'PROVIDER_OWNER', status: 'ACTIVE', passwordHash, emailVerifiedAt: null },
      { id: '3', email: 'cuong@pawflow.test', fullName: 'Cường', phone: null, role: 'CUSTOMER', status: 'SUSPENDED', passwordHash, emailVerifiedAt: null },
    ] as Row[],
    sessions: [] as Row[],
    refreshTokens: [] as Row[],
    userTokens: [] as Row[],
    nextId: 100,
  };
  const locks: string[] = [];
  const failures: { sessionsUpdate?: Error; userTokenInsert?: Error; userUpdate?: Error } = {};
  const hooks: { beforeTransaction?: () => void } = {};

  const queryBuilder = () => {
    let email = '';
    const builder = {
      select: () => builder,
      where: (_sql: string, params: { email: string }) => ((email = params.email), builder),
      getOne: () => {
        const row = state.users.find((u) => u.email.toLowerCase() === email.toLowerCase());
        return Promise.resolve(row ? { ...row } : null);
      },
    };
    return builder;
  };

  const usersRepository = {
    createQueryBuilder: queryBuilder,
    findOne: ({ where, lock }: { where: Row; lock?: { mode: string } }) => {
      if (lock) locks.push(`user:${lock.mode}`);
      const row = state.users.find((u) => matches(u, where));
      return Promise.resolve(row ? { ...row } : null);
    },
    update: (criteria: Row, changes: Row) => {
      if (failures.userUpdate) return Promise.reject(failures.userUpdate);
      locks.push('user:update');
      const hit = state.users.filter((u) => matches(u, criteria));
      hit.forEach((u) => Object.assign(u, changes, { updatedAt: new Date() }));
      return Promise.resolve({ affected: hit.length });
    },
    create: (value: Row) => ({ ...value }),
    save: (value: Row) => {
      const saved = { emailVerifiedAt: null, ...value, id: String(state.nextId++), createdAt: new Date(), updatedAt: new Date() };
      state.users.push(saved);
      return Promise.resolve({ ...saved });
    },
  };
  const sessionsRepository = {
    create: (value: Row) => ({ userAgent: null, ipAddress: null, ...value }),
    save: (value: Row) => {
      const existing = state.sessions.find((s) => s.id === value.id);
      if (existing) Object.assign(existing, value);
      else state.sessions.push({ createdAt: new Date(), ...value });
      return Promise.resolve({ ...value });
    },
    findOne: ({ where }: { where: Row }) => {
      const row = state.sessions.find((s) => matches(s, where));
      return Promise.resolve(row ? { ...row } : null);
    },
    update: (criteria: Row, changes: Row) => {
      if (failures.sessionsUpdate) return Promise.reject(failures.sessionsUpdate);
      locks.push('sessions:update');
      const hit = state.sessions.filter((s) => matches(s, criteria));
      hit.forEach((s) => Object.assign(s, changes));
      return Promise.resolve({ affected: hit.length });
    },
  };
  const refreshTokensRepository = {
    create: (value: Row) => ({ ...value }),
    save: (value: Row) => {
      state.refreshTokens.push({ ...value, id: String(state.nextId++) });
      return Promise.resolve({ ...value });
    },
  };
  const userTokensRepository = {
    findOne: ({ where }: { where: Row }) => {
      const row = state.userTokens.find((t) => matches(t, where));
      return Promise.resolve(row ? { ...row } : null);
    },
    update: (criteria: Row, changes: Row) => {
      locks.push('tokens:update');
      const hit = state.userTokens.filter((t) => matches(t, criteria));
      hit.forEach((t) => Object.assign(t, changes));
      return Promise.resolve({ affected: hit.length });
    },
    delete: (criteria: Row) => {
      const before = state.userTokens.length;
      state.userTokens = state.userTokens.filter((t) => !matches(t, criteria));
      return Promise.resolve({ affected: before - state.userTokens.length });
    },
    insert: (value: Row) => {
      if (failures.userTokenInsert) return Promise.reject(failures.userTokenInsert);
      const live = state.userTokens.some((t) => t.userId === value.userId && t.purpose === value.purpose && !t.consumedAt && !t.revokedAt);
      if (live) return Promise.reject(Object.assign(new Error('uq_auth_user_tokens_active'), { code: '23505' }));
      state.userTokens.push({ ...value, id: String(state.nextId++) });
      return Promise.resolve({ identifiers: [] });
    },
  };
  const repositories = new Map<unknown, object>([
    [User, usersRepository],
    [AuthSession, sessionsRepository],
    [AuthRefreshToken, refreshTokensRepository],
    [AuthUserToken, userTokensRepository],
  ]);
  const manager = { getRepository: (entity: unknown) => repositories.get(entity) };
  let queue: Promise<unknown> = Promise.resolve();
  const dataSource = {
    manager,
    getRepository: manager.getRepository,
    transaction: (work: (m: object) => Promise<unknown>) => {
      const run = queue.then(async () => {
        hooks.beforeTransaction?.();
        hooks.beforeTransaction = undefined;
        const snapshot = structuredClone(state);
        try {
          return await work(manager);
        } catch (error) {
          Object.assign(state, snapshot);
          throw error;
        }
      });
      queue = run.catch(() => undefined);
      return run;
    },
  };
  const configService = {
    get: (key: string) => ({ AUTH_EMAIL_COOLDOWN_SECONDS: '60', AUTH_RECOVERY_MIN_RESPONSE_MS: '0', FRONTEND_URL: 'http://fe.test', ...config })[key],
    getOrThrow: (key: string) => config[key],
  } as unknown as ConfigService;
  const transport = new RecordingTransport();
  const mail = new MailService(transport, configService);
  const recovery = new AccountRecoveryService(dataSource as unknown as DataSource, configService, mail);
  const verification = new EmailVerificationService(dataSource as unknown as DataSource, configService, mail);
  const auth = new AuthService(
    usersRepository as unknown as Repository<User>,
    new JwtService({ secret: 'p3-be02-spec', signOptions: { expiresIn: 900 } }),
    dataSource as unknown as DataSource,
    configService,
    verification,
  );
  const settle = async () => {
    await verification.idle();
    await mail.idle();
  };

  return { state, locks, failures, hooks, transport, mail, recovery, verification, auth, settle, controller: new AuthController(auth, recovery, verification) };
}

type Harness = Awaited<ReturnType<typeof createHarness>>;

async function loginAs(h: Harness, email = 'an@pawflow.test', password = PASSWORD) {
  const res = await h.auth.login({ email, password });
  return { res, actor: { ...res.user, sessionId: h.state.sessions.at(-1)!.id } as AuthenticatedUser };
}

function liveSessions(h: Harness, userId: string) {
  return h.state.sessions.filter((s) => s.userId === userId && !s.revokedAt);
}

async function validate<T extends object>(metatype: new () => T, body: unknown): Promise<T> {
  return new ValidationPipe(GLOBAL_VALIDATION_PIPE_OPTIONS).transform(body, { type: 'body', metatype }) as Promise<T>;
}

describe('Account recovery (P3-BE02)', () => {
  let h: Harness;

  beforeEach(async () => {
    h = await createHarness();
  });

  describe('POST /auth/change-password', () => {
    it('sets the new password and revokes every session of the user, including the current one', async () => {
      const { actor } = await loginAs(h);
      await loginAs(h);
      await loginAs(h, 'binh@pawflow.test');
      expect(liveSessions(h, '1')).toHaveLength(2);

      await h.recovery.changePassword(actor, { currentPassword: PASSWORD, newPassword: NEW_PASSWORD });

      const an = h.state.users.find((u) => u.id === '1')!;
      expect(await bcrypt.compare(NEW_PASSWORD, an.passwordHash)).toBe(true);
      expect(await bcrypt.compare(PASSWORD, an.passwordHash)).toBe(false);
      expect(liveSessions(h, '1')).toHaveLength(0);
      expect(h.state.sessions.filter((s) => s.userId === '1').every((s) => s.revokedReason === 'PASSWORD_CHANGED')).toBe(true);
      expect(liveSessions(h, '2')).toHaveLength(1);
      expect(JSON.stringify(h.state)).not.toContain(NEW_PASSWORD);
    });

    it('takes the user lock first, then writes user -> sessions -> tokens', async () => {
      const { actor } = await loginAs(h);
      h.locks.length = 0;

      await h.recovery.changePassword(actor, { currentPassword: PASSWORD, newPassword: NEW_PASSWORD });

      expect(h.locks).toEqual(['user:pessimistic_write', 'user:update', 'sessions:update', 'tokens:update']);
    });

    it('rejects old credentials and accepts the new ones afterwards', async () => {
      const { actor } = await loginAs(h);
      await h.recovery.changePassword(actor, { currentPassword: PASSWORD, newPassword: NEW_PASSWORD });

      await expect(h.auth.login({ email: 'an@pawflow.test', password: PASSWORD })).rejects.toThrow(UnauthorizedException);
      await expect(h.auth.login({ email: 'an@pawflow.test', password: NEW_PASSWORD })).resolves.toMatchObject({ user: { id: '1' } });
    });

    it('rejects an incorrect current password with 400 and changes nothing', async () => {
      const { actor } = await loginAs(h);
      const before = structuredClone(h.state);

      await expect(
        h.recovery.changePassword(actor, { currentPassword: 'WrongPassword1', newPassword: NEW_PASSWORD }),
      ).rejects.toThrow(new BadRequestException('Current password is incorrect'));
      expect(h.state).toEqual(before);
    });

    it('rejects reusing the current password', async () => {
      const { actor } = await loginAs(h);

      await expect(
        h.recovery.changePassword(actor, { currentPassword: PASSWORD, newPassword: PASSWORD }),
      ).rejects.toThrow(new BadRequestException('New password must be different from the current password'));
      expect(liveSessions(h, '1')).toHaveLength(1);
    });

    it('requires a session-bound authenticated user', async () => {
      await expect(
        h.recovery.changePassword({ id: '1' } as AuthenticatedUser, { currentPassword: PASSWORD, newPassword: NEW_PASSWORD }),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('refuses a suspended account (status re-checked under the lock) and changes nothing', async () => {
      const { actor } = await loginAs(h);
      const original = h.state.users[0].passwordHash;
      h.hooks.beforeTransaction = () => {
        h.state.users[0].status = 'SUSPENDED';
      };

      await expect(
        h.recovery.changePassword(actor, { currentPassword: PASSWORD, newPassword: NEW_PASSWORD }),
      ).rejects.toThrow(new UnauthorizedException('Account is not active'));
      expect(h.state.users[0].passwordHash).toBe(original);

      await expect(
        h.recovery.changePassword({ id: '3', sessionId: 'x' } as AuthenticatedUser, { currentPassword: PASSWORD, newPassword: NEW_PASSWORD }),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('fails with 401 when the current session was revoked after the guard accepted it', async () => {
      const { actor } = await loginAs(h);
      const original = h.state.users[0].passwordHash;
      h.hooks.beforeTransaction = () => {
        h.state.sessions[0].revokedAt = new Date();
        h.state.sessions[0].revokedReason = 'LOGOUT_ALL';
      };

      await expect(
        h.recovery.changePassword(actor, { currentPassword: PASSWORD, newPassword: NEW_PASSWORD }),
      ).rejects.toThrow(UnauthorizedException);
      expect(h.state.users[0].passwordHash).toBe(original);
    });

    it('fails with 409 when the password hash changed between verification and the lock', async () => {
      const { actor } = await loginAs(h);
      const concurrent = await bcrypt.hash('SomeoneElse789', 4);
      h.hooks.beforeTransaction = () => {
        h.state.users[0].passwordHash = concurrent;
      };

      await expect(
        h.recovery.changePassword(actor, { currentPassword: PASSWORD, newPassword: NEW_PASSWORD }),
      ).rejects.toThrow(ConflictException);
      expect(h.state.users[0].passwordHash).toBe(concurrent);
      expect(liveSessions(h, '1')).toHaveLength(1);
    });

    it('rolls back the password update when session revocation fails', async () => {
      const { actor } = await loginAs(h);
      const original = h.state.users[0].passwordHash;
      h.failures.sessionsUpdate = new Error('injected');

      await expect(
        h.recovery.changePassword(actor, { currentPassword: PASSWORD, newPassword: NEW_PASSWORD }),
      ).rejects.toThrow('injected');
      expect(h.state.users[0].passwordHash).toBe(original);
      expect(liveSessions(h, '1')).toHaveLength(1);
    });

    it('invalidates an outstanding password-reset link', async () => {
      await h.recovery.requestPasswordReset('an@pawflow.test');
      await h.settle();
      const resetToken = tokenFrom(h.transport.sent[0]);
      const { actor } = await loginAs(h);

      await h.recovery.changePassword(actor, { currentPassword: PASSWORD, newPassword: NEW_PASSWORD });

      await expect(h.recovery.resetPassword({ token: resetToken, newPassword: 'Attacker000!' })).rejects.toThrow(
        new BadRequestException(INVALID_RESET_TOKEN),
      );
      expect(await bcrypt.compare(NEW_PASSWORD, h.state.users[0].passwordHash)).toBe(true);
    });

    it('validates the DTO with the production pipe (policy 8-72, required fields, no extras)', async () => {
      await expect(validate(ChangePasswordDto, { currentPassword: PASSWORD, newPassword: NEW_PASSWORD })).resolves.toBeInstanceOf(ChangePasswordDto);
      for (const body of [
        { currentPassword: PASSWORD, newPassword: 'short7!' },
        { currentPassword: PASSWORD, newPassword: 'x'.repeat(73) },
        { currentPassword: '', newPassword: NEW_PASSWORD },
        { newPassword: NEW_PASSWORD },
        { currentPassword: PASSWORD, newPassword: NEW_PASSWORD, userId: '2' },
        { currentPassword: PASSWORD, newPassword: 12345678 },
      ]) {
        await expect(validate(ChangePasswordDto, body)).rejects.toThrow(BadRequestException);
      }
      await expect(validate(ChangePasswordDto, { currentPassword: PASSWORD, newPassword: 'x'.repeat(8) })).resolves.toBeDefined();
      await expect(validate(ChangePasswordDto, { currentPassword: PASSWORD, newPassword: 'x'.repeat(72) })).resolves.toBeDefined();
    });
  });

  describe('login race with a password change (TOCTOU)', () => {
    it('does not open a session with the old password if the hash changed after bcrypt verification', async () => {
      const changed = await bcrypt.hash(NEW_PASSWORD, 4);
      h.hooks.beforeTransaction = () => {
        h.state.users[0].passwordHash = changed;
      };

      await expect(h.auth.login({ email: 'an@pawflow.test', password: PASSWORD })).rejects.toThrow(
        new UnauthorizedException('Invalid email or password'),
      );
      expect(h.state.sessions).toHaveLength(0);
    });
  });

  describe('POST /auth/forgot-password', () => {
    it('returns the same body for eligible, unknown and suspended addresses', async () => {
      const bodies = [];
      for (const email of ['an@pawflow.test', 'nobody@pawflow.test', 'cuong@pawflow.test']) {
        bodies.push(await h.controller.forgotPassword({ email }));
      }
      await h.settle();

      expect(bodies).toEqual([{ message: FORGOT_PASSWORD_MESSAGE }, { message: FORGOT_PASSWORD_MESSAGE }, { message: FORGOT_PASSWORD_MESSAGE }]);
      expect(h.transport.sent.map((m) => m.to)).toEqual(['an@pawflow.test']);
      expect(h.state.userTokens.map((t) => t.userId)).toEqual(['1']);
    });

    it('stores only the token hash and e-mails a fragment link to the stored address', async () => {
      await h.recovery.requestPasswordReset('  AN@PawFlow.TEST ');
      await h.settle();

      const [message] = h.transport.sent;
      const token = tokenFrom(message);
      expect(message).toMatchObject({ category: 'PASSWORD_RESET', to: 'an@pawflow.test', from: 'PawFlow <no-reply@pawflow.local>' });
      expect(message.text).toContain(`http://fe.test/reset-password#token=${token}`);
      expect(h.state.userTokens).toEqual([
        expect.objectContaining({ userId: '1', purpose: 'PASSWORD_RESET', tokenHash: hashUserToken(token), consumedAt: null, revokedAt: null }),
      ]);
      expect(JSON.stringify(h.state)).not.toContain(token);
    });

    it('expires after 30 minutes by default and honours PASSWORD_RESET_TOKEN_TTL_SECONDS', async () => {
      const now = new Date('2026-11-08T00:00:00Z');
      await h.recovery.issueResetToken('1', now);
      expect(h.state.userTokens[0].expiresAt.getTime() - now.getTime()).toBe(30 * MINUTE);

      h = await createHarness({ PASSWORD_RESET_TOKEN_TTL_SECONDS: '600' });
      await h.recovery.issueResetToken('1', now);
      expect(h.state.userTokens[0].expiresAt.getTime() - now.getTime()).toBe(10 * MINUTE);
    });

    it('does not issue another token within the cooldown; afterwards supersedes the previous one', async () => {
      const t0 = new Date('2026-11-08T00:00:00Z');
      await h.recovery.issueResetToken('1', t0);
      await h.recovery.issueResetToken('1', new Date(t0.getTime() + 30_000));
      await h.settle();
      expect(h.state.userTokens).toHaveLength(1);
      expect(h.transport.sent).toHaveLength(1);

      await h.recovery.issueResetToken('1', new Date(t0.getTime() + 61_000));
      await h.settle();
      expect(h.state.userTokens).toHaveLength(2);
      expect(h.state.userTokens[0].revokedAt).toEqual(new Date(t0.getTime() + 61_000));
      expect(h.state.userTokens[1]).toMatchObject({ revokedAt: null, consumedAt: null });
      const [first, second] = h.transport.sent.map(tokenFrom);
      await expect(h.recovery.resetPassword({ token: first, newPassword: NEW_PASSWORD }, new Date(t0.getTime() + 62_000))).rejects.toThrow(BadRequestException);
      await expect(h.recovery.resetPassword({ token: second, newPassword: NEW_PASSWORD }, new Date(t0.getTime() + 62_000))).resolves.toBeUndefined();
    });

    it('does not issue for suspended or unknown accounts', async () => {
      await h.recovery.issueResetToken('3');
      await h.recovery.issueResetToken('999');
      await h.settle();
      expect(h.state.userTokens).toHaveLength(0);
      expect(h.transport.sent).toHaveLength(0);
    });

    it('commits the token before the response resolves (an accepted request survives a crash)', async () => {
      // No settle(): only the e-mail may still be pending.
      await h.controller.forgotPassword({ email: 'an@pawflow.test' });

      expect(h.state.userTokens).toEqual([expect.objectContaining({ userId: '1', purpose: 'PASSWORD_RESET', consumedAt: null, revokedAt: null })]);
    });

    it('pads every response to AUTH_RECOVERY_MIN_RESPONSE_MS, eligible or not', async () => {
      h = await createHarness({ AUTH_RECOVERY_MIN_RESPONSE_MS: '120' });
      for (const email of ['an@pawflow.test', 'nobody@pawflow.test', 'cuong@pawflow.test']) {
        const t = performance.now();
        await h.controller.forgotPassword({ email });
        expect(performance.now() - t).toBeGreaterThanOrEqual(115);
      }
    });

    it('revokes the link when the transport rejects the e-mail, so an immediate retry is not blocked by the cooldown', async () => {
      const errors = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      h.transport.failWith = new Error('SMTP 421 try later');

      await h.controller.forgotPassword({ email: 'an@pawflow.test' });
      await h.settle();

      expect(h.state.userTokens).toHaveLength(1);
      expect(h.state.userTokens[0].revokedAt).toBeInstanceOf(Date);
      expect(errors).toHaveBeenCalledWith('Mail PASSWORD_RESET to a***@pawflow.test via memory failed (Error: SMTP 421 try later)');
      expect(JSON.stringify(errors.mock.calls)).not.toMatch(/token=|#|an@pawflow/);

      h.transport.failWith = null;
      await h.controller.forgotPassword({ email: 'an@pawflow.test' });
      await h.settle();
      expect(h.state.userTokens).toHaveLength(2);
      const token = tokenFrom(h.transport.sent[0]);
      await expect(h.recovery.resetPassword({ token, newPassword: NEW_PASSWORD })).resolves.toBeUndefined();
      errors.mockRestore();
    });

    it('with the transport disabled, the link nobody received is revoked', async () => {
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      h.transport.name = 'disabled';

      await h.controller.forgotPassword({ email: 'an@pawflow.test' });
      await h.settle();

      expect(h.state.userTokens[0].revokedAt).toBeInstanceOf(Date);
      expect(warn).toHaveBeenCalledWith('Mail PASSWORD_RESET to a***@pawflow.test via disabled not sent: MAIL_TRANSPORT is disabled');
      warn.mockRestore();
    });

    it('does not revoke a newer link when an older e-mail fails late', async () => {
      const t0 = new Date(Date.now() - 2 * MINUTE);
      h.transport.failNext = 1;
      const errors = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      await h.recovery.issueResetToken('1', t0);
      // Whether the first failure is handled before or after this issuance,
      // its revocation targets only its own (older) token hash.
      await h.recovery.issueResetToken('1');
      await h.settle();

      const [older, newer] = h.state.userTokens;
      expect(older.revokedAt).toBeInstanceOf(Date);
      expect(newer.revokedAt).toBeNull();
      errors.mockRestore();
    });

    it('propagates a database failure as an error (no false acceptance) and leaves nothing behind', async () => {
      h.failures.userTokenInsert = new Error('db down');

      await expect(h.controller.forgotPassword({ email: 'an@pawflow.test' })).rejects.toThrow('db down');
      await h.settle();

      expect(h.state.userTokens).toHaveLength(0);
      expect(h.transport.sent).toHaveLength(0);
    });

    it('normalizes and validates the e-mail like login', async () => {
      await expect(validate(ForgotPasswordDto, { email: '  An@PawFlow.Test ' })).resolves.toEqual({ email: 'an@pawflow.test' });
      for (const body of [{}, { email: 'not-an-email' }, { email: 'a@b.c', extra: 1 }, { email: 42 }]) {
        await expect(validate(ForgotPasswordDto, body)).rejects.toThrow(BadRequestException);
      }
    });
  });

  describe('POST /auth/reset-password', () => {
    async function resetToken(email = 'an@pawflow.test') {
      await h.recovery.requestPasswordReset(email);
      await h.settle();
      return tokenFrom(h.transport.sent.at(-1)!);
    }

    it('sets the password, consumes the token and revokes all sessions atomically', async () => {
      await loginAs(h);
      await loginAs(h);
      const token = await resetToken();
      h.locks.length = 0;

      await h.recovery.resetPassword({ token, newPassword: NEW_PASSWORD });

      const an = h.state.users[0];
      expect(await bcrypt.compare(NEW_PASSWORD, an.passwordHash)).toBe(true);
      expect(an.emailVerifiedAt).toBeInstanceOf(Date);
      expect(liveSessions(h, '1')).toHaveLength(0);
      expect(h.state.sessions.every((s) => s.revokedReason === 'PASSWORD_RESET')).toBe(true);
      expect(h.state.userTokens[0].consumedAt).toBeInstanceOf(Date);
      expect(h.state.userTokens[0].revokedAt).toBeNull();
      expect(h.locks).toEqual(['user:pessimistic_write', 'user:update', 'sessions:update', 'tokens:update', 'tokens:update']);
      await expect(h.auth.login({ email: 'an@pawflow.test', password: PASSWORD })).rejects.toThrow(UnauthorizedException);
      await expect(h.auth.login({ email: 'an@pawflow.test', password: NEW_PASSWORD })).resolves.toBeDefined();
    });

    it('does not log the user in (no session is created)', async () => {
      const token = await resetToken();
      await expect(h.recovery.resetPassword({ token, newPassword: NEW_PASSWORD })).resolves.toBeUndefined();
      expect(h.state.sessions).toHaveLength(0);
    });

    it('rejects a replayed token without changing the password again', async () => {
      const token = await resetToken();
      await h.recovery.resetPassword({ token, newPassword: NEW_PASSWORD });
      const after = h.state.users[0].passwordHash;

      await expect(h.recovery.resetPassword({ token, newPassword: 'Another999!' })).rejects.toThrow(new BadRequestException(INVALID_RESET_TOKEN));
      expect(h.state.users[0].passwordHash).toBe(after);
    });

    it('lets exactly one of two concurrent resets with the same token succeed', async () => {
      const token = await resetToken();

      const results = await Promise.allSettled([
        h.recovery.resetPassword({ token, newPassword: 'FirstWinner111' }),
        h.recovery.resetPassword({ token, newPassword: 'SecondWinner222' }),
      ]);

      expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
      expect((results.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason).toBeInstanceOf(BadRequestException);
      expect(h.state.userTokens.filter((t) => t.consumedAt)).toHaveLength(1);
    });

    it('rejects an expired token (boundary: expiresAt itself is expired)', async () => {
      const t0 = new Date('2026-11-08T00:00:00Z');
      await h.recovery.issueResetToken('1', t0);
      await h.settle();
      const token = tokenFrom(h.transport.sent[0]);
      const original = h.state.users[0].passwordHash;

      await expect(h.recovery.resetPassword({ token, newPassword: NEW_PASSWORD }, new Date(t0.getTime() + 30 * MINUTE))).rejects.toThrow(BadRequestException);
      expect(h.state.users[0].passwordHash).toBe(original);
      await expect(h.recovery.resetPassword({ token, newPassword: NEW_PASSWORD }, new Date(t0.getTime() + 30 * MINUTE - 1))).resolves.toBeUndefined();
    });

    it('rejects unknown tokens and tokens of another purpose with the same error', async () => {
      await expect(h.recovery.resetPassword({ token: 'A'.repeat(43), newPassword: NEW_PASSWORD })).rejects.toThrow(new BadRequestException(INVALID_RESET_TOKEN));

      await h.auth.register({ fullName: 'Dung', email: 'dung@pawflow.test', password: PASSWORD });
      await h.settle();
      const verificationToken = tokenFrom(h.transport.sent.at(-1)!);
      await expect(h.recovery.resetPassword({ token: verificationToken, newPassword: NEW_PASSWORD })).rejects.toThrow(new BadRequestException(INVALID_RESET_TOKEN));
    });

    it('refuses an account suspended after the link was issued, leaving the token unconsumed', async () => {
      const token = await resetToken();
      h.state.users[0].status = 'SUSPENDED';

      await expect(h.recovery.resetPassword({ token, newPassword: NEW_PASSWORD })).rejects.toThrow(new BadRequestException(INVALID_RESET_TOKEN));
      expect(h.state.userTokens[0].consumedAt).toBeNull();
      expect(await bcrypt.compare(PASSWORD, h.state.users[0].passwordHash)).toBe(true);
    });

    it('rolls back token consumption and the password when session revocation fails', async () => {
      await loginAs(h);
      const token = await resetToken();
      const original = h.state.users[0].passwordHash;
      h.failures.sessionsUpdate = new Error('injected');

      await expect(h.recovery.resetPassword({ token, newPassword: NEW_PASSWORD })).rejects.toThrow('injected');
      expect(h.state.users[0].passwordHash).toBe(original);
      expect(h.state.userTokens[0].consumedAt).toBeNull();
      expect(liveSessions(h, '1')).toHaveLength(1);

      h.failures.sessionsUpdate = undefined;
      await expect(h.recovery.resetPassword({ token, newPassword: NEW_PASSWORD })).resolves.toBeUndefined();
    });

    it('invalidates an outstanding verification link too', async () => {
      await h.auth.register({ fullName: 'Dung', email: 'dung@pawflow.test', password: PASSWORD });
      await h.settle();
      const verificationToken = tokenFrom(h.transport.sent.at(-1)!);
      const token = await resetToken('dung@pawflow.test');

      await h.recovery.resetPassword({ token, newPassword: NEW_PASSWORD });

      expect(h.state.userTokens.filter((t) => !t.consumedAt && !t.revokedAt)).toHaveLength(0);
      await expect(h.verification.verify(verificationToken)).rejects.toThrow(BadRequestException);
      expect(h.state.users.find((u) => u.email === 'dung@pawflow.test')!.emailVerifiedAt).toBeInstanceOf(Date);
    });

    it('validates token format and password policy', async () => {
      await expect(validate(ResetPasswordDto, { token: 'A'.repeat(43), newPassword: NEW_PASSWORD })).resolves.toBeDefined();
      for (const body of [
        { token: 'A'.repeat(42), newPassword: NEW_PASSWORD },
        { token: 'A'.repeat(43) + '=', newPassword: NEW_PASSWORD },
        { token: 'A'.repeat(43), newPassword: 'short' },
        { token: 'A'.repeat(43), newPassword: 'x'.repeat(73) },
        { newPassword: NEW_PASSWORD },
        { token: 'A'.repeat(43), newPassword: NEW_PASSWORD, email: 'an@pawflow.test' },
      ]) {
        await expect(validate(ResetPasswordDto, body)).rejects.toThrow(BadRequestException);
      }
    });
  });

  describe('e-mail verification', () => {
    async function register(email = 'dung@pawflow.test') {
      const res = await h.auth.register({ fullName: 'Dung <b>', email, password: PASSWORD });
      await h.settle();
      return { res, token: tokenFrom(h.transport.sent.at(-1)!) };
    }

    it('registration returns emailVerified=false and e-mails a verification link after the commit', async () => {
      const { res, token } = await register();

      expect(res.user).toMatchObject({ email: 'dung@pawflow.test', emailVerified: false, emailVerifiedAt: null });
      const message = h.transport.sent[0];
      expect(message).toMatchObject({ category: 'EMAIL_VERIFICATION', to: 'dung@pawflow.test' });
      expect(message.text).toContain(`http://fe.test/verify-email#token=${token}`);
      expect(message.html).toContain('Dung &lt;b&gt;');
      expect(message.html).not.toContain('Dung <b>');
      expect(h.state.userTokens).toEqual([expect.objectContaining({ purpose: 'EMAIL_VERIFICATION', tokenHash: hashUserToken(token) })]);
      const ttl = h.state.userTokens[0].expiresAt.getTime() - h.state.userTokens[0].createdAt.getTime();
      expect(ttl).toBe(24 * 60 * MINUTE);
    });

    it('a verification failure never fails or undoes the registration', async () => {
      const errors = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      h.failures.userTokenInsert = new Error('injected');

      const res = await h.auth.register({ fullName: 'Em', email: 'em@pawflow.test', password: PASSWORD });
      await h.settle();

      expect(res.accessToken).toEqual(expect.any(String));
      expect(h.state.users.some((u) => u.email === 'em@pawflow.test')).toBe(true);
      expect(h.state.userTokens).toHaveLength(0);
      expect(errors).toHaveBeenCalledWith('Verification issuance for a new account failed (Error: injected)');
      errors.mockRestore();
    });

    it('verifies once; a replay is rejected and the verification time is kept', async () => {
      const { res, token } = await register();

      const first = await h.verification.verify(token);
      expect(first).toEqual({ emailVerified: true, emailVerifiedAt: expect.any(Date) });
      const user = h.state.users.find((u) => u.id === res.user.id)!;
      expect(user.emailVerifiedAt).toEqual(first.emailVerifiedAt);
      expect(h.state.userTokens[0].consumedAt).toBeInstanceOf(Date);

      await expect(h.verification.verify(token)).rejects.toThrow(new BadRequestException(INVALID_VERIFICATION_TOKEN));
      expect(user.emailVerifiedAt).toEqual(first.emailVerifiedAt);
    });

    it('does not touch sessions or the password', async () => {
      const { token } = await register();
      const before = structuredClone(h.state.sessions);
      await h.verification.verify(token);
      expect(h.state.sessions).toEqual(before);
    });

    it('two concurrent verifications with one token: exactly one succeeds', async () => {
      const { token } = await register();
      const results = await Promise.allSettled([h.verification.verify(token), h.verification.verify(token)]);
      expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
    });

    it('rejects expired tokens (24 h default)', async () => {
      const { token } = await register();
      const expiresAt = h.state.userTokens[0].expiresAt as Date;
      await expect(h.verification.verify(token, expiresAt)).rejects.toThrow(BadRequestException);
      expect(h.state.userTokens[0].consumedAt).toBeNull();
    });

    it('refuses suspended accounts without consuming the token', async () => {
      const { res, token } = await register();
      h.state.users.find((u) => u.id === res.user.id)!.status = 'SUSPENDED';

      await expect(h.verification.verify(token)).rejects.toThrow(new BadRequestException(INVALID_VERIFICATION_TOKEN));
      expect(h.state.userTokens[0].consumedAt).toBeNull();
      expect(h.state.users.find((u) => u.id === res.user.id)!.emailVerifiedAt).toBeNull();
    });

    it('rejects a password-reset token used for verification', async () => {
      await h.recovery.requestPasswordReset('an@pawflow.test');
      await h.settle();
      await expect(h.verification.verify(tokenFrom(h.transport.sent[0]))).rejects.toThrow(BadRequestException);
      expect(h.state.users[0].emailVerifiedAt).toBeNull();
    });

    describe('resend (authenticated)', () => {
      it('issues a new link and invalidates the previous one', async () => {
        const t0 = new Date('2026-11-08T00:00:00Z');
        const { res, token: first } = await register();
        h.state.userTokens[0].createdAt = new Date(t0.getTime() - 2 * MINUTE);
        const actor = { id: res.user.id } as AuthenticatedUser;

        const out = await h.verification.resend(actor, t0);
        await h.settle();

        expect(out.expiresAt).toEqual(new Date(t0.getTime() + 24 * 60 * MINUTE));
        const second = tokenFrom(h.transport.sent.at(-1)!);
        expect(second).not.toBe(first);
        await expect(h.verification.verify(first, t0)).rejects.toThrow(BadRequestException);
        await expect(h.verification.verify(second, t0)).resolves.toMatchObject({ emailVerified: true });
      });

      it('returns 429 with retryAfterSeconds within the cooldown and sends nothing', async () => {
        const { res } = await register();
        const sent = h.transport.sent.length;
        const createdAt = h.state.userTokens[0].createdAt as Date;

        const error = await h.verification.resend({ id: res.user.id } as AuthenticatedUser, new Date(createdAt.getTime() + 15_000)).catch((e: unknown) => e);

        expect(error).toBeInstanceOf(HttpException);
        expect((error as HttpException).getStatus()).toBe(429);
        expect((error as HttpException).getResponse()).toMatchObject({ statusCode: 429, retryAfterSeconds: 45 });
        await h.settle();
        expect(h.transport.sent).toHaveLength(sent);
        expect(h.state.userTokens).toHaveLength(1);
      });

      it('returns 409 once verified, 401 when suspended', async () => {
        const { res, token } = await register();
        await h.verification.verify(token);
        await expect(h.verification.resend({ id: res.user.id } as AuthenticatedUser)).rejects.toThrow(ConflictException);
        await expect(h.verification.resend({ id: '3' } as AuthenticatedUser)).rejects.toThrow(UnauthorizedException);
      });

      it('a rejected verification e-mail revokes its link, so resend is not blocked by the cooldown (no 429)', async () => {
        const errors = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
        h.transport.failWith = new Error('EAUTH');

        await expect(h.verification.resend({ id: '1' } as AuthenticatedUser)).resolves.toBeDefined();
        await h.settle();
        expect(h.state.userTokens[0].revokedAt).toBeInstanceOf(Date);

        h.transport.failWith = null;
        await expect(h.verification.resend({ id: '1' } as AuthenticatedUser)).resolves.toBeDefined();
        await h.settle();
        await expect(h.verification.verify(tokenFrom(h.transport.sent[0]))).resolves.toMatchObject({ emailVerified: true });
        errors.mockRestore();
      });

      it('works for accounts created before P3-BE02 (emailVerifiedAt NULL)', async () => {
        await expect(h.verification.resend({ id: '1' } as AuthenticatedUser)).resolves.toMatchObject({ expiresAt: expect.any(Date) });
        await h.settle();
        await h.verification.verify(tokenFrom(h.transport.sent[0]));
        expect(h.state.users[0].emailVerifiedAt).toBeInstanceOf(Date);
      });
    });

    it('existing unverified accounts keep logging in (verification is not enforced)', async () => {
      expect(h.state.users[0].emailVerifiedAt).toBeNull();
      const { res } = await loginAs(h);
      expect(res.user).toMatchObject({ id: '1', emailVerified: false });
    });

    it('validates the token format', async () => {
      await expect(validate(VerifyEmailDto, { token: 'A'.repeat(43) })).resolves.toBeDefined();
      for (const body of [{}, { token: 'short' }, { token: 'A'.repeat(43), userId: '1' }, { token: 7 }]) {
        await expect(validate(VerifyEmailDto, body)).rejects.toThrow(BadRequestException);
      }
    });
  });

  describe('GET /auth/me', () => {
    it('adds emailVerified and emailVerifiedAt without exposing the session id', () => {
      const verifiedAt = new Date('2026-11-01T00:00:00Z');
      const body = h.controller.me({ id: '1', email: 'an@pawflow.test', sessionId: 's', emailVerifiedAt: verifiedAt } as AuthenticatedUser);
      expect(body).toEqual({ user: { id: '1', email: 'an@pawflow.test', emailVerified: true, emailVerifiedAt: verifiedAt } });
      expect(h.controller.me({ id: '1', sessionId: 's' } as AuthenticatedUser).user).toMatchObject({ emailVerified: false, emailVerifiedAt: null });
    });
  });
});
