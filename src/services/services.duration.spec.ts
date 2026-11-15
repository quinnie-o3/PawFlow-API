import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import type { DataSource, Repository } from 'typeorm';

import {
  captureQueries,
  createOfflineDataSource,
} from '../../test/helpers/offline-query-capture';
import type { Provider } from '../providers/entities/provider.entity';
import type { ServiceCategory } from './entities/service-category.entity';
import { Service } from './entities/service.entity';
import { ServicesService } from './services.service';

// Monday 2026-11-02 14:05:30.250, server local time.
const NOW = new Date(2026, 10, 2, 14, 5, 30, 250);

/**
 * P2-08A: changing a service's duration must not leave active bookings on
 * slots shorter than the service. The booked-slot check is rendered as real
 * PostgreSQL SQL through an offline data source.
 */
describe('ServicesService.updateMyService duration (P2-08A)', () => {
  let dataSource: DataSource;
  let capture: ReturnType<typeof captureQueries>;
  let provider: Partial<Provider>;
  let serviceRow: Partial<Service>;
  let serviceLookups: Array<Record<string, unknown>>;
  let saved: Array<Partial<Service>>;
  let transactions: number;

  beforeAll(async () => {
    dataSource = await createOfflineDataSource();
  });

  beforeEach(() => {
    provider = { id: '1', ownerId: '10', approvalStatus: 'APPROVED' };
    serviceRow = {
      id: '5',
      providerId: '1',
      categoryId: '2',
      name: 'Bath',
      price: '150000.00',
      durationMinutes: 60,
      status: 'ACTIVE',
    };
    serviceLookups = [];
    saved = [];
    transactions = 0;
  });

  afterEach(() => capture?.restore());

  function update(dto: Record<string, unknown>, bookedShortSlots = 0) {
    capture = captureQueries({ count: bookedShortSlots });

    const lockedServices = {
      findOne: (options: { where: Record<string, string> }) => {
        serviceLookups.push(options);
        const { where } = options;

        return Promise.resolve(
          where.id === serviceRow.id && where.providerId === serviceRow.providerId
            ? { ...serviceRow }
            : null,
        );
      },
      save: (value: Partial<Service>) => {
        saved.push(value);
        return Promise.resolve(value);
      },
    };
    const servicesRepository = {
      manager: {
        transaction: (work: (manager: object) => Promise<unknown>) => {
          transactions += 1;
          return work({
            getRepository: (entity: unknown) =>
              entity === Service
                ? lockedServices
                : dataSource.getRepository(entity as never),
          });
        },
      },
    };

    const services = new ServicesService(
      servicesRepository as unknown as Repository<Service>,
      {
        findOne: () => Promise.resolve({ id: '2', status: 'ACTIVE' }),
      } as unknown as Repository<ServiceCategory>,
      {
        findOne: () => Promise.resolve(provider),
      } as unknown as Repository<Provider>,
    );

    return services.updateMyService('10', '5', dto, NOW);
  }

  it('locks the service row FOR UPDATE, scoped to the provider, inside a transaction', async () => {
    await update({ durationMinutes: 90 });

    expect(transactions).toBe(1);
    expect(serviceLookups).toEqual([
      { where: { id: '5', providerId: '1' }, lock: { mode: 'pessimistic_write' } },
    ]);
  });

  it('lengthens the service when no upcoming booked slot would become too short', async () => {
    await expect(update({ durationMinutes: 90 }, 0)).resolves.toMatchObject({
      durationMinutes: 90,
    });
    expect(saved).toHaveLength(1);
  });

  it('rejects lengthening with 409 when booked upcoming slots would become too short, and saves nothing', async () => {
    await expect(update({ durationMinutes: 90, name: 'Long bath' }, 2)).rejects.toThrow(
      new ConflictException(
        'durationMinutes cannot exceed the length of 2 upcoming slot(s) that already have active bookings',
      ),
    );
    expect(saved).toEqual([]);
  });

  it('checks only active bookings on slots of this service that have not ended, measured in seconds', async () => {
    await update({ durationMinutes: 90 });

    const query = capture.count();
    const bound = (fragment: string) => {
      const match = new RegExp(
        `${fragment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\$(\\d+)`,
      ).exec(query.sql);
      return match ? query.params[Number(match[1]) - 1] : undefined;
    };

    expect(bound('"slot"."service_id" =')).toBe('5');
    expect(query.sql).toMatch(
      /\("slot"\."slot_date" > \$(\d+) OR \("slot"\."slot_date" = \$\1 AND "slot"\."end_time" > \$(\d+)\)\)/,
    );
    expect(bound('"slot"."slot_date" >')).toBe('2026-11-02');
    expect(bound('"slot"."end_time" >')).toBe('14:05:30.250');
    expect(
      bound('EXTRACT(EPOCH FROM ("slot"."end_time" - "slot"."start_time")) <'),
    ).toBe(5400);
    expect(query.sql).toContain(
      'EXISTS (SELECT 1 FROM bookings booking WHERE booking.slot_id = "slot"."id" AND booking.status IN (',
    );
    expect(query.params).toEqual(
      expect.arrayContaining(['PENDING_CONFIRMATION', 'CONFIRMED']),
    );
    expect(query.params).not.toEqual(
      expect.arrayContaining(['CANCELLED']),
    );
  });

  it.each([
    ['shortening', { durationMinutes: 30 }],
    ['an unchanged duration', { durationMinutes: 60 }],
    ['a change without duration', { name: 'Renamed', price: 120000 }],
  ])('does not query booked slots for %s', async (_case, dto) => {
    await expect(update(dto, 5)).resolves.toBeDefined();
    expect(capture.captured).toEqual([]);
    expect(saved).toHaveLength(1);
  });

  it("returns 404 for another provider's service without checking slots", async () => {
    serviceRow.providerId = '99';

    await expect(update({ durationMinutes: 90 })).rejects.toThrow(
      new NotFoundException('Service not found'),
    );
    expect(capture.captured).toEqual([]);
  });

  it('keeps the provider lifecycle restriction (SUSPENDED -> 403 before any lock)', async () => {
    provider.approvalStatus = 'SUSPENDED';

    await expect(update({ durationMinutes: 90 })).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(transactions).toBe(0);
    expect(serviceLookups).toEqual([]);
  });
});
