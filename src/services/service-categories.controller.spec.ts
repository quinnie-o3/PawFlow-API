import { RequestMethod } from '@nestjs/common';
import {
  GUARDS_METADATA,
  METHOD_METADATA,
  PATH_METADATA,
  ROUTE_ARGS_METADATA,
} from '@nestjs/common/constants';
import type { Repository } from 'typeorm';

import { createFakeFindRepository } from '../../test/helpers/fake-find-repository';
import { Provider } from '../providers/entities/provider.entity';
import { ServiceCategory } from './entities/service-category.entity';
import { Service } from './entities/service.entity';
import { ServiceCategoriesController } from './service-categories.controller';
import { ServicesService } from './services.service';

function createController(rows: Array<Record<string, unknown>>) {
  const repository = createFakeFindRepository(rows);
  const servicesService = new ServicesService(
    {} as Repository<Service>,
    repository as unknown as Repository<ServiceCategory>,
    {} as Repository<Provider>,
  );

  return {
    controller: new ServiceCategoriesController(servicesService),
    repository,
  };
}

const row = (
  id: string,
  name: string,
  status: 'ACTIVE' | 'INACTIVE',
  description: string | null = null,
) => ({
  id,
  name,
  description,
  status,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-02T00:00:00.000Z'),
});

describe('GET /service-categories (ServiceCategoriesController)', () => {
  it('returns an empty array when there are no records', async () => {
    const { controller } = createController([]);

    await expect(controller.getActiveServiceCategories()).resolves.toEqual([]);
  });

  it('returns an empty array when all records are inactive', async () => {
    const { controller } = createController([
      row('1', 'Grooming', 'INACTIVE'),
    ]);

    await expect(controller.getActiveServiceCategories()).resolves.toEqual([]);
  });

  it('returns only ACTIVE records from mixed statuses', async () => {
    const { controller } = createController([
      row('1', 'Grooming', 'ACTIVE', 'Coat care'),
      row('2', 'Boarding', 'INACTIVE'),
      row('3', 'Veterinary', 'ACTIVE'),
    ]);

    await expect(controller.getActiveServiceCategories()).resolves.toEqual([
      { id: '1', name: 'Grooming', description: 'Coat care' },
      { id: '3', name: 'Veterinary', description: null },
    ]);
  });

  it('projects only id, name and description, with BIGINT ids as strings', async () => {
    const { controller } = createController([
      row('9223372036854775807', 'Grooming', 'ACTIVE'),
    ]);

    const [category] = await controller.getActiveServiceCategories();

    expect(Object.keys(category).sort()).toEqual([
      'description',
      'id',
      'name',
    ]);
    expect(category.id).toBe('9223372036854775807');
    expect(typeof category.id).toBe('string');
  });

  it('orders by name with an id tie-breaker', async () => {
    const { controller } = createController([
      row('10', 'Grooming', 'ACTIVE'),
      row('2', 'Grooming', 'ACTIVE'),
      row('5', 'Boarding', 'ACTIVE'),
    ]);

    const result = await controller.getActiveServiceCategories();

    expect(result.map((category) => category.id)).toEqual(['5', '2', '10']);
  });

  it('always queries status ACTIVE with an explicit projection', async () => {
    const { controller, repository } = createController([]);

    await controller.getActiveServiceCategories();

    expect(repository.find).toHaveBeenCalledWith({
      select: { id: true, name: true, description: true },
      where: { status: 'ACTIVE' },
      order: { name: 'ASC', id: 'ASC' },
    });
  });

  describe('route security', () => {
    it('is public: no guards on the controller or handler', () => {
      expect(
        Reflect.getMetadata(GUARDS_METADATA, ServiceCategoriesController),
      ).toBeUndefined();
      expect(
        Reflect.getMetadata(
          GUARDS_METADATA,
          ServiceCategoriesController.prototype.getActiveServiceCategories,
        ),
      ).toBeUndefined();
    });

    it('exposes a single GET route at /service-categories and no mutations', () => {
      const handlers = Object.getOwnPropertyNames(
        ServiceCategoriesController.prototype,
      ).filter((name) => name !== 'constructor');

      expect(
        Reflect.getMetadata(PATH_METADATA, ServiceCategoriesController),
      ).toBe('service-categories');
      expect(handlers).toEqual(['getActiveServiceCategories']);
      expect(
        Reflect.getMetadata(
          METHOD_METADATA,
          ServiceCategoriesController.prototype.getActiveServiceCategories,
        ),
      ).toBe(RequestMethod.GET);
    });

    it('binds no query/body/param input, so status cannot be manipulated', () => {
      expect(
        Reflect.getMetadata(
          ROUTE_ARGS_METADATA,
          ServiceCategoriesController,
          'getActiveServiceCategories',
        ),
      ).toBeUndefined();
      expect(
        ServiceCategoriesController.prototype.getActiveServiceCategories.length,
      ).toBe(0);
    });
  });
});
