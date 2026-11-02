import {
  BadRequestException,
  NotFoundException,
  RequestMethod,
} from '@nestjs/common';
import {
  GUARDS_METADATA,
  METHOD_METADATA,
  MODULE_METADATA,
  PATH_METADATA,
} from '@nestjs/common/constants';
import type { Repository } from 'typeorm';

import { ROLES_KEY } from '../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { ParseBigIntIdPipe } from '../common/pipes/parse-bigint-id.pipe';
import { Provider } from '../providers/entities/provider.entity';
import { ServiceCategory } from './entities/service-category.entity';
import { Service } from './entities/service.entity';
import { PublicServicesController } from './public-services.controller';
import { ServicesController } from './services.controller';
import { ServicesModule } from './services.module';
import { ServicesService } from './services.service';

type Row = Record<string, unknown>;

/**
 * Minimal in-memory stand-in for the TypeORM SelectQueryBuilder calls used by
 * the public service queries. It evaluates the real `alias.field = :param`
 * conditions issued by the service against nested rows, so visibility rules
 * are exercised rather than assumed.
 */
function createFakeQueryBuilder(rows: Row[]) {
  const conditions: Array<(row: Row) => boolean> = [];
  const orderings: Array<[string, 'ASC' | 'DESC']> = [];

  const resolve = (row: Row, path: string) => {
    const [alias, field] = path.split('.');
    const source = alias === 'service' ? row : (row[alias] as Row);

    return source[field];
  };

  const addCondition = (expression: string, params: Row) => {
    const match = /^(\w+\.\w+) = :(\w+)$/.exec(expression);

    if (!match) {
      throw new Error(`Unsupported condition in fake: ${expression}`);
    }

    const [, path, param] = match;
    conditions.push((row) => resolve(row, path) === params[param]);
  };

  const getMany = (): Promise<Row[]> => {
    const matched = rows.filter((row) =>
      conditions.every((condition) => condition(row)),
    );

    matched.sort((a, b) => {
      for (const [path, direction] of orderings) {
        const left = resolve(a, path);
        const right = resolve(b, path);
        const result =
          path === 'service.id'
            ? Number(BigInt(left as string) - BigInt(right as string))
            : (left as Date).getTime() - (right as Date).getTime();

        if (result !== 0) {
          return direction === 'ASC' ? result : -result;
        }
      }

      return 0;
    });

    return Promise.resolve(matched);
  };

  const builder: Record<string, jest.Mock> = {};

  Object.assign(builder, {
    innerJoinAndSelect: jest.fn(() => builder),
    where: jest.fn((expression: string, params: Row) => {
      addCondition(expression, params);
      return builder;
    }),
    andWhere: jest.fn((expression: string, params: Row) => {
      addCondition(expression, params);
      return builder;
    }),
    orderBy: jest.fn((path: string, direction: 'ASC' | 'DESC') => {
      orderings.push([path, direction]);
      return builder;
    }),
    addOrderBy: jest.fn((path: string, direction: 'ASC' | 'DESC') => {
      orderings.push([path, direction]);
      return builder;
    }),
    getMany: jest.fn(getMany),
    getOne: jest.fn(() => getMany().then((matched) => matched[0] ?? null)),
  });

  return builder;
}

function createController(rows: Row[]) {
  const servicesRepository = {
    createQueryBuilder: jest.fn(() => createFakeQueryBuilder(rows)),
  };
  const servicesService = new ServicesService(
    servicesRepository as unknown as Repository<Service>,
    {} as Repository<ServiceCategory>,
    {} as Repository<Provider>,
  );

  return new PublicServicesController(servicesService);
}

