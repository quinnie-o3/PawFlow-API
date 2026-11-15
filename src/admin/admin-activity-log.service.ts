import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';

import { currentRequestId } from '../common/observability/observability-context';
import {
  type AdminActivityAction,
  type AdminActivityTargetType,
} from './admin-activity-log.constants';
import { AdminActivityLogQueryDto } from './dto/admin-activity-log-query.dto';
import { AdminActivityLog } from './entities/admin-activity-log.entity';

type AdminActivityLogInput = {
  adminUserId: string;
  action: AdminActivityAction;
  targetType: AdminActivityTargetType;
  targetId: string;
  metadata?: Record<string, unknown> | null;
};

@Injectable()
export class AdminActivityLogService {
  constructor(private readonly dataSource: DataSource) {}

  /**
   * Persists the audit row through the caller's transaction manager, so the
   * row commits or rolls back together with the business mutation.
   *
   * P3-BE09: when the action runs inside an HTTP request, the request's
   * correlation ID is added as `metadata.requestId` (no schema change; older
   * rows simply lack the key). It links the row to the request's log lines;
   * it is not evidence of who acted: actor identity is `adminUserId`, taken
   * from the authenticated session, and the ID may have been chosen by the
   * client (validated, see request-id.ts).
   */
  async record(
    manager: EntityManager,
    input: AdminActivityLogInput,
  ): Promise<void> {
    const repository = manager.getRepository(AdminActivityLog);
    const requestId = currentRequestId();
    const activityLog = repository.create({
      adminUserId: input.adminUserId,
      action: input.action,
      targetType: input.targetType,
      targetId: input.targetId,
      metadata: requestId
        ? { ...input.metadata, requestId }
        : (input.metadata ?? null),
    });

    await repository.save(activityLog);
  }

  async getActivityLogs(query: AdminActivityLogQueryDto) {
    if (query.from && query.to && new Date(query.from) > new Date(query.to)) {
      throw new BadRequestException('from must be before or equal to to');
    }

    const queryBuilder = this.dataSource
      .getRepository(AdminActivityLog)
      .createQueryBuilder('activityLog')
      .select([
        'activityLog.id',
        'activityLog.adminUserId',
        'activityLog.action',
        'activityLog.targetType',
        'activityLog.targetId',
        'activityLog.metadata',
        'activityLog.createdAt',
      ]);

    if (query.action) {
      queryBuilder.andWhere('activityLog.action = :action', {
        action: query.action,
      });
    }

    if (query.targetType) {
      queryBuilder.andWhere('activityLog.targetType = :targetType', {
        targetType: query.targetType,
      });
    }

    if (query.targetId) {
      queryBuilder.andWhere('activityLog.targetId = :targetId', {
        targetId: query.targetId,
      });
    }

    if (query.adminUserId) {
      queryBuilder.andWhere('activityLog.adminUserId = :adminUserId', {
        adminUserId: query.adminUserId,
      });
    }

    if (query.from) {
      queryBuilder.andWhere('activityLog.createdAt >= :from', {
        from: new Date(query.from),
      });
    }

    if (query.to) {
      queryBuilder.andWhere('activityLog.createdAt <= :to', {
        to: new Date(query.to),
      });
    }

    const [activityLogs, total] = await queryBuilder
      .orderBy('activityLog.createdAt', 'DESC')
      .addOrderBy('activityLog.id', 'DESC')
      .skip(query.offset)
      .take(query.limit)
      .getManyAndCount();

    return {
      items: activityLogs.map((activityLog) =>
        this.toSafeResponse(activityLog),
      ),
      pagination: {
        limit: query.limit,
        offset: query.offset,
        total,
      },
    };
  }

  async getActivityLogById(activityLogId: string) {
    const activityLog = await this.dataSource
      .getRepository(AdminActivityLog)
      .createQueryBuilder('activityLog')
      .select([
        'activityLog.id',
        'activityLog.adminUserId',
        'activityLog.action',
        'activityLog.targetType',
        'activityLog.targetId',
        'activityLog.metadata',
        'activityLog.createdAt',
      ])
      .where('activityLog.id = :activityLogId', { activityLogId })
      .getOne();

    if (!activityLog) {
      throw new NotFoundException('Admin activity log not found');
    }

    return this.toSafeResponse(activityLog);
  }

  private toSafeResponse(activityLog: AdminActivityLog) {
    return {
      id: activityLog.id,
      adminUserId: activityLog.adminUserId,
      action: activityLog.action,
      targetType: activityLog.targetType,
      targetId: activityLog.targetId,
      metadata: activityLog.metadata,
      createdAt: activityLog.createdAt,
    };
  }
}
