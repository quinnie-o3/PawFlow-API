import { NotFoundException } from '@nestjs/common';
import { DataSource, SelectQueryBuilder } from 'typeorm';

import {
  bookingEntityFixture,
  CUSTOMER_VIEW_OF_FIXTURE,
  PROVIDER_VIEW_OF_FIXTURE,
  STATUS_LOGS_OF_FIXTURE,
} from '../../test/helpers/booking-fixtures';
import { createOfflineDataSource } from '../../test/helpers/offline-query-capture';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { AvailabilitySlot } from '../availability/entities/availability-slot.entity';
import { ProviderStaff } from '../providers/entities/provider-staff.entity';
import { Provider } from '../providers/entities/provider.entity';
import {
  toCustomerBookingDetailView,
  toCustomerBookingView,
  toProviderBookingDetailView,
  toProviderBookingView,
} from './booking-views';
import { BookingsService } from './bookings.service';
import { BookingStatusLog } from './entities/booking-status-log.entity';
import { Booking } from './entities/booking.entity';

const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as unknown;
const CUSTOMER_RELATIONS = {
  pet: { petType: true },
  provider: true,
  service: true,
  slot: true,
};

describe('booking response projections (P2-08B)', () => {
  it('maps a fully loaded entity to the customer view only', () => {
    expect(json(toCustomerBookingView(bookingEntityFixture()))).toEqual(
      CUSTOMER_VIEW_OF_FIXTURE,
    );
  });

  it('maps a fully loaded entity to the provider view only', () => {
    expect(json(toProviderBookingView(bookingEntityFixture()))).toEqual(
      PROVIDER_VIEW_OF_FIXTURE,
    );
  });

  it('adds the status history oldest first, without changing the entity', () => {
    const booking = bookingEntityFixture();
    const order = booking.statusLogs.map((log) => log.id);

    expect(json(toCustomerBookingDetailView(booking))).toEqual({
      ...CUSTOMER_VIEW_OF_FIXTURE,
      statusLogs: STATUS_LOGS_OF_FIXTURE,
    });
    expect(json(toProviderBookingDetailView(booking))).toEqual({
      ...PROVIDER_VIEW_OF_FIXTURE,
      statusLogs: STATUS_LOGS_OF_FIXTURE,
    });
    expect(booking.statusLogs.map((log) => log.id)).toEqual(order);
  });

  it('never exposes columns it does not whitelist', () => {
    const booking = bookingEntityFixture({ payment: { id: '1', status: 'PAID' } });
    Object.assign(booking.slot, { internalNote: 'x' });
    Object.assign(booking.customer, { resetToken: 'secret' });

    expect(json(toCustomerBookingView(booking))).toEqual(CUSTOMER_VIEW_OF_FIXTURE);
    expect(json(toProviderBookingView(booking))).toEqual(PROVIDER_VIEW_OF_FIXTURE);
  });

  it('serializes BIGINT IDs as strings even if a driver returns numbers', () => {
    const booking = bookingEntityFixture({ id: 100 });
    Object.assign(booking.pet, { id: 8 });
    Object.assign(booking.customer, { id: 20 });

    expect(toCustomerBookingView(booking)).toMatchObject({ id: '100', pet: { id: '8' } });
    expect(toProviderBookingView(booking)).toMatchObject({ customer: { id: '20' } });
  });
});

/**
 * The service loads exactly the relations each view needs. Provider views
 * are built with a query builder whose SQL is rendered offline.
 */
