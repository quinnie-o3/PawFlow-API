import { BadRequestException, ValidationPipe } from '@nestjs/common';

import { PublicProviderSearchQueryDto } from '../../providers/dto/public-provider-search-query.dto';
import { PublicServiceSearchQueryDto } from '../../services/dto/public-service-search-query.dto';
import { GLOBAL_VALIDATION_PIPE_OPTIONS } from '../pipes/validation-pipe.options';

// Same options as the global ValidationPipe registered in main.ts.
const pipe = new ValidationPipe(GLOBAL_VALIDATION_PIPE_OPTIONS);

function query(metatype: new () => object, value: Record<string, unknown>) {
  return pipe.transform(value, { type: 'query', metatype }) as Promise<
    Record<string, unknown>
  >;
}

async function rejection(
  metatype: new () => object,
  value: Record<string, unknown>,
): Promise<{ message: string[] }> {
  try {
    await query(metatype, value);
  } catch (error) {
    expect(error).toBeInstanceOf(BadRequestException);
    return (error as BadRequestException).getResponse() as {
      message: string[];
    };
  }

  throw new Error(`Expected 400 for ${JSON.stringify(value)}`);
}

describe.each([
  ['PublicServiceSearchQueryDto', PublicServiceSearchQueryDto],
  ['PublicProviderSearchQueryDto', PublicProviderSearchQueryDto],
] as const)('%s', (_name, metatype) => {
  it('applies defaults when no parameter is given', async () => {
    const result = await query(metatype, {});

    expect(result).toMatchObject({ page: 1, limit: 20, sort: 'newest' });
    expect(result.q).toBeUndefined();
  });

  it('converts canonical numeric strings and keeps IDs as strings', async () => {
    const result = await query(metatype, {
      q: '  paw spa  ',
      categoryId: '12',
      minPrice: '100000',
      maxPrice: '250000.50',
      minRating: '4.5',
      location: '  District 1 ',
      page: '3',
      limit: '50',
      sort: 'name_asc',
    });

    expect(result).toMatchObject({
      q: 'paw spa',
      categoryId: '12',
      minPrice: 100000,
      maxPrice: 250000.5,
      minRating: 4.5,
      location: 'District 1',
      page: 3,
      limit: 50,
      sort: 'name_asc',
    });
  });

  it('treats blank q and location as absent (debounced empty input)', async () => {
    const result = await query(metatype, { q: '   ', location: '' });

    expect(result.q).toBeUndefined();
    expect(result.location).toBeUndefined();
  });

  it('accepts equal price bounds and zero', async () => {
    await expect(
      query(metatype, { minPrice: '0', maxPrice: '0' }),
    ).resolves.toMatchObject({ minPrice: 0, maxPrice: 0 });
  });

  it.each([
    ['unknown parameter', { foo: 'bar' }],
    ['page 0', { page: '0' }],
    ['page above 1000', { page: '1001' }],
    ['fractional page', { page: '1.5' }],
    ['non-numeric page', { page: 'abc' }],
    ['limit 0', { limit: '0' }],
    ['limit above 50', { limit: '51' }],
    ['exponent limit', { limit: '1e1' }],
    ['negative minPrice', { minPrice: '-1' }],
    ['minPrice with 3 decimals', { minPrice: '1.005' }],
    ['non-numeric maxPrice', { maxPrice: 'cheap' }],
    ['maxPrice above NUMERIC(12,2)', { maxPrice: '10000000000' }],
    ['minPrice greater than maxPrice', { minPrice: '300', maxPrice: '200' }],
    ['minRating above 5', { minRating: '5.5' }],
    ['negative minRating', { minRating: '-0.5' }],
    ['malformed categoryId', { categoryId: 'abc' }],
    ['zero categoryId', { categoryId: '0' }],
    ['categoryId above BIGINT', { categoryId: '9223372036854775808' }],
    ['unsupported sort', { sort: 'price' }],
    ['SQL in sort', { sort: 'name_asc; DROP TABLE services' }],
    ['repeated q parameter', { q: ['a', 'b'] }],
    ['q longer than 100 characters', { q: 'x'.repeat(101) }],
    ['q with more than 8 words', { q: 'a b c d e f g h i' }],
    ['location longer than 100 characters', { location: 'x'.repeat(101) }],
    ['NUL character in q (PostgreSQL rejects it)', { q: 'spa\u0000' }],
    ['NUL character in location', { location: '\u0000Quận 1' }],
  ])('rejects %s with 400', async (_case, value) => {
    await rejection(metatype, value);
  });

  it('reports every invalid parameter at once', async () => {
    const response = await rejection(metatype, {
      limit: '51',
      sort: 'bad',
      minPrice: '5',
      maxPrice: '1',
    });

    expect(response.message).toEqual(
      expect.arrayContaining([
        'limit must not be greater than 50',
        'maxPrice must be greater than or equal to minPrice',
        expect.stringContaining('sort must be one of the following values'),
      ]),
    );
  });
});

describe('PublicServiceSearchQueryDto.providerId', () => {
  it('accepts a BIGINT provider ID', async () => {
    await expect(
      query(PublicServiceSearchQueryDto, { providerId: '7' }),
    ).resolves.toMatchObject({ providerId: '7' });
  });

  it('rejects a malformed provider ID with 400', async () => {
    await rejection(PublicServiceSearchQueryDto, { providerId: '-7' });
  });

  it.each(['price_asc', 'price_desc', 'rating_desc', 'name_desc'])(
    'accepts sort=%s',
    async (sort) => {
      await expect(
        query(PublicServiceSearchQueryDto, { sort }),
      ).resolves.toMatchObject({ sort });
    },
  );
});

describe('PublicProviderSearchQueryDto', () => {
  it('does not accept providerId (provider search is not provider-scoped)', async () => {
    await rejection(PublicProviderSearchQueryDto, { providerId: '7' });
  });

  it.each(['price_asc', 'price_desc', 'rating_desc', 'name_desc'])(
    'accepts sort=%s',
    async (sort) => {
      await expect(
        query(PublicProviderSearchQueryDto, { sort }),
      ).resolves.toMatchObject({ sort });
    },
  );
});
