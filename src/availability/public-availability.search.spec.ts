import {
  BadRequestException,
  RequestMethod,
  ValidationPipe,
} from '@nestjs/common';
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
import { GLOBAL_VALIDATION_PIPE_OPTIONS } from '../common/pipes/validation-pipe.options';
import { getCurrentTimeOfDayString } from '../common/utils/calendar-date.util';
import { Provider } from '../providers/entities/provider.entity';
import { Service } from '../services/entities/service.entity';
import { AvailabilityService } from './availability.service';
import { PublicAvailabilitySearchQueryDto } from './dto/public-availability-search-query.dto';
import { AvailabilitySlot } from './entities/availability-slot.entity';
import { PublicAvailabilityController } from './public-availability.controller';

// Same options as the global ValidationPipe registered in main.ts.
const pipe = new ValidationPipe(GLOBAL_VALIDATION_PIPE_OPTIONS);

function validate(value: Record<string, unknown>) {
  return pipe.transform(value, {
    type: 'query',
    metatype: PublicAvailabilitySearchQueryDto,
  }) as Promise<Record<string, unknown>>;
}

async function messages(value: Record<string, unknown>): Promise<string[]> {
  try {
    await validate(value);
  } catch (error) {
    expect(error).toBeInstanceOf(BadRequestException);
    return (
      (error as BadRequestException).getResponse() as { message: string[] }
    ).message;
  }

  throw new Error(`Expected 400 for ${JSON.stringify(value)}`);
}

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

describe('getCurrentTimeOfDayString', () => {
  it('formats the local time of day as zero-padded HH:mm', () => {
    expect(getCurrentTimeOfDayString(new Date(2026, 10, 2, 7, 5, 59))).toBe(
      '07:05',
    );
    expect(getCurrentTimeOfDayString(new Date(2026, 10, 2, 23, 59))).toBe(
      '23:59',
    );
  });
});

describe('PublicAvailabilitySearchQueryDto', () => {
  it('accepts a provider scope and applies pagination defaults', async () => {
    await expect(validate({ providerId: '3' })).resolves.toMatchObject({
      providerId: '3',
      page: 1,
      limit: 20,
    });
  });

  it('accepts a service scope, both scopes, an exact date or a range', async () => {
    await expect(validate({ serviceId: '5' })).resolves.toMatchObject({
      serviceId: '5',
    });
    await expect(
      validate({ providerId: '3', serviceId: '5', date: '2028-02-29' }),
    ).resolves.toMatchObject({ date: '2028-02-29' });
    await expect(
      validate({
        providerId: '3',
        fromDate: '2026-12-01',
        toDate: '2026-12-01',
        page: '2',
        limit: '50',
      }),
    ).resolves.toMatchObject({ fromDate: '2026-12-01', page: 2, limit: 50 });
    await expect(
      validate({ serviceId: '5', fromDate: '2026-12-01' }),
    ).resolves.toMatchObject({ fromDate: '2026-12-01' });
  });

  it('rejects an unscoped search', async () => {
    expect(await messages({})).toEqual([
      'providerId or serviceId must be provided',
    ]);
    expect(await messages({ date: '2026-12-01' })).toContain(
      'providerId or serviceId must be provided',
    );
  });

  it('rejects date combined with fromDate or toDate', async () => {
    expect(
      await messages({ providerId: '3', date: '2026-12-01', toDate: '2026-12-02' }),
    ).toEqual(['date cannot be combined with fromDate or toDate']);
    await messages({ providerId: '3', date: '2026-12-01', fromDate: '2026-12-01' });
  });

  it('rejects a reversed range', async () => {
    expect(
      await messages({ providerId: '3', fromDate: '2026-12-02', toDate: '2026-12-01' }),
    ).toEqual(['toDate must be the same as or later than fromDate']);
  });

  it.each([
    ['malformed providerId', { providerId: 'abc' }],
    ['zero providerId', { providerId: '0' }],
    ['negative serviceId', { serviceId: '-1' }],
    ['serviceId above BIGINT', { providerId: '3', serviceId: '9223372036854775808' }],
    ['empty providerId', { providerId: '' }],
    ['repeated providerId', { providerId: ['1', '2'] }],
    ['impossible date', { providerId: '3', date: '2027-02-29' }],
    ['date with time', { providerId: '3', date: '2026-12-01T10:00' }],
    ['non-padded date', { providerId: '3', date: '2026-1-01' }],
    ['impossible fromDate', { providerId: '3', fromDate: '2026-13-01' }],
    ['impossible toDate', { providerId: '3', toDate: '2026-04-31' }],
    ['empty date', { providerId: '3', date: '' }],
    ['page 0', { providerId: '3', page: '0' }],
    ['page above 1000', { providerId: '3', page: '1001' }],
    ['limit above 50', { providerId: '3', limit: '51' }],
    ['fractional limit', { providerId: '3', limit: '2.5' }],
    ['unknown parameter', { providerId: '3', sort: 'date' }],
  ])('rejects %s with 400', async (_case, value) => {
    await messages(value);
  });
});

