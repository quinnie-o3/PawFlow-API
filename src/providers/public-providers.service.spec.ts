import { RequestMethod } from '@nestjs/common';
import {
  GUARDS_METADATA,
  METHOD_METADATA,
  MODULE_METADATA,
  PATH_METADATA,
} from '@nestjs/common/constants';
import type { DataSource } from 'typeorm';

import {
  captureQueries,
  type CapturedQuery,
  createOfflineDataSource,
} from '../../test/helpers/offline-query-capture';
import {
  PUBLIC_PROVIDER_SORTS,
  type PublicProviderSearchQueryDto,
} from './dto/public-provider-search-query.dto';
import { Provider } from './entities/provider.entity';
import { ProvidersModule } from './providers.module';
import { PublicProvidersController } from './public-providers.controller';
import { PublicProvidersService } from './public-providers.service';

const searchQuery = (
  overrides: Partial<PublicProviderSearchQueryDto> = {},
): PublicProviderSearchQueryDto =>
  ({ page: 1, limit: 20, sort: 'newest', ...overrides }) as PublicProviderSearchQueryDto;

/** Returns the value bound to `<fragment> $n` in a captured query. */
function boundTo(query: CapturedQuery, fragment: string): unknown {
  const escaped = fragment.replace(/[.*+?^${}()|[\]\\"]/g, '\\$&');
  const match = new RegExp(`${escaped} \\$(\\d+)`).exec(query.sql);

  if (!match) {
    throw new Error(`"${fragment} $n" not found in: ${query.sql}`);
  }

  return query.params[Number(match[1]) - 1];
}

/** The offer-summary subquery joined as `offers`. */
const offersSubquery = (query: CapturedQuery) =>
  /LEFT JOIN \((SELECT .*? GROUP BY "offer"\."provider_id")\) "offers"/.exec(
    query.sql,
  )![1];

/** The outer WHERE clause (after the joined subquery). */
const outerWhere = (query: CapturedQuery) =>
  query.sql
    .split(') "offers" ON offers.provider_id = "provider"."id" WHERE ')[1]
    .split(' ORDER BY ')[0];

const rawRow = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  businessName: `Provider ${id}`,
  address: '1 Nguyen Hue, District 1',
  description: null,
  ratingAvg: '4.50',
  ratingCount: 2,
  serviceCount: '3',
  minPrice: '100000.00',
  maxPrice: '300000.00',
  ...overrides,
});