// Full entity graph as TypeORM hydrates it, including internal fields.
const serviceRow = (
  id: string,
  overrides: {
    status?: 'ACTIVE' | 'INACTIVE';
    approvalStatus?: Provider['approvalStatus'];
    categoryStatus?: 'ACTIVE' | 'INACTIVE';
    createdAt?: string;
  } = {},
): Row => ({
  id,
  providerId: '1',
  categoryId: '2',
  name: `Service ${id}`,
  price: '150000.00',
  durationMinutes: 60,
  description: 'Full grooming',
  status: overrides.status ?? 'ACTIVE',
  createdAt: new Date(overrides.createdAt ?? '2026-10-01T00:00:00.000Z'),
  updatedAt: new Date('2026-10-02T00:00:00.000Z'),
  provider: {
    id: '1',
    ownerId: '77',
    businessName: 'Paw Spa',
    address: '1 Nguyen Hue, District 1',
    phone: '0901234567',
    description: 'Grooming studio',
    approvalStatus: overrides.approvalStatus ?? 'APPROVED',
    ratingAvg: '4.50',
    ratingCount: 2,
    createdAt: new Date('2026-09-01T00:00:00.000Z'),
    updatedAt: new Date('2026-09-02T00:00:00.000Z'),
  },
  category: {
    id: '2',
    name: 'Grooming',
    description: 'Coat care',
    status: overrides.categoryStatus ?? 'ACTIVE',
    createdAt: new Date('2026-08-01T00:00:00.000Z'),
    updatedAt: new Date('2026-08-02T00:00:00.000Z'),
  },
});