describe('AvailabilityService.searchPublicSlots', () => {
  let dataSource: DataSource;
  let capture: ReturnType<typeof captureQueries>;
  // 2026-11-02 14:05 server local time.
  const now = new Date(2026, 10, 2, 14, 5, 30);

  beforeAll(async () => {
    dataSource = await createOfflineDataSource();
  });

  afterEach(() => capture?.restore());

  async function search(
    overrides: Partial<PublicAvailabilitySearchQueryDto> = {},
    result: Parameters<typeof captureQueries>[0] = {},
  ) {
    capture = captureQueries(result);
    const service = new AvailabilityService(
      dataSource.getRepository(AvailabilitySlot),
      {} as Repository<Provider>,
      {} as Repository<Service>,
    );

    return service.searchPublicSlots(
      {
        page: 1,
        limit: 20,
        ...overrides,
      } as PublicAvailabilitySearchQueryDto,
      now,
    );
  }

  it('applies public visibility and capacity rules to both queries', async () => {
    await search({ providerId: '3' });

    for (const query of [capture.count(), capture.many()]) {
      expect(boundTo(query, '"slot"."status" =')).toBe('OPEN');
      expect(query.sql).toContain('"slot"."booked_count" < "slot"."capacity"');
      expect(boundTo(query, '"provider"."approval_status" =')).toBe('APPROVED');
      expect(boundTo(query, '"service"."status" =')).toBe('ACTIVE');
      expect(boundTo(query, '"category"."status" =')).toBe('ACTIVE');
    }
  });

  it('hides past days and slots of today whose start is not strictly after now (P2-06B)', async () => {
    await search({ providerId: '3' });

    const many = capture.many();

    expect(many.sql).toMatch(
      /\("slot"\."slot_date" > \$(\d+) OR \("slot"\."slot_date" = \$\1 AND "slot"\."start_time" > \$(\d+)\)\)/,
    );
    expect(boundTo(many, '"slot"."slot_date" >')).toBe('2026-11-02');
    // Millisecond precision, compared as TIME (not as a string).
    expect(boundTo(many, '"slot"."start_time" >')).toBe('14:05:30.000');
  });

  it('requires the slot to last at least the service duration (P2-08A)', async () => {
    await search({ providerId: '3' });

    for (const query of [capture.count(), capture.many()]) {
      expect(query.sql).toContain(
        'EXTRACT(EPOCH FROM ("slot"."end_time" - "slot"."start_time")) >= "service"."duration_minutes" * 60',
      );
    }
  });

  it('requires the slot to fit one active working interval of its weekday (P2-06B)', async () => {
    await search({ providerId: '3' });

    for (const query of [capture.count(), capture.many()]) {
      expect(query.sql).toContain(
        'EXISTS (SELECT 1 FROM provider_working_hours working_hour WHERE working_hour.provider_id = "slot"."provider_id" AND working_hour.is_active = TRUE AND working_hour.day_of_week = EXTRACT(DOW FROM "slot"."slot_date") AND working_hour.start_time <= "slot"."start_time" AND working_hour.end_time >= "slot"."end_time")',
      );
    }
  });

  it('joins service and provider through the composite slot foreign key', async () => {
    await search({ providerId: '3', serviceId: '5' });

    expect(capture.many().sql).toContain(
      'INNER JOIN "services" "service" ON "service"."id"="slot"."service_id" AND "service"."provider_id"="slot"."provider_id"',
    );
  });

  it.each([
    ['providerId', { providerId: '3' }, '"slot"."provider_id" =', '3'],
    ['serviceId', { serviceId: '5' }, '"slot"."service_id" =', '5'],
    // "AND" distinguishes the filter from the visibility clause's "OR (slot_date = today".
    ['date', { providerId: '3', date: '2026-12-01' }, 'AND "slot"."slot_date" =', '2026-12-01'],
    ['fromDate', { providerId: '3', fromDate: '2026-12-01' }, '"slot"."slot_date" >=', '2026-12-01'],
    ['toDate', { providerId: '3', toDate: '2026-12-07' }, '"slot"."slot_date" <=', '2026-12-07'],
  ] as const)('binds %s as a parameter', async (_name, filter, fragment, value) => {
    await search(filter);

    expect(boundTo(capture.many(), fragment)).toBe(value);
    expect(capture.many().sql).not.toContain(`'${value}'`);
  });

  it('counts with exactly the same filters as the page query', async () => {
    await search({ providerId: '3', serviceId: '5', fromDate: '2026-12-01', toDate: '2026-12-07' });

    expect(whereClause(capture.count())).toBe(whereClause(capture.many()));
    expect(capture.count().params).toEqual(capture.many().params);
  });

  it('orders by date, start time, then ID and paginates in SQL', async () => {
    await search({ providerId: '3', page: 3, limit: 10 });

    expect(capture.many().sql.split(' ORDER BY ')[1]).toBe(
      '"slot"."slot_date" ASC, "slot"."start_time" ASC, "slot"."id" ASC LIMIT 10 OFFSET 20',
    );
  });

  it('projects entities with the existing public slot shape and echoes filters', async () => {
    const slot = {
      id: '12',
      providerId: '3',
      serviceId: '5',
      slotDate: '2026-12-01',
      startTime: '09:00:00',
      endTime: '10:00:00',
      capacity: 3,
      bookedCount: 1,
      status: 'OPEN',
      createdAt: new Date(),
      service: {
        id: '5',
        providerId: '3',
        categoryId: '1',
        name: 'Full grooming',
        description: null,
        price: '150000.00',
        durationMinutes: 60,
        status: 'ACTIVE',
        category: { id: '1', name: 'Grooming', description: null, status: 'ACTIVE' },
      },
      provider: {
        id: '3',
        ownerId: '99',
        businessName: 'Paw Spa',
        address: '1 Nguyen Hue',
        phone: '0900000000',
        description: null,
        approvalStatus: 'APPROVED',
        ratingAvg: '4.50',
        ratingCount: 2,
      },
    };

    const result = await search(
      { serviceId: '5', date: '2026-12-01' },
      { count: 1, entities: [slot] },
    );

    expect(result.items).toEqual([
      {
        id: '12',
        slotDate: '2026-12-01',
        startTime: '09:00:00',
        endTime: '10:00:00',
        capacity: 3,
        bookedCount: 1,
        service: {
          id: '5',
          name: 'Full grooming',
          description: null,
          price: '150000.00',
          durationMinutes: 60,
          category: { id: '1', name: 'Grooming', description: null },
        },
        provider: {
          id: '3',
          businessName: 'Paw Spa',
          address: '1 Nguyen Hue',
          description: null,
          ratingAvg: '4.50',
          ratingCount: 2,
        },
      },
    ]);
    expect(JSON.stringify(result.items)).not.toMatch(
      /ownerId|phone|approvalStatus|"status"|createdAt|"providerId"|"serviceId"|"categoryId"/,
    );
    expect(result.meta).toEqual({
      page: 1,
      limit: 20,
      totalItems: 1,
      totalPages: 1,
      hasNextPage: false,
      hasPreviousPage: false,
    });
    expect(result.query).toEqual({
      providerId: null,
      serviceId: '5',
      date: '2026-12-01',
      fromDate: null,
      toDate: null,
    });
  });
});

describe('PublicAvailabilityController search route', () => {
  const { prototype } = PublicAvailabilityController;

  it('maps GET /availability/public/search without guards', () => {
    expect(Reflect.getMetadata(PATH_METADATA, prototype.searchPublicSlots)).toBe(
      'search',
    );
    expect(Reflect.getMetadata(METHOD_METADATA, prototype.searchPublicSlots)).toBe(
      RequestMethod.GET,
    );
    expect(
      Reflect.getMetadata(GUARDS_METADATA, prototype.searchPublicSlots),
    ).toBeUndefined();
  });

  it('is declared before GET :id so "search" is not parsed as a slot ID', () => {
    const methods = Object.getOwnPropertyNames(prototype);

    expect(methods.indexOf('searchPublicSlots')).toBeLessThan(
      methods.indexOf('getPublicSlotById'),
    );
  });

  it('keeps the existing list and detail routes', () => {
    expect(Reflect.getMetadata(PATH_METADATA, prototype.getPublicSlots)).toBe('/');
    expect(Reflect.getMetadata(PATH_METADATA, prototype.getPublicSlotById)).toBe(
      ':id',
    );
  });
});