describe('BookingsService view loading (P2-08B)', () => {
  let offline: DataSource;
  let rendered: Array<{ kind: string; sql: string; params: unknown[] }>;
  let viewResult: Booking | null;
  let events: string[];
  const owner = { id: '30', role: 'PROVIDER_OWNER' } as AuthenticatedUser;
  const staff = { id: '31', role: 'PROVIDER_STAFF' } as AuthenticatedUser;

  beforeAll(async () => {
    offline = await createOfflineDataSource();
  });

  beforeEach(() => {
    rendered = [];
    events = [];
    viewResult = bookingEntityFixture({ providerId: '3' });

    const capture = (kind: string) =>
      function (this: SelectQueryBuilder<Booking>) {
        const [sql, params] = this.getQueryAndParameters();
        rendered.push({ kind, sql, params });
        events.push(kind);

        if (kind === 'lock') {
          return Promise.resolve(
            this.expressionMap.mainAlias?.target === AvailabilitySlot
              ? { id: '12', bookedCount: 1, capacity: 2 }
              : { id: '100', customerId: '20', providerId: '3', slotId: '12', status: 'PENDING_CONFIRMATION' },
          );
        }

        return Promise.resolve(kind === 'many' ? [viewResult] : viewResult);
      };

    jest
      .spyOn(SelectQueryBuilder.prototype, 'getOne')
      .mockImplementation(function (this: SelectQueryBuilder<Booking>) {
        return capture(this.expressionMap.lockMode ? 'lock' : 'one').call(this);
      } as never);
    jest
      .spyOn(SelectQueryBuilder.prototype, 'getOneOrFail')
      .mockImplementation(capture('view') as never);
    jest
      .spyOn(SelectQueryBuilder.prototype, 'getMany')
      .mockImplementation(capture('many') as never);
  });

  afterEach(() => jest.restoreAllMocks());

  function createService(
    customerFind: { find?: jest.Mock; findOne?: jest.Mock; findOneOrFail?: jest.Mock } = {},
  ) {
    const getRepository = (entity: unknown) => {
      if (entity === Provider) {
        return { findOne: () => Promise.resolve({ id: '3', approvalStatus: 'APPROVED' }) };
      }

      if (entity === ProviderStaff) {
        return { findOne: () => Promise.resolve({ providerId: '3' }) };
      }

      const repository = offline.getRepository(entity as never);
      const save = (value: object) => {
        events.push(`save:${(entity as { name: string }).name}`);
        return Promise.resolve(value);
      };

      return Object.assign(Object.create(repository) as object, {
        save,
        create: (value: object) => value,
        ...(entity === Booking ? customerFind : {}),
      });
    };
    const manager = { getRepository };
    const dataSource = {
      manager,
      getRepository,
      transaction: (work: (m: object) => Promise<unknown>) => {
        events.push('begin');
        return work(manager).finally(() => events.push('end'));
      },
    };

    return new BookingsService(dataSource as unknown as DataSource);
  }

  const selected = (sql: string) =>
    sql.slice(0, sql.indexOf(' FROM ')).split(', ').map((column) => column.replace(/ AS .*/, ''));

  it.each([
    ['owner', owner],
    ['staff', staff],
  ])('provider list (%s): selects only the customer ID and full name', async (_label, user) => {
    await createService().getProviderBookings(user);

    const [query] = rendered;
    const customerColumns = selected(query.sql).filter((column) => column.startsWith('"customer"'));

    expect(customerColumns).toEqual(['"customer"."id"', '"customer"."full_name"']);
    expect(query.sql).not.toMatch(/password_hash|"customer"\."email"|"customer"\."phone"|"customer"\."role"/);
    expect(query.sql).toMatch(/INNER JOIN "pet_types" "petType"/);
    expect(query.sql).toMatch(/WHERE "booking"\."provider_id" = \$1/);
    expect(query.sql).toMatch(/ORDER BY "booking"\."created_at" DESC/);
    expect(query.params).toEqual(['3']);
  });

  it('provider detail adds the status history and keeps the ownership 404', async () => {
    const service = createService();

    await expect(service.getProviderBookingById(owner, '100')).resolves.toBe(viewResult);
    expect(rendered[0].sql).toMatch(/LEFT JOIN "booking_status_logs" "statusLog"/);
    expect(rendered[0].sql).not.toMatch(/password_hash/);

    viewResult = bookingEntityFixture({ providerId: '99' });
    await expect(service.getProviderBookingById(owner, '100')).rejects.toThrow(
      new NotFoundException('Booking not found'),
    );
  });

  it('customer list and detail load the customer view relations and no user', async () => {
    const find = jest.fn().mockResolvedValue([viewResult]);
    const findOne = jest.fn().mockResolvedValue(viewResult);
    const service = createService({ find, findOne });

    await service.getMyBookings('20');
    await service.getMyBookingById('20', '100');

    expect(find).toHaveBeenCalledWith({
      where: { customerId: '20' },
      relations: CUSTOMER_RELATIONS,
      order: { createdAt: 'DESC' },
    });
    expect(findOne).toHaveBeenCalledWith({
      where: { id: '100' },
      relations: { ...CUSTOMER_RELATIONS, statusLogs: true },
    });
  });

  it('customer detail keeps the ownership 404', async () => {
    const service = createService({
      findOne: jest.fn().mockResolvedValue(bookingEntityFixture({ customerId: '21' })),
    });

    await expect(service.getMyBookingById('20', '100')).rejects.toThrow(
      new NotFoundException('Booking not found'),
    );
  });

  it.each([
    ['confirm', (s: BookingsService) => s.confirmProviderBooking(owner, '100')],
    ['reject', (s: BookingsService) => s.rejectProviderBooking(staff, '100', { reason: 'Busy' })],
  ])('%s returns the provider view re-read inside its transaction, after the writes', async (_label, act) => {
    await expect(act(createService())).resolves.toBe(viewResult);

    const view = rendered.find((query) => query.kind === 'view')!;
    expect(view.sql).toMatch(/"customer"\."full_name"/);
    expect(view.sql).not.toMatch(/password_hash/);
    expect(view.params).toEqual(['100']);
    expect(events.indexOf('view')).toBeGreaterThan(events.lastIndexOf(`save:${BookingStatusLog.name}`));
    expect(events.indexOf('view')).toBeLessThan(events.indexOf('end'));
  });

  it('complete and no-show return the same re-read provider view', async () => {
    const service = createService();

    for (const act of [
      () => service.completeProviderBooking(owner, '100'),
      () => service.noShowProviderBooking(owner, '100'),
    ]) {
      viewResult = bookingEntityFixture({ providerId: '3' });
      rendered = [];
      // The lock stub answers PENDING_CONFIRMATION; transitions need CONFIRMED.
      jest.spyOn(SelectQueryBuilder.prototype, 'getOne').mockResolvedValueOnce(
        { id: '100', providerId: '3', status: 'CONFIRMED' } as never,
      );

      await expect(act()).resolves.toBe(viewResult);
      expect(rendered.filter((query) => query.kind === 'view')).toHaveLength(1);
    }
  });

  it('cancel returns the customer view re-read inside its transaction', async () => {
    const findOneOrFail = jest.fn(() => {
      events.push('customer-view');
      return Promise.resolve(viewResult);
    });

    await expect(
      createService({ findOneOrFail }).cancelMyBooking('20', '100', { reason: 'x' }),
    ).resolves.toBe(viewResult);
    expect(findOneOrFail).toHaveBeenCalledWith({
      where: { id: '100' },
      relations: CUSTOMER_RELATIONS,
    });
    expect(events.indexOf('customer-view')).toBeGreaterThan(
      events.lastIndexOf(`save:${BookingStatusLog.name}`),
    );
    expect(events.indexOf('customer-view')).toBeLessThan(events.indexOf('end'));
  });
});
