import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DataSource, Repository } from 'typeorm';

import { User } from '../users/entities/user.entity';
import { type AdminActivityAction } from './admin-activity-log.constants';
import { AdminActivityLogService } from './admin-activity-log.service';
import {
  AdminUserQueryDto,
  AdminUserStatus,
} from './dto/admin-user-query.dto';

type AdminUserResponse = {
  id: string;
  fullName: string;
  email: string;
  phone: string | null;
  role: User['role'];
  status: User['status'];
  createdAt: Date;
  updatedAt: Date;
};

@Injectable()
export class AdminUsersService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly adminActivityLogService: AdminActivityLogService,
  ) {}

  async getUsers(query: AdminUserQueryDto) {
    const usersRepository = this.dataSource.getRepository(User);
    const queryBuilder = this.createSafeUserQuery(usersRepository);

    if (query.role) {
      queryBuilder.where('user.role = :role', { role: query.role });
    }

    if (query.status) {
      const applyStatusCondition = query.role
        ? queryBuilder.andWhere.bind(queryBuilder)
        : queryBuilder.where.bind(queryBuilder);

      applyStatusCondition('user.status = :status', { status: query.status });
    }

    const users = await queryBuilder
      .orderBy('user.createdAt', 'DESC')
      .getMany();

    return users.map((user) => this.toSafeResponse(user));
  }

  async getUserById(userId: string) {
    const usersRepository = this.dataSource.getRepository(User);
    const user = await this.createSafeUserQuery(usersRepository)
      .where('user.id = :userId', { userId })
      .getOne();

    if (!user) {
      throw new NotFoundException('User not found');
    }

    return this.toSafeResponse(user);
  }

  suspendUser(adminUserId: string, userId: string) {
    if (adminUserId === userId) {
      throw new ConflictException('Administrators cannot suspend their own account');
    }

    return this.transitionUser(
      adminUserId,
      userId,
      'ACTIVE',
      'SUSPENDED',
      'suspend',
      'USER_SUSPENDED',
      { rejectAdminTarget: true },
    );
  }

  reactivateUser(adminUserId: string, userId: string) {
    return this.transitionUser(
      adminUserId,
      userId,
      'SUSPENDED',
      'ACTIVE',
      'reactivate',
      'USER_REACTIVATED',
    );
  }

  private async transitionUser(
    adminUserId: string,
    userId: string,
    expectedStatus: AdminUserStatus,
    nextStatus: AdminUserStatus,
    action: string,
    activityAction: AdminActivityAction,
    options: { rejectAdminTarget?: boolean } = {},
  ) {
    return this.dataSource.transaction(async (manager) => {
      const usersRepository = manager.getRepository(User);
      const user = await usersRepository
        .createQueryBuilder('user')
        .setLock('pessimistic_write')
        .where('user.id = :userId', { userId })
        .getOne();

      if (!user) {
        throw new NotFoundException('User not found');
      }

      // C-07: administrators cannot be suspended through the ordinary user
      // API. Thrown before any write, so no status change or audit record.
      if (options.rejectAdminTarget && user.role === 'ADMIN') {
        throw new ConflictException(
          'Administrator accounts cannot be suspended',
        );
      }

      if (user.status !== expectedStatus) {
        throw new ConflictException(
          `User must be ${expectedStatus} to ${action}`,
        );
      }

      const fromStatus = user.status;
      user.status = nextStatus;
      await usersRepository.save(user);
      await this.adminActivityLogService.record(manager, {
        adminUserId,
        action: activityAction,
        targetType: 'USER',
        targetId: user.id,
        metadata: {
          fromStatus,
          toStatus: nextStatus,
          targetRole: user.role,
        },
      });

      const updatedUser = await this.createSafeUserQuery(usersRepository)
        .where('user.id = :userId', { userId })
        .getOneOrFail();

      return this.toSafeResponse(updatedUser);
    });
  }

  private createSafeUserQuery(usersRepository: Repository<User>) {
    return usersRepository
      .createQueryBuilder('user')
      .select([
        'user.id',
        'user.fullName',
        'user.email',
        'user.phone',
        'user.role',
        'user.status',
        'user.createdAt',
        'user.updatedAt',
      ]);
  }

  private toSafeResponse(user: User): AdminUserResponse {
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
}
