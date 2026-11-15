import {
  ConflictException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { type DataSource, FindOperator, type Repository } from 'typeorm';

import { User } from '../users/entities/user.entity';
import { hashRefreshToken, REFRESH_TOKEN_PATTERN } from './auth-session.util';
import { AuthService } from './auth.service';
import { AuthRefreshToken } from './entities/auth-refresh-token.entity';
import { AuthSession } from './entities/auth-session.entity';
import type { AuthenticatedUser } from './interfaces/authenticated-user.interface';
import type { JwtPayload } from './interfaces/jwt-payload.interface';

type Row = Record<string, any>;

const SECRET = 'p3-be01-spec-secret';
const PASSWORD = 'Password123!';

function matches(row: Row, where: Row): boolean {
  return Object.entries(where).every(([key, expected]) => {
    if (expected instanceof FindOperator) {
      if (expected.type === 'isNull') return row[key] === null || row[key] === undefined;
      if (expected.type === 'moreThan') return row[key] > expected.value;
      throw new Error('unsupported operator ' + expected.type);
    }
    return row[key] === expected;
  });
}

/**
 * Transactional in-memory stand-in for the repositories used by AuthService.
 * A transaction restores a snapshot when its callback throws (PostgreSQL
 * rollback). Locks are recorded in order; the real lock behaviour under
 * concurrency is verified against PostgreSQL by test/qa/auth-sessions.cjs.
 */
async function createHarness(config: Record<string, string> = {}) {
  const passwordHash = await bcrypt.hash(PASSWORD, 4);
  const state = {
    users: [
      { id: '1', email: 'an@pawflow.test', fullName: 'An', phone: null, role: 'CUSTOMER', status: 'ACTIVE', passwordHash },
      { id: '2', email: 'binh@pawflow.test', fullName: 'Bình', phone: null, role: 'PROVIDER_OWNER', status: 'ACTIVE', passwordHash },
      { id: '3', email: 'cuong@pawflow.test', fullName: 'Cường', phone: null, role: 'CUSTOMER', status: 'SUSPENDED', passwordHash },
    ] as Row[],
    sessions: [] as Row[],
    tokens: [] as Row[],
    nextId: 100,
  };
  const locks: string[] = [];
  // Ordered log of commits and token signing (atomic registration checks).
  const events: string[] = [];
  // Failure injection: the next save of that kind rejects.
  const failures: { userSave?: unknown; sessionSave?: unknown; tokenSave?: unknown } = {};

  const usersRepository = {
    createQueryBuilder: () => {
      let email = '';
      const builder = {
        where: (_sql: string, params: { email: string }) => ((email = params.email), builder),
        getOne: () => Promise.resolve(state.users.find((u) => u.email.toLowerCase() === email.toLowerCase()) ?? null),
      };
      return builder;
    },
    findOne: ({ where, lock }: { where: Row; lock?: { mode: string } }) => {
      if (lock) locks.push(`user:${lock.mode}`);
      const row = state.users.find((u) => matches(u, where));
      return Promise.resolve(row ? { ...row } : null);
    },
    create: (value: Row) => ({ ...value }),
    save: (value: Row) => {
      if (failures.userSave) return Promise.reject(failures.userSave);
      const saved = { ...value, id: String(state.nextId++), createdAt: new Date(), updatedAt: new Date() };
      state.users.push(saved);
      return Promise.resolve({ ...saved });
    },
  };
  const sessionsRepository = {
    create: (value: Row) => ({ userAgent: null, ipAddress: null, ...value }),
    save: (value: Row) => {
      if (failures.sessionSave) return Promise.reject(failures.sessionSave);
      const existing = state.sessions.find((s) => s.id === value.id);
      if (existing) Object.assign(existing, value);
      else state.sessions.push({ createdAt: new Date(), ...value });
      return Promise.resolve({ ...value });
    },
    findOne: ({ where, lock }: { where: Row; lock?: { mode: string } }) => {
      if (lock) locks.push(`session:${lock.mode}`);
      const row = state.sessions.find((s) => matches(s, where));
      return Promise.resolve(row ? { ...row } : null);
    },
    find: ({ where }: { where: Row }) =>
      Promise.resolve(state.sessions.filter((s) => matches(s, where)).map((s) => ({ ...s }))),
    update: (criteria: Row, changes: Row) => {
      const hit = state.sessions.filter((s) => matches(s, criteria));
      hit.forEach((s) => Object.assign(s, changes));
      return Promise.resolve({ affected: hit.length });
    },
  };
  const tokensRepository = {
    create: (value: Row) => ({ ...value }),
    save: (value: Row) => {
      if (!value.id && failures.tokenSave) return Promise.reject(failures.tokenSave);
      if (value.id) Object.assign(state.tokens.find((t) => t.id === value.id)!, value);
      else state.tokens.push({ ...value, id: String(state.nextId++), createdAt: new Date() });
      return Promise.resolve({ ...value });
    },
    findOne: ({ where, lock, relations }: { where: Row; lock?: { mode: string }; relations?: Row }) => {
      if (lock) locks.push(`token:${lock.mode}`);
      const row = state.tokens.find((t) => matches(t, where));
      if (!row) return Promise.resolve(null);
      return Promise.resolve({
        ...row,
        ...(relations?.session ? { session: { ...state.sessions.find((s) => s.id === row.sessionId) } } : {}),
      });
    },
  };
  const repositories = new Map<unknown, object>([
    [User, usersRepository],
    [AuthSession, sessionsRepository],
    [AuthRefreshToken, tokensRepository],
  ]);
  const manager = { getRepository: (entity: unknown) => repositories.get(entity) };
  const dataSource = {
    manager,
    getRepository: manager.getRepository,
    transaction: async (work: (m: object) => Promise<unknown>) => {
      const snapshot = structuredClone(state);
      try {
        const result = await work(manager);
        events.push('commit');
        return result;
      } catch (error) {
        Object.assign(state, snapshot);
        throw error;
      }
    },
  };
  const configService = { get: (key: string) => config[key] } as unknown as ConfigService;
  const jwt = new JwtService({ secret: SECRET, signOptions: { expiresIn: 900 } });
  const sign = jwt.sign.bind(jwt);
  jwt.sign = ((...args: Parameters<JwtService['sign']>) => {
    events.push('sign');
    return sign(...args);
  }) as JwtService['sign'];
  const service = new AuthService(
    usersRepository as unknown as Repository<User>,
    jwt,
    dataSource as unknown as DataSource,
    configService,
  );

  return { state, locks, events, failures, service, jwt };
}

describe('Auth sessions (P3-BE01)', () => {
  let h: Awaited<ReturnType<typeof createHarness>>;
  const login = (email = 'an@pawflow.test') =>
    h.service.login({ email, password: PASSWORD }, { userAgent: 'Spec/1.0', ipAddress: '127.0.0.1' });
  const asUser = (userId: string, sessionId: string) =>
    ({ id: userId, sessionId }) as AuthenticatedUser;

  beforeEach(async () => {
    h = await createHarness();
  });

  describe('login and register', () => {
    it('opens a session and returns a short-lived access token bound to it', async () => {
      const res = await login();
      const payload = h.jwt.verify<JwtPayload & { iat: number; exp: number }>(res.accessToken);

      expect(res).toMatchObject({ tokenType: 'Bearer', expiresIn: 900, user: { id: '1', role: 'CUSTOMER' } });
      expect(res.refreshToken).toMatch(REFRESH_TOKEN_PATTERN);
      expect(h.state.sessions).toHaveLength(1);
      expect(payload).toMatchObject({ sub: '1', role: 'CUSTOMER', sid: h.state.sessions[0].id });
      expect(payload.exp - payload.iat).toBe(900);
      expect(res.refreshTokenExpiresAt.getTime() - Date.now()).toBeGreaterThan(29 * 86_400_000);
      expect(h.state.sessions[0]).toMatchObject({ userId: '1', revokedAt: null, userAgent: 'Spec/1.0', ipAddress: '127.0.0.1' });
    });

    it('stores only the hash of the refresh token', async () => {
      const res = await login();

      expect(h.state.tokens).toEqual([
        expect.objectContaining({ tokenHash: hashRefreshToken(res.refreshToken), usedAt: null }),
      ]);
      expect(JSON.stringify(h.state)).not.toContain(res.refreshToken);
    });

    it('uses the configured lifetimes', async () => {
      h = await createHarness({ JWT_ACCESS_TOKEN_TTL_SECONDS: '300', REFRESH_SESSION_TTL_SECONDS: '3600' });
      const res = await login();

      expect(res.expiresIn).toBe(300);
      expect(res.refreshTokenExpiresAt.getTime() - Date.now()).toBeLessThanOrEqual(3_600_000);
    });

    it('opens a separate session per login (multiple devices)', async () => {
      await login();
      await login();

      expect(h.state.sessions).toHaveLength(2);
    });

    it('refuses a suspended account without creating a session', async () => {
      await expect(login('cuong@pawflow.test')).rejects.toThrow(new UnauthorizedException('Account is not active'));
      expect(h.state.sessions).toHaveLength(0);
    });

    it('re-checks the status under the user lock before opening the session', async () => {
      await login();

      expect(h.locks).toEqual(['user:pessimistic_read']);
    });

    it('register returns the same session response', async () => {
      const res = await h.service.register({ fullName: 'Dung', email: 'Dung@PawFlow.test', password: PASSWORD });

      expect(res.refreshToken).toMatch(REFRESH_TOKEN_PATTERN);
      expect(h.state.sessions).toEqual([expect.objectContaining({ userId: res.user.id })]);
    });
  });

  describe('atomic registration (P3-BE01 hotfix)', () => {
    const dto = { fullName: 'Dung', email: 'Dung@PawFlow.test', password: PASSWORD };
    const counts = () => ({ users: h.state.users.length, sessions: h.state.sessions.length, tokens: h.state.tokens.length });

    it('commits user, session and refresh-token verifier in ONE transaction, then signs the tokens', async () => {
      const before = counts();
      h.events.length = 0;

      const res = await h.service.register(dto);

      expect(counts()).toEqual({ users: before.users + 1, sessions: 1, tokens: 1 });
      expect(h.events).toEqual(['commit', 'sign']);
      expect(h.state.sessions[0]).toMatchObject({ userId: res.user.id });
      expect(h.state.tokens[0]).toMatchObject({ sessionId: h.state.sessions[0].id, tokenHash: hashRefreshToken(res.refreshToken) });
      expect(h.jwt.verify<JwtPayload>(res.accessToken)).toMatchObject({ sub: res.user.id, sid: h.state.sessions[0].id, role: 'CUSTOMER' });
      expect(h.state.users.at(-1)).toMatchObject({ email: 'dung@pawflow.test', role: 'CUSTOMER', status: 'ACTIVE' });
    });

    it.each([
      ['session persistence', 'sessionSave'],
      ['refresh-token persistence', 'tokenSave'],
    ] as const)('rolls back the user when %s fails, and issues no credentials', async (_label, point) => {
      const before = counts();
      h.events.length = 0;
      h.failures[point] = new Error(`${point} failed`);

      await expect(h.service.register(dto)).rejects.toThrow(`${point} failed`);

      expect(counts()).toEqual(before);
      expect(h.state.users.some((u) => u.email === 'dung@pawflow.test')).toBe(false);
      expect(h.events).toEqual([]);
    });

    it('can register the same email after a failed attempt (nothing was left behind)', async () => {
      h.failures.tokenSave = new Error('transient');
      await expect(h.service.register(dto)).rejects.toThrow('transient');
      delete h.failures.tokenSave;

      await expect(h.service.register(dto)).resolves.toMatchObject({ user: { email: 'dung@pawflow.test' } });
      expect(h.state.users.filter((u) => u.email === 'dung@pawflow.test')).toHaveLength(1);
    });

    it('rejects a duplicate email (pre-check) with 409 and creates no session', async () => {
      const before = counts();

      await expect(h.service.register({ ...dto, email: 'AN@pawflow.test' })).rejects.toThrow(
        new ConflictException('Email is already registered'),
      );
      expect(counts()).toEqual(before);
    });

    it('maps a unique-index violation inside the transaction (concurrent duplicate) to 409 with nothing persisted', async () => {
      const before = counts();
      h.failures.userSave = Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505' });

      await expect(h.service.register(dto)).rejects.toThrow(new ConflictException('Email is already registered'));
      expect(counts()).toEqual(before);
      expect(h.events).not.toContain('sign');
    });

    it('does not take a user lock during registration (the new row is private to the transaction)', async () => {
      h.locks.length = 0;

      await h.service.register(dto);

      expect(h.locks).toEqual([]);
    });

    it('leaves login unchanged: user locked FOR SHARE, separate transaction, commit before signing', async () => {
      h.events.length = 0;
      h.locks.length = 0;

      await login();

      expect(h.locks).toEqual(['user:pessimistic_read']);
      expect(h.events).toEqual(['commit', 'sign']);
    });

    it('a login whose session insert fails issues nothing and leaves no session', async () => {
      h.failures.sessionSave = new Error('session insert failed');

      await expect(login()).rejects.toThrow('session insert failed');
      expect(h.state.sessions).toHaveLength(0);
      expect(h.events).not.toContain('sign');
    });
  });

  describe('refresh rotation and reuse detection', () => {
    it('rotates: the old token is consumed, a new one works, the session is kept', async () => {
      const first = await login();
      const second = await h.service.refresh(first.refreshToken);
      const third = await h.service.refresh(second.refreshToken);

      expect(second.refreshToken).not.toBe(first.refreshToken);
      expect(h.jwt.decode<JwtPayload>(third.accessToken).sid).toBe(h.state.sessions[0].id);
      expect(h.state.sessions).toHaveLength(1);
      expect(h.state.tokens.map((t) => t.usedAt !== null)).toEqual([true, true, false]);
    });

    it('detects reuse of a consumed token and revokes the whole session (committed despite the 401)', async () => {
      const first = await login();
      const second = await h.service.refresh(first.refreshToken);

      await expect(h.service.refresh(first.refreshToken)).rejects.toThrow(
        new UnauthorizedException('Refresh token reuse detected; the session has been revoked'),
      );
      expect(h.state.sessions[0]).toMatchObject({ revokedReason: 'REUSE_DETECTED' });
      await expect(h.service.refresh(second.refreshToken)).rejects.toThrow(UnauthorizedException);
    });

    it('rejects an unknown token without revoking anything', async () => {
      await login();

      await expect(h.service.refresh('A'.repeat(43))).rejects.toThrow(
        new UnauthorizedException('Invalid or expired refresh token'),
      );
      expect(h.state.sessions[0].revokedAt).toBeNull();
    });

    it('rejects a token of an expired session', async () => {
      const res = await login();
      h.state.sessions[0].expiresAt = new Date(Date.now() - 1000);

      await expect(h.service.refresh(res.refreshToken)).rejects.toThrow(UnauthorizedException);
      expect(h.state.tokens[0].usedAt).toBeNull();
    });

    it('rejects a token of a revoked session', async () => {
      const res = await login();
      await h.service.logout(asUser('1', h.state.sessions[0].id));

      await expect(h.service.refresh(res.refreshToken)).rejects.toThrow(UnauthorizedException);
    });

    it('revokes the session when the account is no longer active', async () => {
      const res = await login();
      h.state.users[0].status = 'SUSPENDED';

      await expect(h.service.refresh(res.refreshToken)).rejects.toThrow(new UnauthorizedException('Account is not active'));
      expect(h.state.sessions[0]).toMatchObject({ revokedReason: 'ACCOUNT_INACTIVE' });
    });

    it('locks user (FOR SHARE) -> session (FOR UPDATE) -> token (FOR UPDATE)', async () => {
      const res = await login();
      h.locks.length = 0;

      await h.service.refresh(res.refreshToken);

      expect(h.locks).toEqual(['user:pessimistic_read', 'session:pessimistic_write', 'token:pessimistic_write']);
    });

    it('records the latest client information on refresh', async () => {
      const res = await login();
      await h.service.refresh(res.refreshToken, { userAgent: 'Browser/2', ipAddress: '10.0.0.2' });

      expect(h.state.sessions[0]).toMatchObject({ userAgent: 'Browser/2', ipAddress: '10.0.0.2' });
    });
  });

  describe('logout, logout-all, session list and isolation', () => {
    it('logout revokes only the current session', async () => {
      await login();
      await login();
      const [a, b] = h.state.sessions;

      await h.service.logout(asUser('1', a.id));

      expect(a).toMatchObject({ revokedReason: 'LOGOUT' });
      expect(b.revokedAt).toBeNull();
    });

    it("logout-all revokes every session of the user and no one else's", async () => {
      await login();
      await login();
      await login('binh@pawflow.test');

      await h.service.logoutAll(asUser('1', h.state.sessions[0].id));

      expect(h.state.sessions.map((s) => [s.userId, s.revokedReason])).toEqual([
        ['1', 'LOGOUT_ALL'],
        ['1', 'LOGOUT_ALL'],
        ['2', null],
      ]);
    });

    it('lists only my active sessions and marks the current one', async () => {
      await login();
      await login();
      await login();
      await login('binh@pawflow.test');
      const [a, b, c] = h.state.sessions;
      a.revokedAt = new Date();
      a.revokedReason = 'LOGOUT';
      b.expiresAt = new Date(Date.now() - 1000);

      const sessions = await h.service.listSessions(asUser('1', c.id));

      expect(sessions).toEqual([
        { id: c.id, createdAt: expect.any(Date), lastUsedAt: expect.any(Date), expiresAt: expect.any(Date), userAgent: 'Spec/1.0', ipAddress: '127.0.0.1', current: true },
      ]);
    });

    it("revoking another user's session is 404 and changes nothing", async () => {
      await login('binh@pawflow.test');
      const other = h.state.sessions[0];

      await expect(h.service.revokeOwnSession(asUser('1', 'x'), other.id)).rejects.toThrow(
        new NotFoundException('Session not found'),
      );
      expect(other.revokedAt).toBeNull();
    });

    it('revokes one of my own sessions', async () => {
      await login();
      await login();
      const [a, b] = h.state.sessions;

      await h.service.revokeOwnSession(asUser('1', b.id), a.id);

      expect(a).toMatchObject({ revokedReason: 'SESSION_REVOKED' });
      expect(b.revokedAt).toBeNull();
    });

    it("account switch: user B's tokens never resolve to user A and A's logout leaves B intact", async () => {
      const a = await login();
      const b = await login('binh@pawflow.test');
      await h.service.logout(asUser('1', h.jwt.decode<JwtPayload>(a.accessToken).sid));

      const rotated = await h.service.refresh(b.refreshToken);

      expect(rotated.user.id).toBe('2');
      expect(h.jwt.decode<JwtPayload>(rotated.accessToken)).toMatchObject({ sub: '2', role: 'PROVIDER_OWNER' });
      await expect(h.service.refresh(a.refreshToken)).rejects.toThrow(UnauthorizedException);
    });
  });
});
