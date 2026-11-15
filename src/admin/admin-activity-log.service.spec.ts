import { BadRequestException } from '@nestjs/common';
import type { DataSource, EntityManager } from 'typeorm';

import { runWithJobContext, runWithRequestContext } from '../common/observability/observability-context';
import { AdminActivityLogService } from './admin-activity-log.service';
import type { AdminActivityLogQueryDto } from './dto/admin-activity-log-query.dto';
import { AdminActivityLog } from './entities/admin-activity-log.entity';

/** EntityManager stand-in capturing what record() persists through the caller's transaction. */
function transactionManager() {
  const saved: Array<Record<string, unknown>> = [];
  const repository = {
    create: (value: Record<string, unknown>) => ({ ...value }),
    save: (value: Record<string, unknown>) => {
      saved.push(value);
      return Promise.resolve(value);
    },
  };
  const getRepository = jest.fn(() => repository);
  return { saved, getRepository, manager: { getRepository } as unknown as EntityManager };
}

const dataSource = { getRepository: jest.fn() } as unknown as DataSource;
const service = new AdminActivityLogService(dataSource);
const INPUT = {
  adminUserId: '40',
  action: 'PROVIDER_SUSPENDED' as const,
  targetType: 'PROVIDER' as const,
  targetId: '7',
  metadata: { fromStatus: 'APPROVED', toStatus: 'SUSPENDED' },
};

describe('AdminActivityLogService.record (P3-BE09 correlation)', () => {
  it('persists through the caller transaction manager, unchanged outside a request', async () => {
    const tx = transactionManager();
    await service.record(tx.manager, INPUT);
    expect(tx.getRepository).toHaveBeenCalledWith(AdminActivityLog);
    expect(tx.saved).toEqual([{ ...INPUT }]);
  });

  it('keeps null metadata as null outside a request (job contexts add nothing)', async () => {
    const tx = transactionManager();
    await runWithJobContext({ jobId: '5' }, () => service.record(tx.manager, { ...INPUT, metadata: null }));
    expect(tx.saved[0].metadata).toBeNull();
  });

  it('adds the request correlation ID to metadata without touching actor, target or the caller object', async () => {
    const tx = transactionManager();
    const metadata = { ...INPUT.metadata };
    await runWithRequestContext({ requestId: 'audit-req-0001', startedAt: 0n }, () => service.record(tx.manager, { ...INPUT, metadata }));
    expect(tx.saved).toEqual([{ ...INPUT, metadata: { fromStatus: 'APPROVED', toStatus: 'SUSPENDED', requestId: 'audit-req-0001' } }]);
    expect(metadata).toEqual(INPUT.metadata);
  });

  it('records only the requestId when the action has no metadata', async () => {
    const tx = transactionManager();
    await runWithRequestContext({ requestId: 'audit-req-0002', startedAt: 0n }, () => service.record(tx.manager, { ...INPUT, metadata: undefined }));
    expect(tx.saved[0].metadata).toEqual({ requestId: 'audit-req-0002' });
  });

  it('attributes concurrent actions to their own request IDs', async () => {
    const tx = transactionManager();
    await Promise.all(
      ['a', 'b', 'c', 'd'].map((suffix, i) =>
        runWithRequestContext({ requestId: `audit-concurrent-${suffix}`, startedAt: 0n }, async () => {
          await new Promise((resolve) => setTimeout(resolve, 8 - i * 2));
          await service.record(tx.manager, { ...INPUT, targetId: String(100 + i) });
        }),
      ),
    );
    const byTarget = Object.fromEntries(tx.saved.map((row) => [row.targetId, (row.metadata as { requestId: string }).requestId]));
    expect(byTarget).toEqual({ '100': 'audit-concurrent-a', '101': 'audit-concurrent-b', '102': 'audit-concurrent-c', '103': 'audit-concurrent-d' });
  });

  it('propagates a persistence failure to the caller (whose transaction then rolls back)', async () => {
    const manager = {
      getRepository: () => ({ create: (v: unknown) => v, save: () => Promise.reject(new Error('insert failed')) }),
    } as unknown as EntityManager;
    await expect(service.record(manager, INPUT)).rejects.toThrow('insert failed');
  });
});

describe('AdminActivityLogService queries (unchanged contract)', () => {
  it('rejects an inverted date range before querying', async () => {
    await expect(
      service.getActivityLogs({ from: '2026-11-15', to: '2026-11-01', limit: 20, offset: 0 } as AdminActivityLogQueryDto),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(dataSource.getRepository).not.toHaveBeenCalled();
  });
});
