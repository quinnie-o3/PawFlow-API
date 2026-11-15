import { RequestMethod } from '@nestjs/common';
import {
  GUARDS_METADATA,
  METHOD_METADATA,
  PATH_METADATA,
} from '@nestjs/common/constants';
import type { DataSource, Repository } from 'typeorm';

import {
  captureQueries,
  type CapturedQuery,
  createOfflineDataSource,
} from '../../test/helpers/offline-query-capture';
import { Provider } from '../providers/entities/provider.entity';
import {
  PUBLIC_SERVICE_SORTS,
  type PublicServiceSearchQueryDto,
} from './dto/public-service-search-query.dto';
import { ServiceCategory } from './entities/service-category.entity';
import { Service } from './entities/service.entity';
import { PublicServicesController } from './public-services.controller';
import { ServicesService } from './services.service';

const searchQuery = (
  overrides: Partial<PublicServiceSearchQueryDto> = {},
): PublicServiceSearchQueryDto =>
  ({ page: 1, limit: 20, sort: 'newest', ...overrides }) as PublicServiceSearchQueryDto;

/** Returns the value bound to `<fragment> $n` in a captured query. */
function boundTo(query: CapturedQuery, fragment: string): unknown {
  const escaped = fragment.replace(/[.*+?^${}()|[\]\\"]/g, '\\$&');
  const match = new RegExp(`${escaped} \\$(\\d+)`).exec(query.sql);

  if (!match) {
    throw new Error(`"${fragment} $n" not found in: ${query.sql}`);
  }

  return query.params[Number(match[1]) - 1];
}

const whereClause = (query: CapturedQuery) =>
  query.sql.split(' WHERE ')[1].split(' ORDER BY ')[0];

const orderClause = (query: CapturedQuery) =>
  query.sql.split(' ORDER BY ')[1];

// Raw row as PostgreSQL returns it, plus internal columns that must never
// leak even if a future change selects them.
const rawRow = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  name: `Service ${id}`,
  description: 'Bath and brush',
  price: '150000.00',
  durationMinutes: 60,
  categoryId: '2',
  categoryName: 'Grooming',
  categoryDescription: null,
  providerId: '3',
  providerBusinessName: 'Paw Spa',
  providerAddress: '1 Nguyen Hue, District 1',
  providerDescription: null,
  providerRatingAvg: '4.50',
  providerRatingCount: 2,
  ownerId: '99',
  phone: '0900000000',
  approvalStatus: 'APPROVED',
  status: 'ACTIVE',
  ...overrides,
});

