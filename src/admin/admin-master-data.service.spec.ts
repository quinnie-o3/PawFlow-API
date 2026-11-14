import { ConflictException } from '@nestjs/common';
import { QueryFailedError, type DataSource } from 'typeorm';

import { AdminActivityLogService } from './admin-activity-log.service';
import { AdminMasterDataService } from './admin-master-data.service';

describe('AdminMasterDataService name updates', () => {
  const adminUserId = '1';

  let repository: { createQueryBuilder: jest.Mock; save: jest.Mock };
  let activityLogService: { record: jest.Mock };
  let service: AdminMasterDataService;

  beforeEach(() => {
    const existing = {
      id: '2',
      name: 'Dogs',
      description: null,
      status: 'ACTIVE',
    };
    const queryBuilder = {
      setLock: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      getOne: jest.fn().mockResolvedValue(existing),
    };

    repository = {
      createQueryBuilder: jest.fn().mockReturnValue(queryBuilder),
      save: jest.fn((value: object) => Promise.resolve(value)),
    };
    activityLogService = { record: jest.fn().mockResolvedValue(undefined) };

    const manager = { getRepository: jest.fn().mockReturnValue(repository) };
    const dataSource = {
      transaction: jest.fn((work: (m: typeof manager) => unknown) =>
        work(manager),
      ),
    };

    service = new AdminMasterDataService(
      dataSource as unknown as DataSource,
      activityLogService as unknown as AdminActivityLogService,
    );
  });

  const duplicateNameError = () =>
    new QueryFailedError(
      'UPDATE ...',
      [],
      Object.assign(new Error('duplicate key value'), { code: '23505' }),
    );

  it('updates a pet type name', async () => {
    await expect(
      service.updatePetType(adminUserId, '2', { name: 'Cats' }),
    ).resolves.toMatchObject({ id: '2', name: 'Cats' });
    expect(activityLogService.record).toHaveBeenCalledTimes(1);
  });

  it('keeps empty-body PATCH as a no-op without an activity log', async () => {
    await expect(
      service.updatePetType(adminUserId, '2', {}),
    ).resolves.toMatchObject({ name: 'Dogs' });
    expect(activityLogService.record).not.toHaveBeenCalled();
  });

  it('maps a duplicate pet type name to 409', async () => {
    repository.save.mockRejectedValue(duplicateNameError());

    await expect(
      service.updatePetType(adminUserId, '2', { name: 'Cats' }),
    ).rejects.toThrow(new ConflictException('Pet type name already exists'));
  });

  it('maps a duplicate service category name to 409', async () => {
    repository.save.mockRejectedValue(duplicateNameError());

    await expect(
      service.updateServiceCategory(adminUserId, '2', { name: 'Grooming' }),
    ).rejects.toThrow(
      new ConflictException('Service category name already exists'),
    );
  });
});
