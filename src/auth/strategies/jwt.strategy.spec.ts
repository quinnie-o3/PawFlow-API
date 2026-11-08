import { UnauthorizedException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { Repository } from 'typeorm';

import type { AuthSession } from '../entities/auth-session.entity';
import type { JwtPayload } from '../interfaces/jwt-payload.interface';
import { JwtStrategy } from './jwt.strategy';

const SID = '6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b';

/** P3-BE01: an access token is only as valid as its session. */
describe('JwtStrategy session enforcement (P3-BE01)', () => {
  let session: Record<string, any> | null;
  let lookups: unknown[];
  let strategy: JwtStrategy;

  beforeEach(() => {
    lookups = [];
    session = {
      id: SID,
      userId: '7',
      revokedAt: null,
      expiresAt: new Date(Date.now() + 60_000),
      user: { id: '7', fullName: 'An', email: 'an@pawflow.test', phone: null, role: 'CUSTOMER', status: 'ACTIVE', passwordHash: 'secret-hash', createdAt: new Date(), updatedAt: new Date() },
    };
    strategy = new JwtStrategy(
      { getOrThrow: () => 'secret' } as unknown as ConfigService,
      {
        findOne: (options: unknown) => {
          lookups.push(options);
          return Promise.resolve(session);
        },
      } as unknown as Repository<AuthSession>,
    );
  });

  const payload = (overrides: Partial<JwtPayload> = {}) =>
    ({ sub: '7', email: 'an@pawflow.test', role: 'CUSTOMER', sid: SID, ...overrides }) as JwtPayload;

  it('accepts a token of an active session and exposes its id, never the password hash', async () => {
    const user = await strategy.validate(payload());

    expect(user).toMatchObject({ id: '7', role: 'CUSTOMER', sessionId: SID });
    expect(user).not.toHaveProperty('passwordHash');
    expect(lookups).toEqual([{ where: { id: SID, userId: '7' }, relations: { user: true } }]);
  });

  it.each([
    ['no sid (token issued before sessions)', { sid: undefined }],
    ['a malformed sid', { sid: 'not-a-uuid' }],
  ])('rejects %s without querying the database', async (_label, overrides) => {
    await expect(strategy.validate(payload(overrides as Partial<JwtPayload>))).rejects.toBeInstanceOf(UnauthorizedException);
    expect(lookups).toEqual([]);
  });

  it.each([
    ['an unknown session (or one of another user)', () => { session = null; }],
    ['a revoked session', () => { session!.revokedAt = new Date(); }],
    ['an expired session', () => { session!.expiresAt = new Date(Date.now() - 1); }],
    ['a suspended user', () => { session!.user.status = 'SUSPENDED'; }],
    ['an inactive user', () => { session!.user.status = 'INACTIVE'; }],
  ])('rejects %s', async (_label, arrange) => {
    arrange();

    await expect(strategy.validate(payload())).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
