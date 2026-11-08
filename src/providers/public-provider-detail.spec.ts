import { NotFoundException, RequestMethod } from '@nestjs/common';
import {
  GUARDS_METADATA,
  METHOD_METADATA,
  PATH_METADATA,
  ROUTE_ARGS_METADATA,
} from '@nestjs/common/constants';
import type { DataSource } from 'typeorm';

import {
  captureQueries,
  type CapturedQuery,
  createOfflineDataSource,
} from '../../test/helpers/offline-query-capture';
import { ParseBigIntIdPipe } from '../common/pipes/parse-bigint-id.pipe';
import type { PublicProviderSearchQueryDto } from './dto/public-provider-search-query.dto';
import { Provider } from './entities/provider.entity';
import { ProvidersController } from './providers.controller';
import { PublicProvidersController } from './public-providers.controller';
import { PublicProvidersService } from './public-providers.service';

/** Returns the value bound to `<fragment> $n` in a captured query. */
function boundTo(query: CapturedQuery, fragment: string): unknown {
  const escaped = fragment.replace(/[.*+?^${}()|[\]\\"]/g, '\\$&');
  const match = new RegExp(`${escaped} \\$(\\d+)`).exec(query.sql);

  if (!match) {
    throw new Error(`"${fragment} $n" not found in: ${query.sql}`);
  }

  return query.params[Number(match[1]) - 1];
}

const row = (overrides: Record<string, unknown> = {}) => ({
  id: '3',
  businessName: 'Paw Spa',
  address: '1 Nguyen Hue, District 1',
  description: 'Grooming and spa',
  ratingAvg: '4.50',
  ratingCount: 2,
  serviceCount: '4',
  minPrice: '100000.00',
  maxPrice: '350000.00',
  ...overrides,
});

describe('PublicProvidersService.getPublicProviderById', () => {
  let dataSource: DataSource;
  let capture: ReturnType<typeof captureQueries>;

  beforeAll(async () => {
    dataSource = await createOfflineDataSource();
  });

  afterEach(() => capture?.restore());

  function service() {
    return new PublicProvidersService(dataSource.getRepository(Provider));
  }

  async function detail(
    providerId: string,
    one: Record<string, unknown> | undefined,
  ) {
    capture = captureQueries({ one });

    return service().getPublicProviderById(providerId);
  }

  it('returns the public profile of an APPROVED provider in one query', async () => {
    await expect(detail('3', row())).resolves.toEqual({
      id: '3',
      businessName: 'Paw Spa',
      address: '1 Nguyen Hue, District 1',
      description: 'Grooming and spa',
      ratingAvg: '4.50',
      ratingCount: 2,
      serviceCount: 4,
      minPrice: '100000.00',
      maxPrice: '350000.00',
    });
    expect(capture.captured.map((query) => query.kind)).toEqual(['one']);
  });

  it('binds the provider ID and restricts to APPROVED providers', async () => {
    await detail('9223372036854775807', row());

    const one = capture.one();

    expect(boundTo(one, '"provider"."id" =')).toBe('9223372036854775807');
    expect(boundTo(one, '"provider"."approval_status" =')).toBe('APPROVED');
    expect(one.sql).not.toContain('9223372036854775807');
  });

  it('summarizes only ACTIVE services in ACTIVE categories, without search filters', async () => {
    await detail('3', row());

    const one = capture.one();

    expect(boundTo(one, '"offer"."status" =')).toBe('ACTIVE');
    expect(boundTo(one, '"offerCategory"."status" =')).toBe('ACTIVE');
    expect(one.sql).not.toMatch(
      /"offer"\."category_id" =|"offer"\."price" [<>]=|IS NOT NULL|ILIKE|ORDER BY|LIMIT/,
    );
  });

  it('selects only public columns', async () => {
    await detail('3', row());

    const selected = capture
      .one()
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
    expect(capture.one().sql).not.toMatch(/owner_id|"phone"|password|email/);
  });

  it('never copies internal fields into the response', async () => {
    const result = await detail(
      '3',
      row({ ownerId: '9', phone: '0900', approvalStatus: 'APPROVED', email: 'x@y.z' }),
    );

    expect(Object.keys(result)).toEqual([
      'id',
      'businessName',
      'address',
      'description',
      'ratingAvg',
      'ratingCount',
      'serviceCount',
      'minPrice',
      'maxPrice',
    ]);
  });

  it('reports a provider without public services as serviceCount 0 and null prices', async () => {
    await expect(
      detail('3', row({ serviceCount: null, minPrice: null, maxPrice: null })),
    ).resolves.toMatchObject({ serviceCount: 0, minPrice: null, maxPrice: null });
  });

  it('throws the same 404 for hidden and missing providers', async () => {
    const error = await detail('3', undefined).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(NotFoundException);
    expect((error as NotFoundException).getResponse()).toEqual({
      statusCode: 404,
      error: 'Not Found',
      message: 'Provider not found',
    });
  });

  it('uses the same visibility, offer summary and projection as an unfiltered search', async () => {
    await detail('3', row());
    const detailSql = capture.one().sql;
    capture.restore();

    capture = captureQueries({});
    await service().searchPublicProviders({
      page: 1,
      limit: 20,
      sort: 'newest',
    } as PublicProviderSearchQueryDto);
    const searchSql = capture.rows().sql;

    expect(detailSql).toBe(
      `${searchSql.split(' ORDER BY ')[0]} AND "provider"."id" = $3`,
    );
  });
});

describe('PublicProvidersController detail route', () => {
  const prototype = PublicProvidersController.prototype;

  it('maps GET /providers/public/:id without guards', () => {
    expect(Reflect.getMetadata(PATH_METADATA, prototype.getPublicProviderById)).toBe(
      ':id',
    );
    expect(
      Reflect.getMetadata(METHOD_METADATA, prototype.getPublicProviderById),
    ).toBe(RequestMethod.GET);
    expect(
      Reflect.getMetadata(GUARDS_METADATA, prototype.getPublicProviderById),
    ).toBeUndefined();
    expect(
      Reflect.getMetadata(GUARDS_METADATA, PublicProvidersController),
    ).toBeUndefined();
  });

  it('validates the ID with ParseBigIntIdPipe (400 for malformed IDs)', () => {
    const args = Reflect.getMetadata(
      ROUTE_ARGS_METADATA,
      PublicProvidersController,
      'getPublicProviderById',
    ) as Record<string, { data: string; pipes: unknown[] }>;

    expect(Object.values(args)).toEqual([
      expect.objectContaining({ data: 'id', pipes: [ParseBigIntIdPipe] }),
    ]);
  });

  it('is declared after search so "search" is not parsed as an ID', () => {
    const methods = Object.getOwnPropertyNames(prototype);

    expect(methods.indexOf('searchPublicProviders')).toBeLessThan(
      methods.indexOf('getPublicProviderById'),
    );
  });

  it('exposes only GET handlers', () => {
    const handlers = Object.getOwnPropertyNames(prototype).filter(
      (name) => name !== 'constructor',
    );

    expect(handlers.sort()).toEqual([
      'getPublicProviderById',
      'searchPublicProviders',
    ]);
    for (const handler of handlers) {
      expect(
        Reflect.getMetadata(
          METHOD_METADATA,
          (prototype as unknown as Record<string, object>)[handler],
        ),
      ).toBe(RequestMethod.GET);
    }
  });

  it('does not collide with authenticated ProvidersController routes', () => {
    const ownerPaths = Object.getOwnPropertyNames(ProvidersController.prototype)
      .filter((name) => name !== 'constructor')
      .map(
        (name) =>
          Reflect.getMetadata(
            PATH_METADATA,
            (ProvidersController.prototype as unknown as Record<string, object>)[
              name
            ],
          ) as string,
      );

    expect(ownerPaths).not.toContain(':id');
    expect(ownerPaths.some((path) => path.startsWith('public'))).toBe(false);
  });
});
