import { RequestMethod } from '@nestjs/common';
import {
  GUARDS_METADATA,
  METHOD_METADATA,
  PATH_METADATA,
  ROUTE_ARGS_METADATA,
} from '@nestjs/common/constants';
import type { Repository } from 'typeorm';

import { createFakeFindRepository } from '../../test/helpers/fake-find-repository';
import { OwnershipService } from '../auth/authorization/ownership.service';
import { PetType } from './entities/pet-type.entity';
import { Pet } from './entities/pet.entity';
import { PetTypesController } from './pet-types.controller';
import { PetsService } from './pets.service';

function createController(rows: Array<Record<string, unknown>>) {
  const repository = createFakeFindRepository(rows);
  const petsService = new PetsService(
    {} as Repository<Pet>,
    repository as unknown as Repository<PetType>,
    {} as OwnershipService,
  );

  return { controller: new PetTypesController(petsService), repository };
}

const row = (id: string, name: string, status: 'ACTIVE' | 'INACTIVE') => ({
  id,
  name,
  status,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-02T00:00:00.000Z'),
});

describe('GET /pet-types (PetTypesController)', () => {
  it('returns an empty array when there are no records', async () => {
    const { controller } = createController([]);

    await expect(controller.getActivePetTypes()).resolves.toEqual([]);
  });

  it('returns an empty array when all records are inactive', async () => {
    const { controller } = createController([row('1', 'Dog', 'INACTIVE')]);

    await expect(controller.getActivePetTypes()).resolves.toEqual([]);
  });

  it('returns only ACTIVE records from mixed statuses', async () => {
    const { controller } = createController([
      row('1', 'Dog', 'ACTIVE'),
      row('2', 'Cat', 'INACTIVE'),
      row('3', 'Bird', 'ACTIVE'),
    ]);

    await expect(controller.getActivePetTypes()).resolves.toEqual([
      { id: '3', name: 'Bird' },
      { id: '1', name: 'Dog' },
    ]);
  });

  it('projects only id and name, with BIGINT ids as strings', async () => {
    const { controller } = createController([
      row('9223372036854775807', 'Dog', 'ACTIVE'),
    ]);

    const [petType] = await controller.getActivePetTypes();

    expect(Object.keys(petType).sort()).toEqual(['id', 'name']);
    expect(petType.id).toBe('9223372036854775807');
    expect(typeof petType.id).toBe('string');
  });

  it('orders by name with an id tie-breaker', async () => {
    const { controller } = createController([
      row('10', 'Dog', 'ACTIVE'),
      row('2', 'Dog', 'ACTIVE'),
      row('5', 'Cat', 'ACTIVE'),
    ]);

    await expect(controller.getActivePetTypes()).resolves.toEqual([
      { id: '5', name: 'Cat' },
      { id: '2', name: 'Dog' },
      { id: '10', name: 'Dog' },
    ]);
  });

  it('always queries status ACTIVE with an explicit projection', async () => {
    const { controller, repository } = createController([]);

    await controller.getActivePetTypes();

    expect(repository.find).toHaveBeenCalledWith({
      select: { id: true, name: true },
      where: { status: 'ACTIVE' },
      order: { name: 'ASC', id: 'ASC' },
    });
  });

  describe('route security', () => {
    it('is public: no guards on the controller or handler', () => {
      expect(Reflect.getMetadata(GUARDS_METADATA, PetTypesController)).toBeUndefined();
      expect(
        Reflect.getMetadata(
          GUARDS_METADATA,
          PetTypesController.prototype.getActivePetTypes,
        ),
      ).toBeUndefined();
    });

    it('exposes a single GET route at /pet-types and no mutations', () => {
      const handlers = Object.getOwnPropertyNames(
        PetTypesController.prototype,
      ).filter((name) => name !== 'constructor');

      expect(Reflect.getMetadata(PATH_METADATA, PetTypesController)).toBe(
        'pet-types',
      );
      expect(handlers).toEqual(['getActivePetTypes']);
      expect(
        Reflect.getMetadata(
          METHOD_METADATA,
          PetTypesController.prototype.getActivePetTypes,
        ),
      ).toBe(RequestMethod.GET);
    });

    it('binds no query/body/param input, so status cannot be manipulated', () => {
      expect(
        Reflect.getMetadata(
          ROUTE_ARGS_METADATA,
          PetTypesController,
          'getActivePetTypes',
        ),
      ).toBeUndefined();
      expect(PetTypesController.prototype.getActivePetTypes.length).toBe(0);
    });
  });
});
