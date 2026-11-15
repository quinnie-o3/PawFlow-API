import {
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import type { DataSource } from 'typeorm';

import { ROLES_KEY } from '../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Booking } from '../bookings/entities/booking.entity';
import { ComplaintsController } from './complaints.controller';
import {
  ACTIVE_COMPLAINT_STATUSES,
  COMPLAINT_ELIGIBLE_BOOKING_STATUSES,
  ComplaintsService,
} from './complaints.service';
import { Complaint } from './entities/complaint.entity';

type BookingRow = Pick<Booking, 'id' | 'customerId' | 'status'>;

/** Reads the value list out of a TypeORM `In([...])` FindOperator. */
function operatorValues(value: unknown): unknown[] | null {
  if (value && typeof value === 'object' && 'value' in value) {
    return (value as { value: unknown[] }).value;
  }

  return null;
}

describe('ComplaintsService', () => {
  const customerId = '10';

  let bookings: Map<string, BookingRow>;
  let storedComplaints: Complaint[];
  let lockQueryBuilder: {
    setLock: jest.Mock;
    where: jest.Mock;
    getOne: jest.Mock;
  };
  let complaintsRepository: {
    create: jest.Mock;
    save: jest.Mock;
    find: jest.Mock;
    findOne: jest.Mock;
  };
  let transaction: jest.Mock;
  let service: ComplaintsService;

  const matches = (complaint: Complaint, where: Record<string, unknown>) =>
    Object.entries(where).every(([key, expected]) => {
      const actual = complaint[key as keyof Complaint];
      const values = operatorValues(expected);

      return values ? values.includes(actual) : actual === expected;
    });

  beforeEach(() => {
    bookings = new Map([
      ['20', { id: '20', customerId, status: 'COMPLETED' }],
      ['21', { id: '21', customerId, status: 'CONFIRMED' }],
    ]);
    storedComplaints = [];

    let requestedBookingId: string | undefined;
    lockQueryBuilder = {
      setLock: jest.fn().mockReturnThis(),
      where: jest.fn((_expression: string, params: { bookingId: string }) => {
        requestedBookingId = params.bookingId;
        return lockQueryBuilder;
      }),
      getOne: jest.fn(() =>
        Promise.resolve(
          requestedBookingId ? (bookings.get(requestedBookingId) ?? null) : null,
        ),
      ),
    };

    complaintsRepository = {
      create: jest.fn((value: Partial<Complaint>) => ({ ...value })),
      save: jest.fn((value: Complaint) => {
        const saved = { ...value, id: String(storedComplaints.length + 1) };
        storedComplaints.push(saved);
        return Promise.resolve(saved);
      }),
      find: jest.fn(({ where }: { where: Record<string, unknown> }) =>
        Promise.resolve(storedComplaints.filter((c) => matches(c, where))),
      ),
      findOne: jest.fn(({ where }: { where: Record<string, unknown> }) =>
        Promise.resolve(storedComplaints.find((c) => matches(c, where)) ?? null),
      ),
    };

    const repositories = new Map<unknown, unknown>([
      [Booking, { createQueryBuilder: jest.fn(() => lockQueryBuilder) }],
      [Complaint, complaintsRepository],
    ]);
    const manager = {
      getRepository: jest.fn((entity: unknown) => repositories.get(entity)),
    };

    // Emulates rollback: complaints saved inside a failed transaction vanish.
    transaction = jest.fn(async (work: (m: typeof manager) => Promise<unknown>) => {
      const snapshot = [...storedComplaints];

      try {
        return await work(manager);
      } catch (error) {
        storedComplaints = snapshot;
        throw error;
      }
    });

    service = new ComplaintsService({
      transaction,
      getRepository: manager.getRepository,
    } as unknown as DataSource);
  });

  const create = (bookingId = '20', reason = 'Late arrival') =>
    service.createComplaint(customerId, bookingId, { reason });

  describe('createComplaint transaction and lock (C-05 C)', () => {
    it('locks the booking row with pessimistic_write inside a transaction', async () => {
      await create();

      expect(transaction).toHaveBeenCalledTimes(1);
      expect(lockQueryBuilder.setLock).toHaveBeenCalledWith('pessimistic_write');
    });

    it('creates an OPEN complaint for the owner of the booking', async () => {
      await expect(create()).resolves.toMatchObject({
        bookingId: '20',
        createdBy: customerId,
        reason: 'Late arrival',
        status: 'OPEN',
        adminNote: null,
        resolvedBy: null,
        resolvedAt: null,
      });
    });

    it('rolls back when persisting fails', async () => {
      complaintsRepository.save.mockImplementationOnce((value: Complaint) => {
        storedComplaints.push({ ...value, id: '99' });
        return Promise.reject(new Error('insert failed'));
      });

      await expect(create()).rejects.toThrow('insert failed');
      expect(storedComplaints).toHaveLength(0);
    });
  });

  describe('booking eligibility (C-05 A)', () => {
    it('exposes the approved eligible states', () => {
      expect([...COMPLAINT_ELIGIBLE_BOOKING_STATUSES].sort()).toEqual(
        ['CANCELLED', 'COMPLETED', 'CONFIRMED', 'NO_SHOW', 'REJECTED'],
      );
    });

    it.each(['CONFIRMED', 'COMPLETED', 'CANCELLED', 'REJECTED', 'NO_SHOW'] as const)(
      'allows a complaint for a %s booking',
      async (status) => {
        bookings.set('20', { id: '20', customerId, status });

        await expect(create()).resolves.toMatchObject({ status: 'OPEN' });
      },
    );

    it('rejects a PENDING_CONFIRMATION booking with 409 and creates nothing', async () => {
      bookings.set('20', { id: '20', customerId, status: 'PENDING_CONFIRMATION' });

      await expect(create()).rejects.toBeInstanceOf(ConflictException);
      expect(complaintsRepository.save).not.toHaveBeenCalled();
    });
  });

  describe('one active complaint per booking (C-05 B)', () => {
    it('treats OPEN and IN_REVIEW as active', () => {
      expect([...ACTIVE_COMPLAINT_STATUSES]).toEqual(['OPEN', 'IN_REVIEW']);
    });

    it('rejects a second complaint while the first is OPEN', async () => {
      await create();

      await expect(create('20', 'Again')).rejects.toThrow(
        new ConflictException('An active complaint already exists for this booking'),
      );
      expect(storedComplaints).toHaveLength(1);
    });

    it('rejects a second complaint while the first is IN_REVIEW', async () => {
      const first = await create();
      storedComplaints[0] = { ...storedComplaints[0], status: 'IN_REVIEW', id: first.id };

      await expect(create('20', 'Again')).rejects.toBeInstanceOf(ConflictException);
    });

    it.each(['RESOLVED', 'REJECTED'] as const)(
      'allows a new complaint after the previous one is %s',
      async (status) => {
        await create();
        storedComplaints[0] = { ...storedComplaints[0], status };

        await expect(create('20', 'Follow-up')).resolves.toMatchObject({
          status: 'OPEN',
        });
        expect(storedComplaints).toHaveLength(2);
      },
    );

    it('keeps different bookings independent', async () => {
      await create('20');

      await expect(create('21')).resolves.toMatchObject({ bookingId: '21' });
    });
  });

  describe('ownership (C-01)', () => {
    it('hides another customer’s booking with the same 404 as a missing one', async () => {
      bookings.set('20', { id: '20', customerId: '99', status: 'COMPLETED' });

      await expect(create()).rejects.toThrow(new NotFoundException('Booking not found'));
      expect(complaintsRepository.save).not.toHaveBeenCalled();
    });

    it('returns 404 for a missing booking', async () => {
      await expect(create('404')).rejects.toThrow(
        new NotFoundException('Booking not found'),
      );
    });

    it('hides another customer’s complaint with the same 404 as a missing one', async () => {
      const created = await create();

      await expect(service.getMyComplaintById('99', created.id)).rejects.toThrow(
        new NotFoundException('Complaint not found'),
      );
      await expect(service.getMyComplaintById(customerId, '999')).rejects.toThrow(
        new NotFoundException('Complaint not found'),
      );
    });
  });

  describe('complaint queries (unchanged)', () => {
    it('lists only the caller’s complaints, newest first', async () => {
      await create();

      await expect(service.getMyComplaints(customerId)).resolves.toHaveLength(1);
      expect(complaintsRepository.find).toHaveBeenCalledWith({
        where: { createdBy: customerId },
        order: { createdAt: 'DESC' },
      });
      await expect(service.getMyComplaints('99')).resolves.toEqual([]);
    });

    it('returns the caller’s complaint by id', async () => {
      const created = await create();

      await expect(
        service.getMyComplaintById(customerId, created.id),
      ).resolves.toMatchObject({ id: created.id, reason: 'Late arrival' });
    });
  });

  describe('route protection', () => {
    it('applies JwtAuthGuard and RolesGuard to every complaint route', () => {
      expect(Reflect.getMetadata(GUARDS_METADATA, ComplaintsController)).toEqual([
        JwtAuthGuard,
        RolesGuard,
      ]);
    });

    it('restricts every handler to CUSTOMER', () => {
      const handlers = Object.getOwnPropertyNames(
        ComplaintsController.prototype,
      ).filter((name) => name !== 'constructor');

      for (const handler of handlers) {
        const method = (
          ComplaintsController.prototype as unknown as Record<string, object>
        )[handler];

        expect(Reflect.getMetadata(ROLES_KEY, method)).toEqual(['CUSTOMER']);
      }
    });
  });
});
