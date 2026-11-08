import { DataSource, SelectQueryBuilder } from 'typeorm';

import { AdminActivityLog } from '../../src/admin/entities/admin-activity-log.entity';
import { AvailabilitySlot } from '../../src/availability/entities/availability-slot.entity';
import { BookingStatusLog } from '../../src/bookings/entities/booking-status-log.entity';
import { Booking } from '../../src/bookings/entities/booking.entity';
import { Complaint } from '../../src/complaints/entities/complaint.entity';
import { Payment } from '../../src/payments/entities/payment.entity';
import { PetType } from '../../src/pets/entities/pet-type.entity';
import { Pet } from '../../src/pets/entities/pet.entity';
import { ProviderStaff } from '../../src/providers/entities/provider-staff.entity';
import { ProviderWorkingHour } from '../../src/providers/entities/provider-working-hour.entity';
import { Provider } from '../../src/providers/entities/provider.entity';
import { Review } from '../../src/reviews/entities/review.entity';
import { ServiceCategory } from '../../src/services/entities/service-category.entity';
import { Service } from '../../src/services/entities/service.entity';
import { User } from '../../src/users/entities/user.entity';

export interface CapturedQuery {
  kind: 'count' | 'rows' | 'one' | 'many';
  sql: string;
  params: unknown[];
}

/**
 * Builds TypeORM entity metadata for the real schema without opening a
 * database connection, so specs can render the exact PostgreSQL SQL and
 * bound parameters that query-builder code produces.
 */
export async function createOfflineDataSource(): Promise<DataSource> {
  const dataSource = new DataSource({
    type: 'postgres',
    entities: [
      AdminActivityLog,
      AvailabilitySlot,
      Booking,
      BookingStatusLog,
      Complaint,
      Payment,
      Pet,
      PetType,
      Provider,
      ProviderStaff,
      ProviderWorkingHour,
      Review,
      Service,
      ServiceCategory,
      User,
    ],
  });

  await (
    dataSource as unknown as { buildMetadatas(): Promise<void> }
  ).buildMetadatas();

  return dataSource;
}

/**
 * Intercepts `getCount` / `getRawMany` / `getRawOne` / `getMany` on every
 * SelectQueryBuilder: the rendered SQL and parameters are recorded and canned
 * results returned instead of executing anything. Call `restore()` after
 * each test.
 */
export function captureQueries(result: {
  count?: number;
  rows?: Array<Record<string, unknown>>;
  one?: Record<string, unknown>;
  entities?: object[];
}) {
  const captured: CapturedQuery[] = [];

  const record = (
    kind: CapturedQuery['kind'],
    builder: SelectQueryBuilder<any>,
  ) => {
    const [sql, params] = builder.getQueryAndParameters();
    captured.push({ kind, sql, params });
  };

  const countSpy = jest
    .spyOn(SelectQueryBuilder.prototype, 'getCount')
    .mockImplementation(function (this: SelectQueryBuilder<any>) {
      record('count', this);
      return Promise.resolve(result.count ?? 0);
    });
  const rowsSpy = jest
    .spyOn(SelectQueryBuilder.prototype, 'getRawMany')
    .mockImplementation(function (this: SelectQueryBuilder<any>) {
      record('rows', this);
      return Promise.resolve(result.rows ?? []);
    });
  const oneSpy = jest
    .spyOn(SelectQueryBuilder.prototype, 'getRawOne')
    .mockImplementation(function (this: SelectQueryBuilder<any>) {
      record('one', this);
      return Promise.resolve(result.one);
    });

  const manySpy = jest
    .spyOn(SelectQueryBuilder.prototype, 'getMany')
    .mockImplementation(function (this: SelectQueryBuilder<any>) {
      record('many', this);
      return Promise.resolve(result.entities ?? []);
    });

  return {
    captured,
    count: () => captured.find((query) => query.kind === 'count')!,
    rows: () => captured.find((query) => query.kind === 'rows')!,
    one: () => captured.find((query) => query.kind === 'one')!,
    many: () => captured.find((query) => query.kind === 'many')!,
    restore: () => {
      countSpy.mockRestore();
      rowsSpy.mockRestore();
      oneSpy.mockRestore();
      manySpy.mockRestore();
    },
  };
}
