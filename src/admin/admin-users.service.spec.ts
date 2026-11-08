import { ConflictException } from '@nestjs/common';
import type { DataSource } from 'typeorm';

import { AuthSession } from '../auth/entities/auth-session.entity';
import { User } from '../users/entities/user.entity';
import { AdminActivityLogService } from './admin-activity-log.service';
import { AdminUsersService } from './admin-users.service';

describe('AdminUsersService suspension (C-07)', () => {
  const adminUserId = '1';

  let users: Map<string, Partial<User>>;
  let save: jest.Mock;
  let record: jest.Mock;
  // Session revocations issued inside the transaction (P3-BE01).
  let revokeSessions: jest.Mock;
  let service: AdminUsersService;

  beforeEach(() => {
    users = new Map<string, Partial<User>>([
      ['1', { id: '1', role: 'ADMIN', status: 'ACTIVE' }],
      ['2', { id: '2', role: 'ADMIN', status: 'ACTIVE' }],
      ['3', { id: '3', role: 'CUSTOMER', status: 'ACTIVE' }],
      ['4', { id: '4', role: 'PROVIDER_OWNER', status: 'ACTIVE' }],
      ['5', { id: '5', role: 'ADMIN', status: 'SUSPENDED' }],
    ]);

    save = jest.fn((value: User) => {
      users.set(value.id, { ...value });
      return Promise.resolve(value);
    });
    record = jest.fn().mockResolvedValue(undefined);

    const usersRepository = {
      createQueryBuilder: jest.fn(() => {
        let userId: string | undefined;
        const builder: Record<string, jest.Mock> = {};

        Object.assign(builder, {
          setLock: jest.fn(() => builder),
          select: jest.fn(() => builder),
          where: jest.fn((_expression: string, params: { userId: string }) => {
            userId = params.userId;
            return builder;
          }),
          getOne: jest.fn(() =>
            Promise.resolve(userId && users.has(userId) ? { ...users.get(userId) } : null),
          ),
          getOneOrFail: jest.fn(() => Promise.resolve({ ...users.get(userId as string) })),
        });

        return builder;
      }),
      save,
    };

    revokeSessions = jest.fn().mockResolvedValue({ affected: 2 });
    const sessionsRepository = { update: revokeSessions };
    const manager = {
      getRepository: jest.fn((entity: unknown) =>
        entity === AuthSession ? sessionsRepository : usersRepository,
      ),
    };
    const dataSource = {
      transaction: jest.fn((work: (m: typeof manager) => unknown) => work(manager)),
    };

    service = new AdminUsersService(
      dataSource as unknown as DataSource,
      { record } as unknown as AdminActivityLogService,
    );
  });

  it.each([
    ['CUSTOMER', '3'],
    ['PROVIDER_OWNER', '4'],
  ])('suspends an ACTIVE %s and records USER_SUSPENDED', async (_role, userId) => {
    await expect(service.suspendUser(adminUserId, userId)).resolves.toMatchObject({
      id: userId,
      status: 'SUSPENDED',
    });
    expect(record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'USER_SUSPENDED', targetId: userId }),
    );
  });

  it('rejects suspending another ADMIN with 409 and writes nothing', async () => {
    await expect(service.suspendUser(adminUserId, '2')).rejects.toThrow(
      new ConflictException('Administrator accounts cannot be suspended'),
    );
    expect(save).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
    expect(users.get('2')).toMatchObject({ status: 'ACTIVE' });
  });

  it('keeps rejecting self-suspension with 409 and writes nothing', () => {
    // Existing guard runs synchronously before the transaction starts.
    expect(() => service.suspendUser(adminUserId, adminUserId)).toThrow(
      new ConflictException('Administrators cannot suspend their own account'),
    );
    expect(save).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
  });

  it('keeps the ACTIVE-status rule for non-admin targets', async () => {
    users.set('3', { id: '3', role: 'CUSTOMER', status: 'SUSPENDED' });

    await expect(service.suspendUser(adminUserId, '3')).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(record).not.toHaveBeenCalled();
  });

  it('revokes every active session of the suspended user in the same transaction (P3-BE01)', async () => {
    await service.suspendUser(adminUserId, '3');

    expect(revokeSessions).toHaveBeenCalledTimes(1);
    const [criteria, changes] = revokeSessions.mock.calls[0] as [
      Record<string, unknown>,
      Record<string, unknown>,
    ];
    expect(criteria).toMatchObject({ userId: '3' });
    expect(JSON.stringify(criteria.revokedAt)).toContain('isNull');
    expect(changes).toMatchObject({ revokedReason: 'ACCOUNT_SUSPENDED' });
    expect(changes.revokedAt).toBeInstanceOf(Date);
  });

  it('revokes nothing when the suspension is rejected', async () => {
    await expect(service.suspendUser(adminUserId, '2')).rejects.toBeInstanceOf(ConflictException);

    expect(revokeSessions).not.toHaveBeenCalled();
  });

  it('does not touch sessions on reactivation (old sessions stay revoked)', async () => {
    await service.reactivateUser(adminUserId, '5');

    expect(revokeSessions).not.toHaveBeenCalled();
  });

  it('does not restrict reactivation (unchanged)', async () => {
    await expect(service.reactivateUser(adminUserId, '5')).resolves.toMatchObject({
      id: '5',
      status: 'ACTIVE',
    });
    expect(record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'USER_REACTIVATED' }),
    );
  });
});