describe('Public services (F-10)', () => {
  describe('registration and routing', () => {
    it('registers PublicServicesController in ServicesModule', () => {
      const controllers = Reflect.getMetadata(
        MODULE_METADATA.CONTROLLERS,
        ServicesModule,
      ) as unknown[];

      expect(controllers).toContain(PublicServicesController);
      expect(controllers).toContain(ServicesController);
    });

    it('mounts list and detail GET routes under services/public', () => {
      const { prototype } = PublicServicesController;

      expect(Reflect.getMetadata(PATH_METADATA, PublicServicesController)).toBe(
        'services/public',
      );
      expect(Reflect.getMetadata(PATH_METADATA, prototype.getPublicServices)).toBe(
        '/',
      );
      expect(
        Reflect.getMetadata(PATH_METADATA, prototype.getPublicServiceById),
      ).toBe(':id');
      expect(
        Reflect.getMetadata(METHOD_METADATA, prototype.getPublicServices),
      ).toBe(RequestMethod.GET);
      expect(
        Reflect.getMetadata(METHOD_METADATA, prototype.getPublicServiceById),
      ).toBe(RequestMethod.GET);
    });

    it('is public and exposes no mutations', () => {
      const handlers = Object.getOwnPropertyNames(
        PublicServicesController.prototype,
      ).filter((name) => name !== 'constructor');

      expect(
        Reflect.getMetadata(GUARDS_METADATA, PublicServicesController),
      ).toBeUndefined();
      expect(handlers.sort()).toEqual([
        'getPublicServiceById',
        'getPublicServices',
      ]);
    });

    it('does not collide with ServicesController parameterized routes', () => {
      const ownerRoutes = Object.getOwnPropertyNames(
        ServicesController.prototype,
      )
        .filter((name) => name !== 'constructor')
        .map((name) =>
          Reflect.getMetadata(
            PATH_METADATA,
            (ServicesController.prototype as unknown as Record<string, object>)[
              name
            ],
          ) as string,
        );

      // A bare ':id' route on /services would shadow /services/public.
      expect(ownerRoutes).not.toContain(':id');
      expect(ownerRoutes.every((path) => path === '/' || path.startsWith('mine'))).toBe(
        true,
      );
    });
  });

  describe('visibility filtering', () => {
    const rows = [
      serviceRow('1'),
      serviceRow('2', { status: 'INACTIVE' }),
      serviceRow('3', { approvalStatus: 'PENDING' }),
      serviceRow('4', { approvalStatus: 'REJECTED' }),
      serviceRow('5', { approvalStatus: 'SUSPENDED' }),
      serviceRow('6', { categoryStatus: 'INACTIVE' }),
    ];

    it('lists only ACTIVE services of APPROVED providers in ACTIVE categories', async () => {
      const result = await createController(rows).getPublicServices();

      expect(result.map((service) => service.id)).toEqual(['1']);
    });

    it('returns an empty list when nothing is visible', async () => {
      await expect(
        createController([serviceRow('2', { status: 'INACTIVE' })]).getPublicServices(),
      ).resolves.toEqual([]);
    });

    it('returns detail for a visible service', async () => {
      await expect(
        createController(rows).getPublicServiceById('1'),
      ).resolves.toMatchObject({ id: '1', name: 'Service 1' });
    });

    it.each([
      ['2', 'INACTIVE service'],
      ['3', 'PENDING provider'],
      ['4', 'REJECTED provider'],
      ['5', 'SUSPENDED provider'],
      ['6', 'INACTIVE category'],
      ['999', 'nonexistent service'],
    ])('returns 404 for service %s (%s)', async (id) => {
      await expect(
        createController(rows).getPublicServiceById(id),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('orders by createdAt DESC with an id tie-breaker', async () => {
      const result = await createController([
        serviceRow('10', { createdAt: '2026-10-01T00:00:00.000Z' }),
        serviceRow('11', { createdAt: '2026-10-05T00:00:00.000Z' }),
        serviceRow('12', { createdAt: '2026-10-01T00:00:00.000Z' }),
      ]).getPublicServices();

      expect(result.map((service) => service.id)).toEqual(['11', '12', '10']);
    });
  });

  describe('public projection', () => {
    it('returns only documented public fields', async () => {
      const service = await createController([serviceRow('1')]).getPublicServiceById(
        '1',
      );

      expect(service).toEqual({
        id: '1',
        name: 'Service 1',
        description: 'Full grooming',
        price: '150000.00',
        durationMinutes: 60,
        category: { id: '2', name: 'Grooming', description: 'Coat care' },
        provider: {
          id: '1',
          businessName: 'Paw Spa',
          address: '1 Nguyen Hue, District 1',
          description: 'Grooming studio',
          ratingAvg: '4.50',
          ratingCount: 2,
        },
      });
    });

    it('never exposes internal fields or provider contact phone (list and detail)', async () => {
      const controller = createController([serviceRow('1')]);
      const serialized = JSON.stringify([
        ...(await controller.getPublicServices()),
        await controller.getPublicServiceById('1'),
      ]);

      for (const field of [
        'ownerId',
        'approvalStatus',
        'phone',
        'status',
        'providerId',
        'categoryId',
        'createdAt',
        'updatedAt',
      ]) {
        expect(serialized).not.toContain(`"${field}"`);
      }
    });
  });

  describe('input validation', () => {
    const pipe = new ParseBigIntIdPipe();

    it.each(['abc', '0', '-1', '1.5', '9223372036854775808'])(
      'rejects invalid id %p with 400',
      (id) => {
        expect(() => pipe.transform(id)).toThrow(BadRequestException);
      },
    );

    it('accepts a valid BIGINT id', () => {
      expect(pipe.transform('9223372036854775807')).toBe('9223372036854775807');
    });
  });

  describe('provider-owned service CRUD stays protected', () => {
    it('keeps JwtAuthGuard and RolesGuard on ServicesController', () => {
      expect(Reflect.getMetadata(GUARDS_METADATA, ServicesController)).toEqual([
        JwtAuthGuard,
        RolesGuard,
      ]);
    });

    it('requires PROVIDER_OWNER on every management handler', () => {
      const handlers = Object.getOwnPropertyNames(
        ServicesController.prototype,
      ).filter((name) => name !== 'constructor');

      expect(handlers.length).toBeGreaterThan(0);

      for (const handler of handlers) {
        const method = (
          ServicesController.prototype as unknown as Record<string, object>
        )[handler];

        expect(Reflect.getMetadata(ROLES_KEY, method)).toEqual([
          'PROVIDER_OWNER',
        ]);
      }
    });
  });
});