describe('PublicProvidersService.searchPublicProviders', () => {
  let dataSource: DataSource;
  let capture: ReturnType<typeof captureQueries>;

  beforeAll(async () => {
    dataSource = await createOfflineDataSource();
  });

  afterEach(() => capture?.restore());

  async function search(
    overrides: Partial<PublicProviderSearchQueryDto> = {},
    result: Parameters<typeof captureQueries>[0] = {},
  ) {
    capture = captureQueries(result);
    const service = new PublicProvidersService(
      dataSource.getRepository(Provider),
    );

    return service.searchPublicProviders(searchQuery(overrides));
  }

  describe('public visibility', () => {
    it('only returns APPROVED providers', async () => {
      await search();

      for (const query of [capture.count(), capture.rows()]) {
        expect(boundTo(query, '"provider"."approval_status" =')).toBe(
          'APPROVED',
        );
      }
    });

    it('summarizes only ACTIVE services in ACTIVE categories', async () => {
      await search();

      const offers = offersSubquery(capture.rows());

      expect(offers).toContain('FROM "services" "offer"');
      expect(boundTo(capture.rows(), '"offer"."status" =')).toBe('ACTIVE');
      expect(boundTo(capture.rows(), '"offerCategory"."status" =')).toBe(
        'ACTIVE',
      );
    });

    it('only matches keywords against ACTIVE services in ACTIVE categories', async () => {
      await search({ q: 'groom' });

      const rows = capture.rows();

      expect(rows.sql).toContain(
        'EXISTS (SELECT 1 FROM "services" "keywordOffer0" INNER JOIN "service_categories" "keywordCategory0"',
      );
      expect(rows.sql).toContain('"keywordOffer0"."provider_id" = "provider"."id"');
      expect(boundTo(rows, '"keywordOffer0"."status" =')).toBe('ACTIVE');
      expect(boundTo(rows, '"keywordCategory0"."status" =')).toBe('ACTIVE');
    });

    it('counts with exactly the same joins and filters as the page query', async () => {
      await search({
        q: 'paw spa',
        categoryId: '2',
        minPrice: 1,
        maxPrice: 9,
        minRating: 4,
        location: 'District',
      });

      expect(outerWhere(capture.count())).toBe(outerWhere(capture.rows()));
      expect(offersSubquery(capture.count())).toBe(
        offersSubquery(capture.rows()),
      );
      expect(capture.count().params).toEqual(capture.rows().params);
    });

    it('selects only public columns and offer aggregates', async () => {
      await search();

      const selected = capture
        .rows()
        .sql.split(' FROM "providers"')[0]
        .match(/AS "(\w+)"/g);

      expect(selected).toEqual([
        'AS "id"',
        'AS "businessName"',
        'AS "address"',
        'AS "description"',
        'AS "ratingAvg"',
        'AS "ratingCount"',
        'AS "serviceCount"',
        'AS "minPrice"',
        'AS "maxPrice"',
      ]);
      expect(capture.rows().sql).not.toMatch(/owner_id|"phone"|password/);
    });
  });

  describe('keyword', () => {
    it('adds no keyword condition when q is absent', async () => {
      await search();

      expect(capture.rows().sql).not.toContain('ILIKE');
    });

    it('requires every term to match the provider or one of its public services', async () => {
      await search({ q: 'Paw groom' });

      const rows = capture.rows();

      expect(boundTo(rows, '("keywordOffer0"."name" ILIKE')).toBe('%Paw%');
      expect(boundTo(rows, '("keywordOffer1"."name" ILIKE')).toBe('%groom%');
      expect(rows.sql).toMatch(
        /\("provider"\."business_name" ILIKE \$(\d+) OR "provider"\."description" ILIKE \$\1 OR EXISTS \(.*"keywordOffer0"\."name" ILIKE \$\1 OR "keywordOffer0"\."description" ILIKE \$\1 OR "keywordCategory0"\."name" ILIKE \$\1\)\)\) AND \("provider"\."business_name" ILIKE/,
      );
    });

    it('binds hostile input as parameters and escapes LIKE wildcards', async () => {
      await search({ q: "'; DROP TABLE providers; -- 5_0%", location: "' OR 1=1 --" });

      for (const query of [capture.count(), capture.rows()]) {
        expect(query.sql).not.toMatch(/DROP|1=1|5_0/);
      }
      expect(capture.rows().params).toEqual(
        expect.arrayContaining([
          '%DROP%',
          String.raw`%5\_0\%%`,
          "%' OR 1=1 --%",
        ]),
      );
    });
  });

  describe('structured filters', () => {
    it('does not require a matching service when no service filter is given', async () => {
      await search({ minRating: 4, location: 'Quận 1' });

      const rows = capture.rows();

      expect(rows.sql).not.toContain('offers.provider_id IS NOT NULL');
      expect(boundTo(rows, '"provider"."rating_avg" >=')).toBe(4);
      expect(boundTo(rows, '"provider"."address" ILIKE')).toBe('%Quận 1%');
    });

    it.each([
      ['categoryId', { categoryId: '2' }, '"offer"."category_id" =', '2'],
      ['minPrice', { minPrice: 100 }, '"offer"."price" >=', 100],
      ['maxPrice', { maxPrice: 200 }, '"offer"."price" <=', 200],
    ] as const)(
      '%s keeps only providers with a matching public service',
      async (_name, filter, fragment, value) => {
        await search(filter);

        const rows = capture.rows();

        expect(boundTo(rows, fragment)).toBe(value);
        expect(offersSubquery(rows)).toContain(fragment);
        expect(outerWhere(rows)).toContain('offers.provider_id IS NOT NULL');
      },
    );

    it('applies category and price range to the same service', async () => {
      await search({ categoryId: '2', minPrice: 100, maxPrice: 200 });

      const offers = offersSubquery(capture.rows());

      expect(offers).toMatch(
        /"offer"\."category_id" = \$\d+ AND "offer"\."price" >= \$\d+ AND "offer"\."price" <= \$\d+ GROUP BY/,
      );
    });
  });

  describe('sorting', () => {
    it.each([
      ['newest', '"provider"."created_at" DESC, "provider"."id" DESC'],
      ['name_asc', 'LOWER("provider"."business_name") ASC, "provider"."id" ASC'],
      ['name_desc', 'LOWER("provider"."business_name") DESC, "provider"."id" ASC'],
      [
        'rating_desc',
        '"provider"."rating_avg" DESC, "provider"."rating_count" DESC, "provider"."id" ASC',
      ],
      ['price_asc', 'offers.min_price ASC NULLS LAST, "provider"."id" ASC'],
      ['price_desc', 'offers.min_price DESC NULLS LAST, "provider"."id" ASC'],
    ] as const)('sort=%s orders by %s with an ID tie-breaker', async (sort, expected) => {
      await search({ sort });

      expect(capture.rows().sql.split(' ORDER BY ')[1]).toBe(
        `${expected} LIMIT 20 OFFSET 0`,
      );
    });

    it('covers every whitelisted sort mode', () => {
      expect(PUBLIC_PROVIDER_SORTS).toEqual([
        'newest',
        'name_asc',
        'name_desc',
        'rating_desc',
        'price_asc',
        'price_desc',
      ]);
    });
  });

  describe('pagination and response', () => {
    it('applies LIMIT and OFFSET from page and limit', async () => {
      await search({ page: 4, limit: 5 });

      expect(capture.rows().sql).toMatch(/ LIMIT 5 OFFSET 15$/);
    });

    it('projects rows and normalizes aggregates', async () => {
      const result = await search(
        { page: 1, limit: 2 },
        {
          count: 3,
          rows: [
            rawRow('1', { ownerId: '9', phone: '0900', approvalStatus: 'APPROVED' }),
            rawRow('2', { serviceCount: null, minPrice: null, maxPrice: null }),
          ],
        },
      );

      expect(result.items).toEqual([
        {
          id: '1',
          businessName: 'Provider 1',
          address: '1 Nguyen Hue, District 1',
          description: null,
          ratingAvg: '4.50',
          ratingCount: 2,
          serviceCount: 3,
          minPrice: '100000.00',
          maxPrice: '300000.00',
        },
        {
          id: '2',
          businessName: 'Provider 2',
          address: '1 Nguyen Hue, District 1',
          description: null,
          ratingAvg: '4.50',
          ratingCount: 2,
          serviceCount: 0,
          minPrice: null,
          maxPrice: null,
        },
      ]);
      expect(JSON.stringify(result.items)).not.toMatch(
        /ownerId|phone|approvalStatus/,
      );
      expect(result.meta).toEqual({
        page: 1,
        limit: 2,
        totalItems: 3,
        totalPages: 2,
        hasNextPage: true,
        hasPreviousPage: false,
      });
    });

    it('echoes normalized filters, with null for absent ones', async () => {
      const result = await search({ location: 'Quận 1', sort: 'rating_desc' });

      expect(result.query).toEqual({
        q: null,
        categoryId: null,
        minPrice: null,
        maxPrice: null,
        minRating: null,
        location: 'Quận 1',
        sort: 'rating_desc',
      });
    });
  });
});

describe('PublicProvidersController', () => {
  it('maps GET /providers/public/search without guards', () => {
    const handler = PublicProvidersController.prototype.searchPublicProviders;

    expect(Reflect.getMetadata(PATH_METADATA, PublicProvidersController)).toBe(
      'providers/public',
    );
    expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe('search');
    expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(
      RequestMethod.GET,
    );
    expect(
      Reflect.getMetadata(GUARDS_METADATA, PublicProvidersController),
    ).toBeUndefined();
    expect(Reflect.getMetadata(GUARDS_METADATA, handler)).toBeUndefined();
  });

  it('is registered in ProvidersModule', () => {
    expect(
      Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, ProvidersModule),
    ).toContain(PublicProvidersController);
    expect(
      Reflect.getMetadata(MODULE_METADATA.PROVIDERS, ProvidersModule),
    ).toContain(PublicProvidersService);
  });
});