describe('ServicesService.searchPublicServices', () => {
  let dataSource: DataSource;
  let capture: ReturnType<typeof captureQueries>;

  beforeAll(async () => {
    dataSource = await createOfflineDataSource();
  });

  afterEach(() => capture?.restore());

  async function search(
    overrides: Partial<PublicServiceSearchQueryDto> = {},
    result: Parameters<typeof captureQueries>[0] = {},
  ) {
    capture = captureQueries(result);
    const service = new ServicesService(
      dataSource.getRepository(Service),
      {} as Repository<ServiceCategory>,
      {} as Repository<Provider>,
    );

    return service.searchPublicServices(searchQuery(overrides));
  }

  describe('public visibility', () => {
    it('always restricts to ACTIVE services, APPROVED providers and ACTIVE categories', async () => {
      await search({ q: 'spa', categoryId: '2', minPrice: 1 });

      for (const query of [capture.count(), capture.rows()]) {
        expect(boundTo(query, '"service"."status" =')).toBe('ACTIVE');
        expect(boundTo(query, '"provider"."approval_status" =')).toBe(
          'APPROVED',
        );
        expect(boundTo(query, '"category"."status" =')).toBe('ACTIVE');
        expect(query.sql).toContain(
          'INNER JOIN "providers" "provider" ON "provider"."id"="service"."provider_id"',
        );
        expect(query.sql).toContain(
          'INNER JOIN "service_categories" "category" ON "category"."id"="service"."category_id"',
        );
      }
    });

    it('counts with exactly the same filters as the page query', async () => {
      await search({
        q: 'paw spa',
        categoryId: '2',
        providerId: '3',
        minPrice: 10,
        maxPrice: 20,
        minRating: 4,
        location: 'District',
      });

      expect(whereClause(capture.count())).toBe(whereClause(capture.rows()));
      expect(capture.count().params).toEqual(capture.rows().params);
    });

    it('selects only public columns', async () => {
      await search();

      const selected = capture
        .rows()
        .sql.split(' FROM ')[0]
        .match(/AS "(\w+)"/g);

      expect(selected).toEqual([
        'AS "id"',
        'AS "name"',
        'AS "description"',
        'AS "price"',
        'AS "durationMinutes"',
        'AS "providerId"',
        'AS "providerBusinessName"',
        'AS "providerAddress"',
        'AS "providerDescription"',
        'AS "providerRatingAvg"',
        'AS "providerRatingCount"',
        'AS "categoryId"',
        'AS "categoryName"',
        'AS "categoryDescription"',
      ]);
      expect(capture.rows().sql).not.toMatch(
        /owner_id|"phone"|approval_status" AS|password/,
      );
    });
  });

  describe('keyword', () => {
    it('adds no keyword condition when q is absent', async () => {
      await search();

      expect(capture.rows().sql).not.toContain('ILIKE');
      expect(capture.rows().params).toEqual(['ACTIVE', 'APPROVED', 'ACTIVE']);
    });

    it('requires every term to match name, description, category or business name (case-insensitive)', async () => {
      await search({ q: 'Paw groom' });

      const rows = capture.rows();

      expect(rows.params).toEqual(
        expect.arrayContaining(['%Paw%', '%groom%']),
      );
      expect(rows.sql).toContain(
        '("service"."name" ILIKE $4 OR "service"."description" ILIKE $4 OR "category"."name" ILIKE $4 OR "provider"."business_name" ILIKE $4) AND ("service"."name" ILIKE $5',
      );
      expect(rows.params[3]).toBe('%Paw%');
      expect(rows.params[4]).toBe('%groom%');
    });

    it('binds hostile input as parameters and escapes LIKE wildcards', async () => {
      await search({
        q: "'; DROP TABLE services; -- 100%",
        location: "x' OR '1'='1",
      });

      for (const query of [capture.count(), capture.rows()]) {
        expect(query.sql).not.toMatch(/DROP|'1'='1|100/);
      }
      expect(capture.rows().params).toEqual(
        expect.arrayContaining([
          "%';%",
          '%DROP%',
          String.raw`%100\%%`,
          "%x' OR '1'='1%",
        ]),
      );
    });
  });

  describe('structured filters', () => {
    it('binds category, provider, price range, rating and location', async () => {
      await search({
        categoryId: '2',
        providerId: '3',
        minPrice: 100000,
        maxPrice: 200000.5,
        minRating: 4.5,
        location: 'Quận 1',
      });

      const rows = capture.rows();

      expect(boundTo(rows, '"service"."category_id" =')).toBe('2');
      expect(boundTo(rows, '"service"."provider_id" =')).toBe('3');
      expect(boundTo(rows, '"service"."price" >=')).toBe(100000);
      expect(boundTo(rows, '"service"."price" <=')).toBe(200000.5);
      expect(boundTo(rows, '"provider"."rating_avg" >=')).toBe(4.5);
      expect(boundTo(rows, '"provider"."address" ILIKE')).toBe('%Quận 1%');
    });

    it('treats price bounds as inclusive', async () => {
      await search({ minPrice: 0, maxPrice: 0 });

      expect(capture.rows().sql).toContain('"service"."price" >= $4');
      expect(capture.rows().sql).toContain('"service"."price" <= $5');
    });
  });

  describe('sorting', () => {
    it.each([
      ['newest', '"service"."created_at" DESC, "service"."id" DESC'],
      ['name_asc', 'LOWER("service"."name") ASC, "service"."id" ASC'],
      ['name_desc', 'LOWER("service"."name") DESC, "service"."id" ASC'],
      ['price_asc', '"service"."price" ASC, "service"."id" ASC'],
      ['price_desc', '"service"."price" DESC, "service"."id" ASC'],
      [
        'rating_desc',
        '"provider"."rating_avg" DESC, "provider"."rating_count" DESC, "service"."id" ASC',
      ],
    ] as const)('sort=%s orders by %s with an ID tie-breaker', async (sort, expected) => {
      await search({ sort });

      expect(orderClause(capture.rows())).toBe(
        `${expected} LIMIT 20 OFFSET 0`,
      );
    });

    it('covers every whitelisted sort mode', () => {
      expect(PUBLIC_SERVICE_SORTS).toEqual([
        'newest',
        'name_asc',
        'name_desc',
        'price_asc',
        'price_desc',
        'rating_desc',
      ]);
    });
  });

  describe('pagination', () => {
    it('applies LIMIT and OFFSET from page and limit', async () => {
      await search({ page: 3, limit: 10 });

      expect(capture.rows().sql).toMatch(/ LIMIT 10 OFFSET 20$/);
    });

    it('starts at offset 0 on the first page', async () => {
      await search({ page: 1, limit: 50 });

      expect(capture.rows().sql).toMatch(/ LIMIT 50 OFFSET 0$/);
    });

    it('returns totals and navigation flags', async () => {
      const result = await search(
        { page: 2, limit: 2 },
        { count: 5, rows: [rawRow('3'), rawRow('4')] },
      );

      expect(result.meta).toEqual({
        page: 2,
        limit: 2,
        totalItems: 5,
        totalPages: 3,
        hasNextPage: true,
        hasPreviousPage: true,
      });
    });

    it('returns an empty page with accurate totals past the end', async () => {
      const result = await search({ page: 9, limit: 2 }, { count: 5, rows: [] });

      expect(result.items).toEqual([]);
      expect(result.meta).toMatchObject({ totalItems: 5, totalPages: 3 });
    });
  });

  describe('response', () => {
    it('projects rows to the public service shape only', async () => {
      const result = await search({}, { count: 1, rows: [rawRow('5')] });

      expect(result.items).toEqual([
        {
          id: '5',
          name: 'Service 5',
          description: 'Bath and brush',
          price: '150000.00',
          durationMinutes: 60,
          category: { id: '2', name: 'Grooming', description: null },
          provider: {
            id: '3',
            businessName: 'Paw Spa',
            address: '1 Nguyen Hue, District 1',
            description: null,
            ratingAvg: '4.50',
            ratingCount: 2,
          },
        },
      ]);
      expect(JSON.stringify(result)).not.toMatch(
        /ownerId|phone|approvalStatus|"status"|password/,
      );
    });

    it('echoes normalized filters, with null for absent ones', async () => {
      const result = await search({ q: 'spa', minPrice: 0, sort: 'price_asc' });

      expect(result.query).toEqual({
        q: 'spa',
        categoryId: null,
        providerId: null,
        minPrice: 0,
        maxPrice: null,
        minRating: null,
        location: null,
        sort: 'price_asc',
      });
    });
  });
});

describe('PublicServicesController search route', () => {
  const prototype = PublicServicesController.prototype;

  it('maps GET /services/public/search without guards', () => {
    expect(Reflect.getMetadata(PATH_METADATA, PublicServicesController)).toBe(
      'services/public',
    );
    expect(Reflect.getMetadata(PATH_METADATA, prototype.searchPublicServices)).toBe(
      'search',
    );
    expect(
      Reflect.getMetadata(METHOD_METADATA, prototype.searchPublicServices),
    ).toBe(RequestMethod.GET);
    expect(
      Reflect.getMetadata(GUARDS_METADATA, PublicServicesController),
    ).toBeUndefined();
    expect(
      Reflect.getMetadata(GUARDS_METADATA, prototype.searchPublicServices),
    ).toBeUndefined();
  });

  it('is declared before GET :id so "search" is not parsed as an ID', () => {
    const methods = Object.getOwnPropertyNames(prototype);

    expect(methods.indexOf('searchPublicServices')).toBeLessThan(
      methods.indexOf('getPublicServiceById'),
    );
  });

  it('keeps the existing list and detail routes unchanged', () => {
    expect(Reflect.getMetadata(PATH_METADATA, prototype.getPublicServices)).toBe(
      '/',
    );
    expect(
      Reflect.getMetadata(PATH_METADATA, prototype.getPublicServiceById),
    ).toBe(':id');
  });
});
